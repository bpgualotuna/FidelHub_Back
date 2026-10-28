import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, MessageStatus, MessageType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { WhatsAppService, MetaTemplateDto } from '../whatsapp/whatsapp.service';
import { AiService } from '../ai/ai.service';
import { SettingsService } from '../settings/settings.service';
import { TemplatesService } from '../templates/templates.service';
import { ChatGateway } from '../chat/chat.gateway';
import { StorageService } from '../common/storage.service';
import { ensureWhatsAppCompatibleVideo, withMp4Extension, WHATSAPP_VIDEO_MAX_BYTES } from '../common/video-transcode.util';
import {
  classifyWhatsAppFailure,
  FAILURE_CATEGORY_FILTER_LABELS,
  type BroadcastFailureCategory,
} from '../common/whatsapp-error-catalog.util';

export type BroadcastMessageType = 'manual' | 'template' | 'ia';

const SEND_DELAY_MS = 350;
const CIRCUIT_BREAKER_CHECK_INTERVAL_MS = 5_000;
const CIRCUIT_BREAKER_WINDOW_MS = 3 * 60 * 1000;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 8;
const CIRCUIT_BREAKER_REASON =
  'Envío masivo detenido automáticamente: WhatsApp está rechazando mensajes por límite de spam. Los contactos restantes no fueron procesados.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BroadcastContact {
  id: string;
  contactId: string;
  phone: string;
  name?: string;
  canSend: boolean;
  windowSecondsRemaining: number;
  lastMessagePreview: string;
  lastMessageAt: number;
  isSandboxAuthorized: boolean;
}

export interface BroadcastTemplate {
  id: string;
  name: string;
  body: string;
  variables: string[];
  header?: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'; variables: string[] };
  buttons?: Array<{ index: number; type: string; text: string; url?: string; phoneNumber?: string; dynamic?: boolean }>;
}

interface SendBroadcastParams {
  organizationId: string;
  userId: string | null;
  conversationIds: string[];
  type: BroadcastMessageType;
  text: string;
  title?: string;
  templateId?: string;
  templateVariables?: Record<string, string>;
  templateAutoNameVariables?: string[];
  templateHeaderValue?: string;
  templateButtonVariables?: Record<string, string>;
}

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly whatsapp: WhatsAppService,
    private readonly ai: AiService,
    private readonly settings: SettingsService,
    private readonly templates: TemplatesService,
    private readonly gateway: ChatGateway,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  /** Sube el archivo elegido para el header de una plantilla oficial y retorna su URL pública. */
  async uploadTemplateHeaderMedia(
    organizationId: string,
    file: { originalname: string; buffer: Buffer; mimetype: string },
    templateId?: string,
  ): Promise<string> {
    const { buffer, mimetype, transcoded } = await ensureWhatsAppCompatibleVideo(file.buffer, file.mimetype);
    if (mimetype.startsWith('video/') && buffer.length > WHATSAPP_VIDEO_MAX_BYTES) {
      throw new BadRequestException(
        `El video pesa ${(buffer.length / 1024 / 1024).toFixed(1)}MB incluso tras comprimirlo; ` +
          'WhatsApp no permite enviar videos de más de 16MB. Probá con un archivo más corto o de menor resolución.',
      );
    }
    const originalname = transcoded ? withMp4Extension(file.originalname) : file.originalname;
    const timestamp = Date.now();
    const path = `broadcast/${organizationId}/${timestamp}_${originalname}`;
    const url = await this.storage.uploadFile('chat-media', path, buffer, mimetype);
    if (!url) throw new BadRequestException('No se pudo subir el archivo del encabezado');

    if (templateId) {
      await this.prisma.templateHeaderMedia.upsert({
        where: { organizationId_templateId: { organizationId, templateId } },
        create: { organizationId, templateId, mediaUrl: url, mimeType: mimetype, fileName: originalname },
        update: { mediaUrl: url, mimeType: mimetype, fileName: originalname },
      });
    }

    return url;
  }

  /** Devuelve el último archivo de header guardado para una plantilla, si existe. */
  async getTemplateHeaderMedia(
    organizationId: string,
    templateId: string,
  ): Promise<{ mediaUrl: string; mimeType: string; fileName: string | null } | null> {
    const saved = await this.prisma.templateHeaderMedia.findUnique({
      where: { organizationId_templateId: { organizationId, templateId } },
    });
    if (!saved) return null;
    return { mediaUrl: saved.mediaUrl, mimeType: saved.mimeType, fileName: saved.fileName };
  }

  /** Crea conversaciones para contactos que aún no tienen una, en un solo batch (evita N+1). */
  private async ensureConversationsExist(organizationId: string): Promise<void> {
    const missing = await this.prisma.contact.findMany({
      where: { organizationId, conversations: { none: {} } },
      select: { id: true },
    });
    if (missing.length > 0) {
      await this.prisma.conversation.createMany({
        data: missing.map((c) => ({ contactId: c.id })),
      });
    }
  }

  private matchesQuery(c: { phone: string; name?: string }, q?: string): boolean {
    if (!q?.trim()) return true;
    const needle = q.trim().toLowerCase();
    return c.phone.includes(q.trim()) || (c.name?.toLowerCase().includes(needle) ?? false);
  }

  /** ids de Contact que pertenecen a alguna de las campañas dadas. */
  private async getCampaignContactIdSet(organizationId: string, campaignIds?: string[]): Promise<Set<string> | null> {
    if (!campaignIds?.length) return null;
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId, campaignId: { in: campaignIds } },
      select: { id: true },
    });
    return new Set(contacts.map((c) => c.id));
  }

  private async getTagContactIdSet(organizationId: string, tagIds?: string[]): Promise<Set<string> | null> {
    if (!tagIds?.length) return null;
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId, tagId: { in: tagIds } },
      select: { id: true },
    });
    return new Set(contacts.map((c) => c.id));
  }

  private async getInterestContactIdSet(organizationId: string, interestStatus?: string): Promise<Set<string> | null> {
    if (!interestStatus) return null;
    const status = interestStatus === 'UNANSWERED' ? null : interestStatus;
    if (status !== null && status !== 'INTERESTED' && status !== 'NOT_INTERESTED') return null;
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId, interestStatus: status },
      select: { id: true },
    });
    return new Set(contacts.map((contact) => contact.id));
  }

  /**
   * Lista completa (sin paginar) de contactos de broadcast. Uso interno para envíos y validaciones.
   * `getContacts`/`getAllContactIds` la llaman en paralelo (una vez para la página, otra para los
   * ids totales) sobre la misma request de UI, y esta consulta recorre TODAS las conversaciones de
   * la organización — cachear la promesa por unos segundos evita recalcularla dos veces seguidas.
   */
  private allContactsCache = new Map<string, { promise: Promise<BroadcastContact[]>; expiresAt: number }>();
  private static readonly ALL_CONTACTS_CACHE_TTL_MS = 3000;

  async getAllContacts(organizationId: string, userId?: string, userRole?: string): Promise<BroadcastContact[]> {
    const cacheKey = `${organizationId}:${userId ?? ''}:${userRole ?? ''}`;
    const cached = this.allContactsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }

    const promise = this.loadAllContacts(organizationId, userId, userRole);
    this.allContactsCache.set(cacheKey, {
      promise,
      expiresAt: Date.now() + BroadcastService.ALL_CONTACTS_CACHE_TTL_MS,
    });
    promise.catch(() => this.allContactsCache.delete(cacheKey));
    return promise;
  }

  private async loadAllContacts(organizationId: string, userId?: string, userRole?: string): Promise<BroadcastContact[]> {
    await this.ensureConversationsExist(organizationId);
    const list = await this.chat.getConversationsWithWindowStatus(organizationId, userId, userRole);
    return list.map((c) => ({
      id: c.id,
      contactId: c.contactId!,
      phone: c.phone,
      name: c.name,
      canSend: c.canSend,
      windowSecondsRemaining: c.windowSecondsRemaining,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt,
      isSandboxAuthorized: c.isSandboxAuthorized ?? false,
    }));
  }

  async getContacts(
    organizationId: string,
    userId?: string,
    userRole?: string,
    filter?: { q?: string; campaignIds?: string[]; tagIds?: string[]; interestStatus?: string },
    cursor?: string,
    limit?: number,
  ): Promise<{ contacts: BroadcastContact[]; nextCursor: string | null; total: number }> {
    const [list, campaignContactIds, tagContactIds, interestContactIds] = await Promise.all([
      this.getAllContacts(organizationId, userId, userRole),
      this.getCampaignContactIdSet(organizationId, filter?.campaignIds),
      this.getTagContactIdSet(organizationId, filter?.tagIds),
      this.getInterestContactIdSet(organizationId, filter?.interestStatus),
    ]);
    const matching = list
      .filter((c) => this.matchesQuery(c, filter?.q))
      .filter((c) => !campaignContactIds || campaignContactIds.has(c.contactId))
      .filter((c) => !tagContactIds || tagContactIds.has(c.contactId))
      .filter((c) => !interestContactIds || interestContactIds.has(c.contactId));

    const take = limit && limit > 0 ? Math.min(limit, 200) : 50;
    let startIndex = 0;
    if (cursor) {
      const idx = matching.findIndex((c) => c.id === cursor);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    const page = matching.slice(startIndex, startIndex + take);
    const nextCursor = startIndex + take < matching.length ? page[page.length - 1]?.id ?? null : null;

    return { contacts: page, nextCursor, total: matching.length };
  }

  async getAllContactIds(
    organizationId: string,
    userId?: string,
    userRole?: string,
    filter?: { q?: string; onlyCanSend?: boolean; campaignIds?: string[]; tagIds?: string[]; interestStatus?: string },
  ): Promise<string[]> {
    const [list, campaignContactIds, tagContactIds, interestContactIds] = await Promise.all([
      this.getAllContacts(organizationId, userId, userRole),
      this.getCampaignContactIdSet(organizationId, filter?.campaignIds),
      this.getTagContactIdSet(organizationId, filter?.tagIds),
      this.getInterestContactIdSet(organizationId, filter?.interestStatus),
    ]);
    return list
      .filter((c) => this.matchesQuery(c, filter?.q))
      .filter((c) => !filter?.onlyCanSend || c.canSend)
      .filter((c) => !campaignContactIds || campaignContactIds.has(c.contactId))
      .filter((c) => !tagContactIds || tagContactIds.has(c.contactId))
      .filter((c) => !interestContactIds || interestContactIds.has(c.contactId))
      .map((c) => c.id);
  }

  /** Para cada campaña dada, ids de conversación (broadcast) de sus contactos. */
  async getCampaignConversationMap(
    organizationId: string,
    campaignIds: string[],
    userId?: string,
    userRole?: string,
  ): Promise<Record<string, string[]>> {
    if (!campaignIds.length) return {};
    const [contacts, list] = await Promise.all([
      this.prisma.contact.findMany({
        where: { organizationId, campaignId: { in: campaignIds } },
        select: { id: true, campaignId: true },
      }),
      this.getAllContacts(organizationId, userId, userRole),
    ]);
    const contactToCampaign = new Map(contacts.map((c) => [c.id, c.campaignId!]));
    const byCampaign: Record<string, string[]> = {};
    for (const conv of list) {
      const campaignId = contactToCampaign.get(conv.contactId);
      if (!campaignId) continue;
      (byCampaign[campaignId] ??= []).push(conv.id);
    }
    return byCampaign;
  }

  async getTemplates(organizationId: string): Promise<BroadcastTemplate[]> {
    const meta = await this.whatsapp.getMessageTemplates(organizationId);
    if (meta.length > 0) {
      return meta.map((t) => ({
        id: t.id,
        name: t.name,
        body: t.body,
        variables: t.variables,
        header: t.header ? { format: t.header.format, variables: t.header.variables } : undefined,
        buttons: t.buttons,
      }));
    }
    const list = await this.templates.findAll(organizationId);
    return list.map((t) => ({ id: t.id, name: t.name, body: t.body, variables: t.variables }));
  }

  async generateMessage(organizationId: string, instruction: string) {
    if (!instruction?.trim()) {
      throw new BadRequestException('La instrucción no puede estar vacía');
    }
    return this.ai.generateFromInstruction(organizationId, instruction.trim());
  }

  async sendBroadcast(params: SendBroadcastParams): Promise<{ started: true; total: number }> {
    const { organizationId, userId, conversationIds, type, text } = params;
    if (!conversationIds?.length) {
      throw new BadRequestException('Selecciona al menos un contacto');
    }
    if (!text?.trim() && type !== 'template') {
      throw new BadRequestException('El mensaje no puede estar vacío');
    }

    const isMetaTemplate = type === 'template' && params.templateId?.startsWith('meta_');
    let messageToSend = '';
    let metaTemplateName = '';
    let metaTemplateLanguage = '';
    let metaT: MetaTemplateDto | null = null;
    if (type === 'template' && params.templateId) {
      if (isMetaTemplate) {
        const metaList = await this.whatsapp.getMessageTemplates(organizationId);
        metaT = metaList.find((t) => t.id === params.templateId) ?? null;
        if (!metaT) throw new BadRequestException('Plantilla de Meta no encontrada');
        const parsed = this.parseMetaTemplateId(params.templateId);
        if (!parsed) throw new BadRequestException('ID de plantilla Meta inválido');
        metaTemplateName = parsed.name;
        metaTemplateLanguage = parsed.language;
        if (metaT.header && metaT.header.format !== 'TEXT' && !params.templateHeaderValue?.trim()) {
          throw new BadRequestException(
            `Esta plantilla requiere un archivo de ${metaT.header.format.toLowerCase()} para el encabezado`,
          );
        }
      } else {
        messageToSend = await this.resolveTemplateBody(organizationId, params.templateId, params.templateVariables);
      }
    } else if (type !== 'template') {
      messageToSend = text.trim();
    }

    if (!isMetaTemplate && type === 'template' && !messageToSend) {
      throw new BadRequestException('El mensaje resultante está vacío');
    }
    if (type !== 'template' && !messageToSend) {
      throw new BadRequestException('El mensaje no puede estar vacío');
    }

    const contacts = await this.getAllContacts(organizationId);
    const idSet = new Set(contacts.map((c) => c.id));
    const validIds = conversationIds.filter((id) => idSet.has(id));
    if (validIds.length === 0) {
      throw new BadRequestException('Ningún contacto válido seleccionado');
    }

    const contactMap = new Map(contacts.map((c) => [c.id, c]));

    // Trae el tier de mensajería real de Meta antes de un envío masivo: el valor cacheado en BD
    // solo se actualiza cuando alguien sincroniza manualmente y puede quedar desactualizado,
    // dejando pasar envíos que Meta ya no permite (ver checkDailyLimitOrThrow más abajo).
    if (validIds.length > 1) {
      try {
        await this.whatsapp.syncMessagingLimit(organizationId);
      } catch {
        // No bloquea el envío si Meta no responde; se sigue usando el tier cacheado.
      }
    }

    this.gateway.emitBroadcastStarted(organizationId, validIds.length);

    // Un ID por cada click de "Lanzar Masivos": agrupa todas las filas de BroadcastLog de este
    // envío para poder mostrarlo como una sola fila en "Masivos Enviados".
    const runId = randomUUID();

    // El envío en sí puede tardar varios minutos con listas grandes (throttling + límites de Meta).
    // No se espera acá: se dispara en segundo plano y el resultado final viaja por WebSocket
    // (broadcast_completed), para no dejar la petición HTTP colgada todo ese tiempo.
    this.runBroadcastLoop({
      organizationId,
      userId,
      runId,
      type,
      validIds,
      contactMap,
      isMetaTemplate,
      metaT,
      metaTemplateName,
      metaTemplateLanguage,
      messageToSend,
      params,
    }).catch((err) => {
      this.logger.error('Error inesperado en el envío masivo en segundo plano', err);
    });

    return { started: true, total: validIds.length };
  }

  private async runBroadcastLoop(ctx: {
    organizationId: string;
    userId: string | null;
    runId: string;
    type: BroadcastMessageType;
    validIds: string[];
    contactMap: Map<string, BroadcastContact>;
    isMetaTemplate: boolean | undefined;
    metaT: MetaTemplateDto | null;
    metaTemplateName: string;
    metaTemplateLanguage: string;
    messageToSend: string;
    params: SendBroadcastParams;
  }): Promise<void> {
    const {
      organizationId,
      userId,
      runId,
      type,
      validIds,
      contactMap,
      isMetaTemplate,
      metaT,
      metaTemplateName,
      metaTemplateLanguage,
      messageToSend,
      params,
    } = ctx;

    let sent = 0;
    let failed = 0;
    const errors: Array<{ conversationId: string; error: string }> = [];

    const isSandbox = this.config.get<string>('WHATSAPP_SANDBOX', 'true') === 'true';

    let circuitOpen = false;
    let lastCircuitCheckAt = 0;

    for (let i = 0; i < validIds.length; i++) {
      const conversationId = validIds[i];
      const contact = contactMap.get(conversationId)!;

      if (!circuitOpen && Date.now() - lastCircuitCheckAt > CIRCUIT_BREAKER_CHECK_INTERVAL_MS) {
        lastCircuitCheckAt = Date.now();
        const recentFailures = await this.recentSpamFailureCount(organizationId);
        if (recentFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
          circuitOpen = true;
        }
      }

      if (circuitOpen) {
        await this.logBroadcast(organizationId, userId, runId, conversationId, type, 'failed', CIRCUIT_BREAKER_REASON, undefined, params.title);
        this.gateway.emitBroadcastMessageFailed(organizationId, conversationId, i, CIRCUIT_BREAKER_REASON);
        this.emitCategorizedFailure(organizationId, conversationId, contact, CIRCUIT_BREAKER_REASON);
        failed++;
        errors.push({ conversationId, error: CIRCUIT_BREAKER_REASON });
        continue;
      }

      if (isSandbox && !contact.isSandboxAuthorized) {
        await this.logBroadcast(organizationId, userId, runId, conversationId, type, 'failed', 'Número no autorizado en Meta (sandbox)', undefined, params.title);
        this.gateway.emitBroadcastMessageFailed(
          organizationId,
          conversationId,
          i,
          'Número no autorizado en Meta (sandbox)',
        );
        this.emitCategorizedFailure(organizationId, conversationId, contact, 'Número no autorizado en Meta (sandbox)');
        failed++;
        errors.push({ conversationId, error: 'Número no autorizado en Meta (sandbox)' });
        continue;
      }

      if (type === 'manual' || type === 'ia' || (type === 'template' && !isMetaTemplate)) {
        if (!contact.canSend) {
          await this.logBroadcast(organizationId, userId, runId, conversationId, type, 'failed', 'Fuera de ventana de 24 horas', undefined, params.title);
          this.gateway.emitBroadcastMessageFailed(organizationId, conversationId, i, 'Fuera de ventana de 24 horas');
          this.emitCategorizedFailure(organizationId, conversationId, contact, 'Fuera de ventana de 24 horas');
          failed++;
          errors.push({ conversationId, error: 'Fuera de ventana de 24 horas' });
          continue;
        }
      }

      try {
        let sentMessageId: string;
        if (type === 'template') {
          if (isMetaTemplate && metaT) {
            const bodyVariables = this.resolveMetaBodyVariables(
              metaT,
              params.templateVariables,
              params.templateAutoNameVariables,
              contact.name,
            );
            const components = this.buildMetaTemplateComponents(
              metaT,
              bodyVariables,
              params.templateHeaderValue,
              params.templateButtonVariables,
            );
            let bodyTextForChat = metaT.body;
            metaT.variables.forEach((v) => {
              bodyTextForChat = bodyTextForChat.replace(
                new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`, 'g'),
                bodyVariables[v] ?? '',
              );
            });
            const headerMedia =
              metaT.header && metaT.header.format !== 'TEXT' && params.templateHeaderValue
                ? { type: metaT.header.format as MessageType, mediaUrl: params.templateHeaderValue }
                : undefined;
            const result = await this.sendMetaTemplateToConversation(
              organizationId,
              userId,
              conversationId,
              metaTemplateName,
              metaTemplateLanguage,
              components,
              bodyTextForChat,
              headerMedia,
            );
            sentMessageId = result.messageId;
          } else {
            const result = await this.sendTemplateToConversation(organizationId, userId, conversationId, messageToSend);
            sentMessageId = result.messageId;
          }
        } else {
          const msg = await this.chat.sendMessage({
            organizationId,
            conversationId,
            text: messageToSend,
            fromAi: type === 'ia',
            sentByUserId: userId,
          });
          sentMessageId = msg.id;
        }
        await this.logBroadcast(organizationId, userId, runId, conversationId, type, 'sent', undefined, sentMessageId, params.title);
        this.gateway.emitBroadcastMessageSent(organizationId, conversationId, i);
        sent++;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.logBroadcast(organizationId, userId, runId, conversationId, type, 'failed', errorMessage, undefined, params.title);
        this.gateway.emitBroadcastMessageFailed(organizationId, conversationId, i, errorMessage);
        this.emitCategorizedFailure(organizationId, conversationId, contact, errorMessage);
        failed++;
        errors.push({ conversationId, error: errorMessage });
      }

      if (i < validIds.length - 1) {
        await sleep(SEND_DELAY_MS);
      }
    }

    this.gateway.emitBroadcastCompleted(organizationId, { sent, failed, errors });
  }

  /** Cuenta mensajes salientes rechazados específicamente por límite de spam (código 131048/131049
   * de Meta, vía webhook de estado) en la ventana reciente, para frenar un envío masivo si Meta ya
   * está bloqueando por spam antes de quemar el resto de la lista. Solo cuenta esa categoría —no
   * cualquier FAILED— para que una ráfaga de fallos por otra causa (ej. un archivo de media
   * incompatible) no se frene y se etiquete como "spam" sin serlo. */
  private async recentSpamFailureCount(organizationId: string): Promise<number> {
    const since = new Date(Date.now() - CIRCUIT_BREAKER_WINDOW_MS);
    return this.prisma.message.count({
      where: {
        direction: MessageDirection.OUT,
        status: MessageStatus.FAILED,
        errorCategory: 'SPAM_BLOCKED' satisfies BroadcastFailureCategory,
        whatsappTimestamp: { gte: since },
        conversation: { contact: { organizationId } },
      },
    });
  }

  /** Alimenta el sistema global de toasts por categoría (BroadcastProgressProvider en el frontend). */
  private emitCategorizedFailure(
    organizationId: string,
    conversationId: string,
    contact: { phone: string; name?: string },
    detail: string,
  ): void {
    const { category, label } = classifyWhatsAppFailure({ message: detail });
    this.gateway.emitMessageDeliveryFailed(organizationId, {
      conversationId,
      contactPhone: contact.phone,
      contactName: contact.name ?? null,
      category,
      label,
      detail,
    });
  }

  private parseMetaTemplateId(id: string): { name: string; language: string } | null {
    if (!id.startsWith('meta_')) return null;
    const parts = id.slice(5).split('_');
    if (parts.length < 2) return null;
    if (parts.length >= 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length === 2) {
      return {
        language: parts.slice(-2).join('_'),
        name: parts.slice(0, -2).join('_'),
      };
    }
    return {
      language: parts[parts.length - 1],
      name: parts.slice(0, -1).join('_'),
    };
  }

  private async resolveTemplateBody(
    organizationId: string,
    templateId: string,
    variables?: Record<string, string>,
  ): Promise<string> {
    const t = await this.templates.findOne(organizationId, templateId);
    if (!t) return '';
    let body = t.body;
    (t.variables || []).forEach((key) => {
      const value = variables?.[key] ?? `{{${key}}}`;
      body = body.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
    });
    return body;
  }

  /** Resuelve el valor de cada variable del body: fijo (mismo para todos) o el nombre del contacto (por contacto). */
  private resolveMetaBodyVariables(
    metaT: MetaTemplateDto,
    fixedVariables: Record<string, string> | undefined,
    autoNameVariables: string[] | undefined,
    contactName: string | undefined,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const v of metaT.variables) {
      result[v] = autoNameVariables?.includes(v)
        ? contactName?.trim() || ''
        : fixedVariables?.[v] ?? '';
    }
    return result;
  }

  /** Arma los componentes (header/body/buttons) para el envío de una plantilla oficial de Meta. */
  private buildMetaTemplateComponents(
    metaT: MetaTemplateDto,
    bodyVariables: Record<string, string> | undefined,
    headerValue: string | undefined,
    buttonVariables: Record<string, string> | undefined,
  ): Array<Record<string, unknown>> {
    const components: Array<Record<string, unknown>> = [];
    const toParam = (name: string, value: string) =>
      /^\d+$/.test(name)
        ? { type: 'text', text: value }
        : { type: 'text', parameter_name: name, text: value };

    if (metaT.header) {
      if (metaT.header.format === 'TEXT') {
        if (metaT.header.variables.length > 0) {
          components.push({
            type: 'header',
            parameters: metaT.header.variables.map((v) => toParam(v, headerValue ?? '')),
          });
        }
      } else {
        if (!headerValue?.trim()) {
          throw new BadRequestException(
            `Esta plantilla requiere una URL de ${metaT.header.format.toLowerCase()} para el encabezado`,
          );
        }
        const key = metaT.header.format.toLowerCase();
        components.push({
          type: 'header',
          parameters: [{ type: key, [key]: { link: headerValue.trim() } }],
        });
      }
    }

    if (metaT.variables.length > 0) {
      components.push({
        type: 'body',
        parameters: metaT.variables.map((v) => toParam(v, bodyVariables?.[v] ?? '')),
      });
    }

    if (metaT.buttons?.length) {
      for (const btn of metaT.buttons) {
        // Solo los URL dinámicos requieren parámetro. Quick reply, URL fija y teléfono
        // los agrega Meta solo con el nombre de la plantilla.
        if (!btn.dynamic) continue;
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(btn.index),
          parameters: [{ type: 'text', text: buttonVariables?.[String(btn.index)] ?? '' }],
        });
      }
    }

    return components;
  }

  private async sendMetaTemplateToConversation(
    organizationId: string,
    userId: string | null,
    conversationId: string,
    templateName: string,
    language: string,
    components: Array<Record<string, unknown>>,
    bodyTextForChat: string,
    headerMedia?: { type: MessageType; mediaUrl: string },
  ): Promise<{ messageId: string }> {
    await this.settings.checkDailyLimitOrThrow(conversationId, organizationId);
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
      include: { contact: true },
    });
    if (!conv) throw new BadRequestException('Conversación no encontrada');
    const isSandbox = this.config.get<string>('WHATSAPP_SANDBOX', 'true') === 'true';
    if (isSandbox && !conv.contact.isSandboxAuthorized) {
      throw new BadRequestException(
        'Este número no está autorizado en Meta (sandbox). Agrégalo en Contactos y márcalo como autorizado.',
      );
    }
    const { messageId } = await this.whatsapp.sendTemplateMessage(
      organizationId,
      conv.contact.phone,
      templateName,
      language,
      components,
    );
    const now = new Date();
    const displayText = bodyTextForChat.trim() || 'Plantilla enviada';
    const created = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUT,
        type: headerMedia?.type ?? MessageType.TEXT,
        status: MessageStatus.SENT,
        body: displayText,
        metaTemplateName: templateName,
        whatsappMessageId: messageId,
        whatsappTimestamp: now,
        fromAi: false,
        sentByUserId: userId,
        mediaUrl: headerMedia?.mediaUrl,
      },
    });
    this.gateway.emitNewMessage(organizationId, conversationId, {
      id: created.id,
      conversationId,
      fromUser: false,
      text: displayText,
      timestamp: now.getTime(),
      type: created.type,
      mediaUrl: created.mediaUrl,
    });
    return { messageId: created.id };
  }

  private async sendTemplateToConversation(
    organizationId: string,
    userId: string | null,
    conversationId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    await this.settings.checkDailyLimitOrThrow(conversationId, organizationId);
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
      include: { contact: true },
    });
    if (!conv) throw new BadRequestException('Conversación no encontrada');
    const isSandbox = this.config.get<string>('WHATSAPP_SANDBOX', 'true') === 'true';
    if (isSandbox && !conv.contact.isSandboxAuthorized) {
      throw new BadRequestException(
        'Este número no está autorizado en Meta (sandbox). Agrégalo en Contactos y márcalo como autorizado.',
      );
    }
    const { messageId } = await this.whatsapp.sendTextMessageRaw(organizationId, conv.contact.phone, text);
    const now = new Date();
    const created = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUT,
        type: MessageType.TEXT,
        status: MessageStatus.SENT,
        body: text,
        whatsappMessageId: messageId,
        whatsappTimestamp: now,
        fromAi: false,
        sentByUserId: userId,
      },
    });
    this.gateway.emitNewMessage(organizationId, conversationId, {
      id: created.id,
      conversationId,
      fromUser: false,
      text,
      timestamp: now.getTime(),
      type: MessageType.TEXT,
    });
    return { messageId: created.id };
  }

  async getAssignmentAuditLogs(organizationId: string) {
    const logs = await this.prisma.conversationAssignmentLog.findMany({
      where: {
        conversation: { contact: { organizationId } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const userIds = new Set<string>();
    for (const l of logs) {
      if (l.fromUserId) userIds.add(l.fromUserId);
      if (l.toUserId) userIds.add(l.toUserId);
      userIds.add(l.reassignedByUserId);
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, email: true, displayName: true },
    });
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    return logs.map((l) => ({
      ...l,
      fromUser: l.fromUserId ? userMap[l.fromUserId] ?? null : null,
      toUser: l.toUserId ? userMap[l.toUserId] ?? null : null,
      reassignedBy: userMap[l.reassignedByUserId] ?? null,
    }));
  }

  async getBroadcastAuditLogs(organizationId: string) {
    return this.prisma.broadcastLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Un envío masivo completo (un click de "Lanzar Masivos") = un runId, agregando enviados/fallidos. */
  async getBroadcastRuns(
    organizationId: string,
  ): Promise<Array<{ runId: string; type: string; title: string | null; startedAt: string; sent: number; failed: number }>> {
    const grouped = await this.prisma.broadcastLog.groupBy({
      by: ['runId', 'type', 'title', 'status'],
      where: { organizationId, runId: { not: null } },
      _count: { _all: true },
      _min: { createdAt: true },
    });

    const runs = new Map<
      string,
      { runId: string; type: string; title: string | null; startedAt: Date; sent: number; failed: number }
    >();
    for (const g of grouped) {
      const runId = g.runId!;
      const existing = runs.get(runId);
      const startedAt = g._min.createdAt!;
      if (!existing) {
        runs.set(runId, {
          runId,
          type: g.type,
          title: g.title,
          startedAt,
          sent: g.status === 'sent' ? g._count._all : 0,
          failed: g.status === 'failed' ? g._count._all : 0,
        });
      } else {
        if (g.status === 'sent') existing.sent += g._count._all;
        if (g.status === 'failed') existing.failed += g._count._all;
        if (startedAt < existing.startedAt) existing.startedAt = startedAt;
        if (!existing.title && g.title) existing.title = g.title;
      }
    }

    return Array.from(runs.values())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 500)
      .map((r) => ({ ...r, startedAt: r.startedAt.toISOString() }));
  }

  /** Contactos de un envío masivo puntual, paginados por cursor (opcionalmente filtrados por estado/categoría). */
  async getBroadcastRunContacts(
    organizationId: string,
    runId: string,
    options: { cursor?: string; limit?: number; status?: 'sent' | 'failed'; category?: string; engagement?: string } = {},
  ): Promise<{
    contacts: Array<{
      name: string | null;
      phone: string;
      status: string;
      deliveryStatus: string | null;
      engagement: string | null;
      failureCategory: string | null;
      failureLabel: string | null;
      errorMessage: string | null;
      createdAt: string;
    }>;
    nextCursor: string | null;
  }> {
    const take = options.limit && options.limit > 0 ? Math.min(options.limit, 200) : 10;
    const categoryFilter =
      options.category === 'PAYMENT_ISSUE'
        ? {
            OR: [
              { failureCategory: 'PAYMENT_ISSUE' },
              { failureCategory: 'OTHER', errorMessage: { contains: 'payment', mode: 'insensitive' as const } },
            ],
          }
        : options.category
          ? { failureCategory: options.category }
          : {};
    const filterByEngagement = !!options.engagement;
    const logs = await this.prisma.broadcastLog.findMany({
      where: {
        organizationId,
        runId,
        status: filterByEngagement ? 'sent' : options.status,
        ...(!filterByEngagement ? categoryFilter : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(!filterByEngagement ? {
        take: take + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      } : {}),
    });

    if (!logs.length) return { contacts: [], nextCursor: null };

    const visibleLogs = filterByEngagement ? logs : logs.slice(0, take);
    const conversationIds = [...new Set(visibleLogs.map((log) => log.conversationId))];
    const messageIds = visibleLogs.map((log) => log.messageId).filter((id): id is string => !!id);

    const [conversations, outboundMessages] = await Promise.all([
      this.prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      include: { contact: { select: { name: true, phone: true } } },
      }),
      this.prisma.message.findMany({
        where: { id: { in: messageIds } },
        select: { id: true, conversationId: true, whatsappMessageId: true, whatsappTimestamp: true, status: true, body: true, metaTemplateName: true },
      }),
    ]);
    const contactByConversation = new Map(conversations.map((c) => [c.id, c.contact]));
    const messageById = new Map(outboundMessages.map((message) => [message.id, message]));

    const firstSentAt = outboundMessages.reduce<Date | null>((first, message) =>
      !first || message.whatsappTimestamp < first ? message.whatsappTimestamp : first, null);
    const [incoming, laterBroadcasts] = firstSentAt ? await Promise.all([
      this.prisma.message.findMany({
        where: { conversationId: { in: conversationIds }, direction: MessageDirection.IN, whatsappTimestamp: { gte: firstSentAt } },
        select: { conversationId: true, body: true, replyToId: true, replyToWamid: true, whatsappTimestamp: true },
        orderBy: { whatsappTimestamp: 'desc' },
      }),
      this.prisma.broadcastLog.findMany({
        where: { organizationId, conversationId: { in: conversationIds }, status: 'sent', createdAt: { gte: firstSentAt } },
        select: { id: true, conversationId: true, createdAt: true },
      }),
    ]) : [[], []];
    const incomingByConversation = new Map<string, typeof incoming>();
    for (const message of incoming) {
      const rows = incomingByConversation.get(message.conversationId) || [];
      rows.push(message);
      incomingByConversation.set(message.conversationId, rows);
    }
    const broadcastsByConversation = new Map<string, typeof laterBroadcasts>();
    for (const log of laterBroadcasts) {
      const rows = broadcastsByConversation.get(log.conversationId) || [];
      rows.push(log);
      broadcastsByConversation.set(log.conversationId, rows);
    }
    const normalize = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

    const enriched = visibleLogs.map((l) => {
      const contact = contactByConversation.get(l.conversationId);
      const outbound = l.messageId ? messageById.get(l.messageId) : null;
      const nextBroadcastAt = (broadcastsByConversation.get(l.conversationId) || [])
        .filter((other) => other.id !== l.id && other.createdAt > l.createdAt)
        .reduce<Date | null>((earliest, other) => !earliest || other.createdAt < earliest ? other.createdAt : earliest, null);
      const replies = incomingByConversation.get(l.conversationId) || [];
      const directReplies = outbound ? replies.filter((reply) =>
        reply.replyToId === outbound.id || reply.replyToWamid === outbound.whatsappMessageId) : [];
      const templateKey = outbound?.metaTemplateName?.toLowerCase().replace(/[^a-z0-9]/g, '');
      const isDiplomaTemplate = templateKey === 'diplomadoiaparadocentes' ||
        (l.type === 'template' && !templateKey && normalize(outbound?.body || '').includes('diplomado en inteligencia artificial aplicada a la docencia'));
      const buttonReply = isDiplomaTemplate ? directReplies.find((reply) => {
        const text = normalize(reply.body);
        return text === 'quiero mas informacion' || text === 'no deseo recibir mas informacion';
      }) : null;
      const otherReply = outbound && replies.some((reply) => {
        if (reply.replyToId === outbound.id || reply.replyToWamid === outbound.whatsappMessageId) return true;
        if (reply.replyToId || reply.replyToWamid) return false;
        return reply.whatsappTimestamp >= outbound.whatsappTimestamp &&
          (!nextBroadcastAt || reply.whatsappTimestamp < nextBroadcastAt);
      });
      const deliveryStatus = outbound?.status ?? null;
      const engagement = l.status !== 'sent' || deliveryStatus === MessageStatus.FAILED ? null
        : buttonReply ? (normalize(buttonReply.body) === 'quiero mas informacion' ? 'INTERESTED' : 'NOT_INTERESTED')
        : otherReply ? 'OTHER_REPLY'
        : deliveryStatus === MessageStatus.READ ? 'READ_NO_REPLY'
        : deliveryStatus === MessageStatus.SENT || deliveryStatus === MessageStatus.DELIVERED ? 'NO_READ_RECEIPT' : null;
      const refined = l.errorMessage ? classifyWhatsAppFailure({ message: l.errorMessage }) : null;
      const category = (refined?.category && refined.category !== 'OTHER'
        ? refined.category
        : l.failureCategory) as BroadcastFailureCategory | null;
      return {
        logId: l.id,
        name: contact?.name ?? null,
        phone: contact?.phone ?? '',
        status: l.status,
        deliveryStatus,
        engagement,
        failureCategory: category,
        failureLabel: category ? FAILURE_CATEGORY_FILTER_LABELS[category] ?? category : null,
        errorMessage: l.errorMessage,
        createdAt: l.createdAt.toISOString(),
      };
    });
    const filtered = options.engagement ? enriched.filter((row) => row.engagement === options.engagement) : enriched;
    if (filterByEngagement) {
      const cursorIndex = options.cursor ? logs.findIndex((log) => log.id === options.cursor) : -1;
      const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      const eligibleIds = new Set(logs.slice(start).map((log) => log.id));
      const filteredAfterCursor = filtered.filter((row) => eligibleIds.has(row.logId));
      const page = filteredAfterCursor.slice(0, take);
      const hasMore = filteredAfterCursor.length > take;
      return { contacts: page.map(({ logId, ...row }) => row), nextCursor: hasMore ? page[page.length - 1].logId : null };
    }
    return { contacts: filtered.map(({ logId, ...row }) => row), nextCursor: logs.length > take ? visibleLogs[visibleLogs.length - 1].id : null };
  }

  /** Vincula una etiqueta a los contactos de un masivo ya enviado (sobrescribe tag previo). */
  async assignTagToRunContacts(
    organizationId: string,
    runId: string,
    tagId: string,
    options: { onlySent?: boolean } = {},
  ): Promise<{ updated: number; total: number; alreadyTagged: number; tagName: string }> {
    const tag = await this.prisma.tag.findFirst({
      where: { id: tagId, organizationId },
    });
    if (!tag) throw new NotFoundException('Etiqueta no encontrada');

    const logs = await this.prisma.broadcastLog.findMany({
      where: {
        organizationId,
        runId,
        ...(options.onlySent ? { status: 'sent' } : {}),
      },
      select: { conversationId: true },
    });

    if (!logs.length) {
      const anyLog = await this.prisma.broadcastLog.findFirst({
        where: { organizationId, runId },
        select: { id: true },
      });
      if (!anyLog) throw new NotFoundException('Masivo no encontrado');
      return { updated: 0, total: 0, alreadyTagged: 0, tagName: tag.name };
    }

    const conversationIds = [...new Set(logs.map((l) => l.conversationId))];
    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: { contactId: true, contact: { select: { tagId: true, organizationId: true } } },
    });

    const uniqueContacts = new Map<string, string | null>();
    for (const c of conversations) {
      if (c.contact.organizationId !== organizationId) continue;
      uniqueContacts.set(c.contactId, c.contact.tagId);
    }

    const contactIds = [...uniqueContacts.keys()];
    const alreadyTagged = [...uniqueContacts.values()].filter((id) => id === tagId).length;

    if (!contactIds.length) {
      return { updated: 0, total: 0, alreadyTagged: 0, tagName: tag.name };
    }

    const result = await this.prisma.contact.updateMany({
      where: { id: { in: contactIds }, organizationId },
      data: { tagId },
    });

    return {
      updated: result.count,
      total: contactIds.length,
      alreadyTagged,
      tagName: tag.name,
    };
  }

  private async logBroadcast(
    organizationId: string,
    userId: string | null,
    runId: string,
    conversationId: string,
    type: BroadcastMessageType,
    status: 'sent' | 'failed',
    errorMessage?: string,
    messageId?: string,
    title?: string,
  ): Promise<void> {
    const failureCategory =
      status === 'failed' ? classifyWhatsAppFailure({ message: errorMessage }).category : null;
    await this.prisma.broadcastLog.create({
      data: {
        organizationId,
        userId,
        runId,
        conversationId,
        type,
        status,
        errorMessage: status === 'failed' ? errorMessage : null,
        messageId,
        failureCategory,
        title: title?.trim() || null,
      },
    });
  }
}
