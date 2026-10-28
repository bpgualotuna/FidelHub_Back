import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCryptoService } from '../common/secrets-crypto.service';
import { Window24hService } from '../common/window-24h.service';

export interface SendTextMessageDto {
  to: string;
  text: string;
  lastUserMessageAt: Date | number | null;
  replyToWamid?: string;
}

export interface MetaTemplateHeader {
  format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  variables: string[];
}

export interface MetaTemplateButton {
  index: number;
  type: string;
  text: string;
  url?: string;
  phoneNumber?: string;
  /** True si es un botón URL con variable ({{1}}) y hay que mandar el parámetro al enviar. */
  dynamic?: boolean;
}

export interface MetaTemplateDto {
  id: string;
  name: string;
  body: string;
  variables: string[];
  language: string;
  category?: string;
  status?: string;
  header?: MetaTemplateHeader;
  buttons?: MetaTemplateButton[];
}

/** Extrae nombres de variables ({{1}} numeradas o {{nombre}} con nombre), sin duplicados. */
function extractTemplateVariables(text: string): string[] {
  const found: string[] = [];
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  for (const m of matches) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  const allNumeric = found.every((v) => /^\d+$/.test(v));
  return allNumeric ? found.sort((a, b) => Number(a) - Number(b)) : found;
}

export interface ResolvedWhatsappCreds {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
}

@Injectable()
export class WhatsAppService {
  private readonly baseUrl = 'https://graph.facebook.com/v18.0';
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly window24h: Window24hService,
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
  ) {}

  async resolveCredentials(organizationId: string): Promise<ResolvedWhatsappCreds> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { credentials: true },
    });
    if (!org) throw new BadRequestException('Organización no encontrada');
    let accessToken = '';
    if (org.credentials?.whatsappAccessTokenEnc) {
      try {
        accessToken = this.crypto.decrypt(org.credentials.whatsappAccessTokenEnc);
      } catch {
        accessToken = '';
      }
    }
    if (!accessToken) {
      accessToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN', '') || '';
    }
    const phoneNumberId =
      org.whatsappPhoneNumberId?.trim() ||
      this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID', '') ||
      '';
    let businessAccountId = '';
    if (org.credentials?.whatsappBusinessAccountIdEnc) {
      try {
        businessAccountId = this.crypto.decrypt(org.credentials.whatsappBusinessAccountIdEnc);
      } catch {
        businessAccountId = '';
      }
    }
    if (!businessAccountId) {
      businessAccountId = this.config.get<string>('WHATSAPP_BUSINESS_ACCOUNT_ID', '') || '';
    }
    if (!accessToken || !phoneNumberId) {
      throw new BadRequestException(
        'WhatsApp no configurado: token o phone number ID (integraciones o .env).',
      );
    }
    return { accessToken, phoneNumberId, businessAccountId };
  }

  async sendTextMessage(
    organizationId: string,
    dto: SendTextMessageDto,
  ): Promise<{ messageId: string }> {
    if (!this.window24h.canSendFreeMessage(dto.lastUserMessageAt)) {
      throw new BadRequestException(
        'Ventana de 24 horas cerrada. No se puede enviar mensaje libre. El usuario debe escribir primero.',
      );
    }
    return this.sendTextMessageRaw(organizationId, dto.to, dto.text, dto.replyToWamid);
  }

  async sendTextMessageRaw(
    organizationId: string,
    to: string,
    text: string,
    replyToWamid?: string,
  ): Promise<{ messageId: string }> {
    const { accessToken, phoneNumberId } = await this.resolveCredentials(organizationId);
    const normalized = to.replace(/\D/g, '');
    if (!normalized) throw new BadRequestException('Número de destino inválido');
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized,
      type: 'text',
      text: { body: text },
      ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: { message: string }; messages?: Array<{ id: string }> };
    if (data.error) {
      const msg = data.error.message || 'Error al enviar mensaje por WhatsApp';
      const hint = /permission|#10/i.test(msg)
        ? ' En modo desarrollo, añade el número de destino como número de prueba en Meta for Developers (WhatsApp > Configuración).'
        : '';
      throw new BadRequestException(msg + hint);
    }
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new BadRequestException('WhatsApp no devolvió ID de mensaje');
    return { messageId };
  }

  async getMessageTemplates(organizationId: string): Promise<MetaTemplateDto[]> {
    const { accessToken, businessAccountId } = await this.resolveCredentials(organizationId);
    if (!businessAccountId || !accessToken) {
      return [];
    }
    const url = `${this.baseUrl}/${businessAccountId}/message_templates?status=APPROVED`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as {
      error?: { message: string };
      data?: Array<{
        id?: string;
        name: string;
        language: string;
        status?: string;
        category?: string;
        components?: Array<{
          type: string;
          format?: string;
          text?: string;
          buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
          example?: { body_text?: string[][]; header_text?: string[] };
        }>;
      }>;
      paging?: { next?: string };
    };
    if (data.error) return [];
    const list = data.data ?? [];
    const out: MetaTemplateDto[] = [];
    for (const t of list) {
      const bodyComp = t.components?.find((c) => c.type === 'BODY');
      const body = bodyComp?.text ?? '';
      const variables = extractTemplateVariables(body);

      let header: MetaTemplateHeader | undefined;
      const headerComp = t.components?.find((c) => c.type === 'HEADER');
      if (headerComp) {
        const format = (headerComp.format ?? 'TEXT') as MetaTemplateHeader['format'];
        if (format === 'TEXT') {
          const headerVars = extractTemplateVariables(headerComp.text ?? '');
          if (headerVars.length > 0) {
            header = { format, text: headerComp.text, variables: headerVars };
          }
        } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
          header = { format, variables: [] };
        }
      }

      let buttons: MetaTemplateButton[] | undefined;
      const buttonsComp = t.components?.find((c) => c.type === 'BUTTONS');
      if (buttonsComp?.buttons?.length) {
        buttons = buttonsComp.buttons.map((b, index) => ({
          index,
          type: b.type,
          text: b.text,
          url: b.url,
          phoneNumber: b.phone_number,
          dynamic: b.type === 'URL' && !!b.url && /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(b.url),
        }));
      }

      out.push({
        id: `meta_${t.name}_${t.language}`,
        name: `${t.name} (${t.language})`,
        body,
        variables,
        language: t.language,
        category: t.category,
        status: t.status,
        header,
        buttons,
      });
    }
    return out;
  }

  async sendMediaRaw(
    organizationId: string,
    to: string,
    mediaUrl: string,
    mimeType: string,
    caption?: string,
  ): Promise<{ messageId: string }> {
    const { accessToken, phoneNumberId } = await this.resolveCredentials(organizationId);
    const normalized = to.replace(/\D/g, '');
    if (!normalized) throw new BadRequestException('Número de destino inválido');

    const mediaType = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('video/') ? 'video'
      : mimeType.startsWith('audio/') ? 'audio'
      : 'document';

    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized,
      type: mediaType,
      [mediaType]: { link: mediaUrl },
    };
    if (caption && (mediaType === 'image' || mediaType === 'video')) {
      (body[mediaType] as Record<string, unknown>).caption = caption;
    }

    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: { message: string }; messages?: Array<{ id: string }> };
    if (data.error) {
      throw new BadRequestException(data.error.message || 'Error al enviar multimedia por WhatsApp');
    }
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new BadRequestException('WhatsApp no devolvió ID de mensaje');
    return { messageId };
  }

  async sendTemplateMessage(
    organizationId: string,
    to: string,
    templateName: string,
    language: string,
    components: Array<Record<string, unknown>>,
  ): Promise<{ messageId: string }> {
    const { accessToken, phoneNumberId } = await this.resolveCredentials(organizationId);
    const normalized = to.replace(/\D/g, '');
    if (!normalized) throw new BadRequestException('Número de destino inválido');
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components,
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: { message: string }; messages?: Array<{ id: string }> };
    if (data.error) {
      throw new BadRequestException(data.error.message || 'Error al enviar plantilla por WhatsApp');
    }
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new BadRequestException('WhatsApp no devolvió ID de mensaje');
    return { messageId };
  }

  async sendMediaMessage(
    organizationId: string,
    params: {
      to: string;
      mediaUrl: string;
      type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
      fileName?: string;
      lastUserMessageAt: Date | null;
    },
  ): Promise<{ messageId: string }> {
    if (!this.window24h.canSendFreeMessage(params.lastUserMessageAt)) {
      throw new BadRequestException(
        'Ventana de 24 horas cerrada. No se puede enviar mensaje libre. El usuario debe escribir primero.',
      );
    }
    const { accessToken, phoneNumberId } = await this.resolveCredentials(organizationId);
    const normalized = params.to.replace(/\D/g, '');
    if (!normalized) throw new BadRequestException('Número de destino inválido');
    const url = `${this.baseUrl}/${phoneNumberId}/messages`;
    const typeLower = params.type.toLowerCase();
    const mediaObject: Record<string, unknown> = {
      link: params.mediaUrl,
    };
    if (params.type === 'DOCUMENT' && params.fileName) {
      mediaObject.filename = params.fileName;
    }
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized,
      type: typeLower,
      [typeLower]: mediaObject,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: { message: string }; messages?: Array<{ id: string }> };
    if (data.error) {
      throw new BadRequestException(data.error.message || 'Error al enviar archivo por WhatsApp');
    }
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new BadRequestException('WhatsApp no devolvió ID de mensaje');
    return { messageId };
  }

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const expectedToken = this.config.get<string>('WHATSAPP_VERIFY_TOKEN', '');
    if (mode === 'subscribe' && token === expectedToken) return challenge;
    return null;
  }

  /** Resuelve organización por phone_number_id del webhook; fallback a DEFAULT_ORGANIZATION_ID + env. */
  async resolveOrganizationIdFromWebhookPhoneNumberId(
    phoneNumberId: string | undefined,
  ): Promise<string | null> {
    if (!phoneNumberId) return null;
    const org = await this.prisma.organization.findFirst({
      where: { whatsappPhoneNumberId: phoneNumberId },
    });
    if (org) return org.id;
    const envId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID', '');
    if (envId && envId === phoneNumberId) {
      return (
        this.config.get<string>('DEFAULT_ORGANIZATION_ID', '') || 'org_default_migration'
      );
    }
    return null;
  }

  /**
   * Descarga un archivo multimedia desde los servidores de WhatsApp.
   * Retorna el Buffer y el MimeType.
   */
  async downloadMedia(mediaId: string, organizationId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const { accessToken } = await this.resolveCredentials(organizationId);

    // 1. Obtener la URL del archivo
    const metaUrl = `${this.baseUrl}/${mediaId}`;
    const metaRes = await fetch(metaUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metaRes.ok) {
      return null;
    }

    const metaData = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!metaData.url || !metaData.mime_type) {
      return null;
    }

    // 2. Descargar el archivo binario
    const fileRes = await fetch(metaData.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok) {
      return null;
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: metaData.mime_type,
    };
  }

  async syncMessagingLimit(organizationId: string): Promise<{ whatsappTier: string; dailyLimit: number | null }> {
    const { accessToken, phoneNumberId } = await this.resolveCredentials(organizationId);
    
    // Query Meta Graph API for messaging limit
    const url = `${this.baseUrl}/${phoneNumberId}?fields=whatsapp_business_manager_messaging_limit`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    
    const data = (await res.json()) as {
      whatsapp_business_manager_messaging_limit?: string;
      error?: { message: string };
    };
    
    if (data.error) {
      throw new BadRequestException(data.error.message || 'Error al obtener límites de WhatsApp de Meta');
    }
    
    const metaLimit = data.whatsapp_business_manager_messaging_limit || 'TIER_250';
    
    // Map Meta limit string to our internal WhatsappTier enum
    let tier = 'new';
    switch (metaLimit) {
      case 'TIER_250':
        tier = 'new';
        break;
      case 'TIER_1K':
      case 'TIER_2K':
        tier = 'level1';
        break;
      case 'TIER_10K':
        tier = 'level2';
        break;
      case 'TIER_100K':
        tier = 'level3';
        break;
      case 'UNLIMITED':
        tier = 'excellent';
        break;
      default:
        tier = 'new';
    }
    
    // Upsert the organization setting in database
    await this.prisma.organizationSetting.upsert({
      where: {
        organizationId_key: { organizationId, key: 'whatsapp_tier' },
      },
      create: {
        organizationId,
        key: 'whatsapp_tier',
        value: tier,
      },
      update: {
        value: tier,
      },
    });
    
    const limits: Record<string, number> = {
      new: 250,
      level1: 1000,
      level2: 10000,
      level3: 100000,
      excellent: Number.MAX_SAFE_INTEGER,
    };
    
    const dailyLimit = limits[tier];
    
    return {
      whatsappTier: tier,
      dailyLimit: dailyLimit === Number.MAX_SAFE_INTEGER ? null : dailyLimit,
    };
  }

  /**
   * Re-sincroniza el tier de mensajería de todas las organizaciones con WhatsApp configurado.
   * Se dispara cuando llega el webhook `phone_number_quality_update` de Meta: ese evento no trae
   * el phone_number_id (solo display_phone_number), así que en vez de intentar mapear a una sola
   * organización, se refresca el tier real de todas — es una llamada barata y evita depender de un
   * matching frágil por número de teléfono.
   */
  async resyncAllOrganizationsMessagingLimit(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({
      where: { whatsappPhoneNumberId: { not: null } },
      select: { id: true, name: true },
    });
    for (const org of orgs) {
      try {
        const result = await this.syncMessagingLimit(org.id);
        this.logger.log(
          `Tier re-sincronizado por webhook para org=${org.name} (${org.id}): ${result.whatsappTier} (${result.dailyLimit ?? 'ilimitado'}/día)`,
        );
      } catch (err) {
        this.logger.warn(`No se pudo re-sincronizar tier para org=${org.name} (${org.id}): ${err}`);
      }
    }
  }
}
