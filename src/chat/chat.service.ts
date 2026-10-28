import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, MessageStatus, MessageType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { Window24hService } from '../common/window-24h.service';
import { AiService } from '../ai/ai.service';
import { SettingsService } from '../settings/settings.service';
import { ChatGateway } from './chat.gateway';
import { LeadAssignmentService } from '../lead-assignment/lead-assignment.service';
import { StorageService } from '../common/storage.service';
import { normalizePhone } from '../common/phone.util';
import { ensureWhatsAppCompatibleVideo, withMp4Extension, WHATSAPP_VIDEO_MAX_BYTES } from '../common/video-transcode.util';
import { ConversationsQueryService } from './conversations-query.service';

export interface Message {
  id: string;
  conversationId: string;
  fromUser: boolean;
  text: string;
  timestamp: number;
  fromAi?: boolean;
  type?: string;
  mediaUrl?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  status?: string;
  referral?: {
    source_url?: string;
    source_id?: string;
    source_type?: string;
    headline?: string;
    body?: string;
    media_type?: string;
    image_url?: string;
    video_url?: string;
    thumbnail_url?: string;
    ctwa_clid?: string;
    [key: string]: any;
  } | null;
  replyTo?: {
    id: string;
    text: string;
    fromUser: boolean;
    type?: string;
    mediaUrl?: string | null;
  } | null;
  /** true si el mensaje es una respuesta/cita a otro, aunque no podamos resolver su contenido (ej. citó un mensaje que no pasó por nuestro sistema). */
  isReply?: boolean;
}

export interface Conversation {
  id: string;
  phone: string;
  name?: string;
  email?: string | null;
  tag?: string | null;
  tagId?: string | null;
  contactId?: string;
  isSandboxAuthorized?: boolean;
  lastUserMessageAt: number | null;
  lastMessagePreview: string;
  lastMessageAt: number;
  unreadCount: number;
  assignedToUserId?: string | null;
  isNewLead?: boolean;
  isAiActive?: boolean;
  adReferral?: any;
}

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly window24h: Window24hService,
    private readonly ai: AiService,
    private readonly settings: SettingsService,
    private readonly chatGateway: ChatGateway,
    private readonly config: ConfigService,
    private readonly leadAssignment: LeadAssignmentService,
    private readonly storage: StorageService,
    private readonly conversationsQuery: ConversationsQueryService,
  ) {}

  async registerIncomingMessage(payload: {
    organizationId: string;
    from: string;
    messageId: string;
    timestamp: number;
    text: string;
    type?: MessageType;
    mediaUrl?: string;
    mimeType?: string;
    fileName?: string;
    contactName?: string;
    replyToWamid?: string;
    quickReply?: boolean;
    referral?: Record<string, any>;
  }): Promise<void> {
    const phone = normalizePhone(payload.from);

    // Obtener campaña activa (intentando coincidir por titular si el lead viene de un anuncio)
    let matchedCampaign: any = null;
    if (payload.referral?.headline && typeof payload.referral.headline === 'string') {
      matchedCampaign = await this.prisma.campaign.findFirst({
        where: {
          organizationId: payload.organizationId,
          isActive: true,
          name: { contains: payload.referral.headline.trim(), mode: 'insensitive' },
        },
      });
    }

    const activeCampaign = matchedCampaign || (await this.prisma.campaign.findFirst({
      where: { organizationId: payload.organizationId, isActive: true },
    }));
    const activeCampaignId = activeCampaign?.id ?? null;

    const contactUpdateData: any = {};
    if (activeCampaignId) {
      contactUpdateData.campaignId = activeCampaignId;
    }

    const contact = await this.prisma.contact.upsert({
      where: {
        organizationId_phone: {
          organizationId: payload.organizationId,
          phone,
        },
      },
      create: { 
        organizationId: payload.organizationId, 
        phone,
        name: payload.contactName || null,
        campaignId: activeCampaignId,
      },
      update: contactUpdateData,
    });

    let conversation = await this.prisma.conversation.findFirst({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'desc' },
    });
    const isNewConversation = !conversation;

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          contactId: contact.id,
          lastUserMessageAt: new Date(payload.timestamp),
          campaignId: activeCampaignId,
          adReferral: payload.referral ? (payload.referral as any) : undefined,
        },
      });
    } else {
      const updateData: any = { lastUserMessageAt: new Date(payload.timestamp) };
      if (activeCampaignId && conversation.campaignId !== activeCampaignId) {
        updateData.campaignId = activeCampaignId;
      }
      if (payload.referral) {
        updateData.adReferral = payload.referral as any;
      }
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: updateData,
      });
    }

    // Historial en CampaignContact
    if (activeCampaign) {
      await this.prisma.campaignContact.upsert({
        where: {
          campaignId_contactId: {
            campaignId: activeCampaign.id,
            contactId: contact.id,
          },
        },
        create: {
          campaignId: activeCampaign.id,
          contactId: contact.id,
        },
        update: {},
      });
    }

    // Detectar edición: buscar mensaje existente por wamid
    const existingMessage = await this.prisma.message.findUnique({
      where: { whatsappMessageId: payload.messageId },
    });

    if (existingMessage) {
      const bodyChanged = existingMessage.body !== payload.text;
      if (bodyChanged) {
        await this.prisma.messageEditHistory.create({
          data: {
            messageId: existingMessage.id,
            previousBody: existingMessage.body,
          },
        });
        await this.prisma.message.update({
          where: { id: existingMessage.id },
          data: {
            body: payload.text,
            isEdited: true,
            editedAt: new Date(),
            mediaUrl: payload.mediaUrl ?? existingMessage.mediaUrl,
            mimeType: payload.mimeType ?? existingMessage.mimeType,
            fileName: payload.fileName ?? existingMessage.fileName,
          },
        });
        this.chatGateway.emitMessageEdited(
          payload.organizationId,
          conversation.id,
          existingMessage.id,
          payload.text,
        );
      }
    } else {
      let replyToId: string | undefined;
      let replyToSnapshot: Message['replyTo'];
      if (payload.replyToWamid) {
        const quoted = await this.prisma.message.findUnique({
          where: { whatsappMessageId: payload.replyToWamid },
        });
        this.logger.log(
          `registerIncomingMessage: replyToWamid=${payload.replyToWamid} quotedFound=${!!quoted}`,
        );
        if (quoted) {
          replyToId = quoted.id;
          replyToSnapshot = {
            id: quoted.id,
            text: quoted.body,
            fromUser: quoted.direction === MessageDirection.IN,
            type: quoted.type,
            mediaUrl: quoted.mediaUrl,
          };
        }
      }

      // TODO: hacer configurables por plantilla las respuestas, estados y acciones.
      // Por ahora solo esta plantilla cambia el interés y la asignación.
      let interestStatus: 'INTERESTED' | 'NOT_INTERESTED' | null = null;
      if (payload.quickReply && replyToId) {
        const original = await this.prisma.message.findUnique({
          where: { id: replyToId },
          select: { metaTemplateName: true, direction: true },
        });
        const templateKey = original?.metaTemplateName?.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (original?.direction === MessageDirection.OUT && templateKey === 'diplomadoiaparadocentes') {
          const answer = payload.text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (answer === 'quiero mas informacion') interestStatus = 'INTERESTED';
          if (answer === 'no deseo recibir mas informacion') interestStatus = 'NOT_INTERESTED';
        }
      }

      const created = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: MessageDirection.IN,
          type: payload.type || MessageType.TEXT,
          status: MessageStatus.RECEIVED,
          body: payload.text,
          mediaUrl: payload.mediaUrl,
          mimeType: payload.mimeType,
          fileName: payload.fileName,
          whatsappMessageId: payload.messageId,
          whatsappTimestamp: new Date(payload.timestamp),
          replyToId,
          replyToWamid: payload.replyToWamid,
          referral: payload.referral ? (payload.referral as any) : undefined,
        },
      });
      this.processedIncomingMsgIds.add(created.id);

      let interestApplied = false;
      if (interestStatus) {
        const result = await this.prisma.contact.updateMany({
          where: {
            id: contact.id,
            OR: [
              { interestRespondedAt: null },
              { interestRespondedAt: { lte: new Date(payload.timestamp) } },
            ],
          },
          data: { interestStatus, interestRespondedAt: new Date(payload.timestamp) },
        });
        interestApplied = result.count > 0;
      }

      if (interestApplied && interestStatus === 'INTERESTED') {
        await this.leadAssignment.assignNewLead(conversation.id, payload.organizationId);
      } else if (isNewConversation && interestStatus === null) {
        await this.leadAssignment.tryAutoAssignNewLead(conversation.id, payload.organizationId);
      }

      this.chatGateway.emitNewMessage(
        payload.organizationId,
        conversation.id,
        {
          id: created.id,
          conversationId: conversation.id,
          fromUser: true,
          text: payload.text,
          timestamp: payload.timestamp,
          mediaUrl: payload.mediaUrl,
          mimeType: payload.mimeType,
          fileName: payload.fileName,
          type: payload.type || MessageType.TEXT,
          replyTo: replyToSnapshot,
          isReply: !!payload.replyToWamid,
          referral: created.referral,
        } as any,
      );

      // Respuesta automática de Fidel si la IA está activa
      this.triggerFidelAutoReply(payload.organizationId, conversation.id, contact.phone);
    }
  }


  private async assertConversationInOrg(conversationId: string, organizationId: string): Promise<void> {
    const c = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Conversación no encontrada');
  }

  async getConversations(
    organizationId: string,
    userId?: string,
    userRole?: string,
  ): Promise<Conversation[]> {
    return this.conversationsQuery.getConversations(organizationId, userId, userRole);
  }

  async searchConversationsByMessage(organizationId: string, query: string, userId?: string, userRole?: string) {
    return this.conversationsQuery.searchByMessage(organizationId, query, userId, userRole);
  }

  async markConversationAsRead(conversationId: string, organizationId: string): Promise<void> {
    await this.assertConversationInOrg(conversationId, organizationId);
    const latestMessage = await this.prisma.message.findFirst({
      where: { conversationId },
      orderBy: { whatsappTimestamp: 'desc' },
      select: { whatsappTimestamp: true },
    });
    const now = new Date();
    const readTime =
      latestMessage && latestMessage.whatsappTimestamp > now
        ? new Date(latestMessage.whatsappTimestamp.getTime() + 1000)
        : now;
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastReadAt: readTime },
    });
    this.chatGateway.emitConversationRead(organizationId, conversationId);
  }

  async getConversationsWithWindowStatus(
    organizationId: string,
    userId?: string,
    userRole?: string,
  ): Promise<Array<Conversation & { canSend: boolean; windowSecondsRemaining: number }>> {
    const list = await this.getConversations(organizationId, userId, userRole);
    return list.map((c) => ({
      ...c,
      canSend: this.window24h.canSendFreeMessage(c.lastUserMessageAt),
      windowSecondsRemaining: this.window24h.getSecondsRemaining(c.lastUserMessageAt),
    }));
  }

  async getMessages(
    conversationId: string, 
    organizationId: string, 
    cursor?: string,
    userId?: string,
    userRole?: string,
  ): Promise<{ messages: Message[]; nextCursor: string | null }> {
    await this.assertConversationAccess(conversationId, organizationId, userId, userRole);
    
    const take = 50;
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      take: take + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { whatsappTimestamp: 'desc' },
      include: { replyTo: true },
    });

    let nextCursor: string | null = null;
    if (rows.length > take) {
      const nextItem = rows.pop();
      nextCursor = nextItem!.id;
    }

    const messages = rows.reverse().map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      fromUser: m.direction === MessageDirection.IN,
      text: m.body,
      timestamp: m.whatsappTimestamp.getTime(),
      fromAi: m.fromAi ?? undefined,
      type: m.type,
      mediaUrl: m.mediaUrl,
      mimeType: m.mimeType,
      fileName: m.fileName,
      status: m.status,
      referral: (m as any).referral ?? undefined,
      replyTo: m.replyTo
        ? {
            id: m.replyTo.id,
            text: m.replyTo.body,
            fromUser: m.replyTo.direction === MessageDirection.IN,
            type: m.replyTo.type,
            mediaUrl: m.replyTo.mediaUrl,
          }
        : undefined,
      isReply: !!(m.replyToId || m.replyToWamid),
    }));

    return { messages, nextCursor };
  }

  async getGallery(
    conversationId: string,
    organizationId: string,
    userId?: string,
    userRole?: string,
    cursor?: string,
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    await this.assertConversationAccess(conversationId, organizationId, userId, userRole);
    const take = 30;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        OR: [
          { type: { in: [MessageType.IMAGE, MessageType.VIDEO, MessageType.AUDIO, MessageType.DOCUMENT] } },
          { body: { contains: 'http://', mode: 'insensitive' } },
          { body: { contains: 'https://', mode: 'insensitive' } }
        ]
      },
      take: take + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { whatsappTimestamp: 'desc' },
    });

    let nextCursor: string | null = null;
    if (rows.length > take) {
      nextCursor = rows.pop()!.id;
    }

    return {
      items: rows.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        fromUser: m.direction === MessageDirection.IN,
        text: m.body,
        timestamp: m.whatsappTimestamp.getTime(),
        fromAi: m.fromAi ?? undefined,
        type: m.type,
        mediaUrl: m.mediaUrl,
        mimeType: m.mimeType,
        fileName: m.fileName,
      })),
      nextCursor,
    };
  }

  async searchMessages(conversationId: string, organizationId: string, query: string, userId?: string, userRole?: string): Promise<Message[]> {
    await this.assertConversationAccess(conversationId, organizationId, userId, userRole);
    if (!query || query.trim().length === 0) return [];
    
    const rows = await this.prisma.message.findMany({
      where: { 
        conversationId,
        body: { contains: query, mode: 'insensitive' },
        type: MessageType.TEXT
      },
      orderBy: { whatsappTimestamp: 'desc' },
    });
    return rows.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      fromUser: m.direction === MessageDirection.IN,
      text: m.body,
      timestamp: m.whatsappTimestamp.getTime(),
      fromAi: m.fromAi ?? undefined,
      type: m.type,
    }));
  }

  async getConversation(
    conversationId: string,
    organizationId: string,
    userId?: string,
    userRole?: string,
  ): Promise<Conversation | undefined> {
    return this.conversationsQuery.getConversation(conversationId, organizationId, userId, userRole);
  }

  async canSendToConversation(conversationId: string, organizationId: string): Promise<boolean> {
    await this.assertConversationInOrg(conversationId, organizationId);
    const lastAt = await this.getConversationLastUserMessageAt(conversationId);
    return this.window24h.canSendFreeMessage(lastAt);
  }

  async getWindowSecondsRemaining(conversationId: string, organizationId: string): Promise<number> {
    await this.assertConversationInOrg(conversationId, organizationId);
    const lastAt = await this.getConversationLastUserMessageAt(conversationId);
    return this.window24h.getSecondsRemaining(lastAt);
  }

  private async getConversationLastUserMessageAt(conversationId: string): Promise<Date | null> {
    const c = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { lastUserMessageAt: true },
    });
    return c?.lastUserMessageAt ?? null;
  }

  private async assertCanSendAndGetConversation(organizationId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
      include: { contact: true },
    });
    if (!conv) throw new BadRequestException('Conversación no encontrada');
    const isSandbox = this.config.get<string>('WHATSAPP_SANDBOX', 'true') === 'true';
    if (isSandbox && !conv.contact.isSandboxAuthorized) {
      throw new ForbiddenException(
        'Este número no está autorizado en Meta (sandbox). Agrégalo en Contactos y márcalo como autorizado.',
      );
    }
    await this.settings.checkDailyLimitOrThrow(conversationId, organizationId);
    return conv;
  }

  private async ensureCampaignAssignment(
    organizationId: string,
    contactId: string,
    conversationId: string,
  ): Promise<void> {
    const activeCampaign = await this.prisma.campaign.findFirst({
      where: { organizationId, isActive: true },
    });
    if (!activeCampaign) return;

    await this.prisma.contact.update({
      where: { id: contactId },
      data: { campaignId: activeCampaign.id },
    });

    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { campaignId: true },
    });
    if (conv && conv.campaignId !== activeCampaign.id) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { campaignId: activeCampaign.id },
      });
    }

    await this.prisma.campaignContact.upsert({
      where: {
        campaignId_contactId: {
          campaignId: activeCampaign.id,
          contactId,
        },
      },
      create: {
        campaignId: activeCampaign.id,
        contactId,
      },
      update: {},
    });
  }

  async sendMessage(params: {
    organizationId: string;
    conversationId: string;
    text: string;
    fromAi?: boolean;
    sentByUserId?: string | null;
    replyToId?: string;
  }): Promise<Message> {
    const conv = await this.assertCanSendAndGetConversation(params.organizationId, params.conversationId);
    const lastUserMessageAt = conv.lastUserMessageAt ? new Date(conv.lastUserMessageAt) : null;

    let replyToSnapshot: Message['replyTo'];
    let replyToWamid: string | undefined;
    if (params.replyToId) {
      const quoted = await this.prisma.message.findFirst({
        where: { id: params.replyToId, conversationId: params.conversationId },
      });
      if (quoted) {
        replyToWamid = quoted.whatsappMessageId;
        replyToSnapshot = {
          id: quoted.id,
          text: quoted.body,
          fromUser: quoted.direction === MessageDirection.IN,
          type: quoted.type,
          mediaUrl: quoted.mediaUrl,
        };
      }
    }

    const { messageId } = await this.whatsapp.sendTextMessage(params.organizationId, {
      to: conv.contact.phone,
      text: params.text,
      lastUserMessageAt,
      replyToWamid,
    });
    const now = new Date();
    const created = await this.prisma.message.create({
      data: {
        conversationId: params.conversationId,
        direction: MessageDirection.OUT,
        type: MessageType.TEXT,
        status: MessageStatus.SENT,
        body: params.text,
        whatsappMessageId: messageId,
        whatsappTimestamp: now,
        fromAi: params.fromAi ?? false,
        sentByUserId: params.sentByUserId ?? null,
        replyToId: replyToSnapshot?.id,
      },
    });

    if (!params.fromAi) {
      this.cancelFidelAutoReply(params.conversationId);
      await this.prisma.conversation.update({
        where: { id: params.conversationId },
        data: { isAiActive: false },
      });
      this.chatGateway.server?.to(`org:${params.organizationId}`)?.emit('conversation_ai_status_updated', {
        conversationId: params.conversationId,
        isAiActive: false,
      });
    }

    const msg: Message = {
      id: created.id,
      conversationId: created.conversationId,
      fromUser: false,
      text: created.body,
      timestamp: created.whatsappTimestamp.getTime(),
      fromAi: created.fromAi ?? undefined,
      status: created.status,
      replyTo: replyToSnapshot,
      isReply: !!replyToSnapshot,
    };
    this.chatGateway.emitNewMessage(params.organizationId, params.conversationId, msg);
    await this.ensureCampaignAssignment(params.organizationId, conv.contact.id, params.conversationId);
    return msg;
  }

  async sendMedia(params: {
    organizationId: string;
    conversationId: string;
    mediaUrl: string;
    mimeType: string;
    fileName?: string;
    sentByUserId?: string | null;
  }): Promise<Message> {
    const conv = await this.assertCanSendAndGetConversation(params.organizationId, params.conversationId);
    const lastUserMessageAt = conv.lastUserMessageAt ? new Date(conv.lastUserMessageAt) : null;

    const msgType = params.mimeType.startsWith('image/') ? MessageType.IMAGE
      : params.mimeType.startsWith('video/') ? MessageType.VIDEO
      : params.mimeType.startsWith('audio/') ? MessageType.AUDIO
      : MessageType.DOCUMENT;

    const { messageId } = await this.whatsapp.sendMediaRaw(
      params.organizationId,
      conv.contact.phone,
      params.mediaUrl,
      params.mimeType,
      params.fileName,
    );

    const now = new Date();
    const created = await this.prisma.message.create({
      data: {
        conversationId: params.conversationId,
        direction: MessageDirection.OUT,
        type: msgType,
        status: MessageStatus.SENT,
        body: params.fileName || '',
        mediaUrl: params.mediaUrl,
        mimeType: params.mimeType,
        fileName: params.fileName || null,
        whatsappMessageId: messageId,
        whatsappTimestamp: now,
        fromAi: false,
        sentByUserId: params.sentByUserId ?? null,
      },
    });
    const msg: Message = {
      id: created.id,
      conversationId: created.conversationId,
      fromUser: false,
      text: created.body,
      timestamp: created.whatsappTimestamp.getTime(),
      type: created.type,
      mediaUrl: created.mediaUrl,
      mimeType: created.mimeType,
      fileName: created.fileName,
      status: created.status,
    };
    this.chatGateway.emitNewMessage(params.organizationId, params.conversationId, msg);
    await this.ensureCampaignAssignment(params.organizationId, conv.contact.id, params.conversationId);
    return msg;
  }

  async sendMediaMessage(params: {
    organizationId: string;
    conversationId: string;
    file: any;
    type: MessageType;
    sentByUserId?: string | null;
  }): Promise<Message> {
    const conv = await this.assertCanSendAndGetConversation(params.organizationId, params.conversationId);

    const { buffer, mimetype, transcoded } = await ensureWhatsAppCompatibleVideo(
      params.file.buffer,
      params.file.mimetype,
    );
    if (mimetype.startsWith('video/') && buffer.length > WHATSAPP_VIDEO_MAX_BYTES) {
      throw new BadRequestException(
        `El video pesa ${(buffer.length / 1024 / 1024).toFixed(1)}MB incluso tras comprimirlo; ` +
          'WhatsApp no permite enviar videos de más de 16MB. Probá con un archivo más corto o de menor resolución.',
      );
    }
    const fileName = transcoded ? withMp4Extension(params.file.originalname) : params.file.originalname;

    const timestamp = Date.now();
    const path = `chats/${params.organizationId}/sent_${timestamp}_${fileName}`;
    const mediaUrl = await this.storage.uploadFile('chat-media', path, buffer, mimetype);
    if (!mediaUrl) {
      throw new BadRequestException('No se pudo subir el archivo multimedia');
    }

    const lastUserMessageAt = conv.lastUserMessageAt ? new Date(conv.lastUserMessageAt) : null;

    const { messageId } = await this.whatsapp.sendMediaMessage(params.organizationId, {
      to: conv.contact.phone,
      mediaUrl,
      type: params.type as any,
      fileName,
      lastUserMessageAt,
    });

    const now = new Date();
    const created = await this.prisma.message.create({
      data: {
        conversationId: params.conversationId,
        direction: MessageDirection.OUT,
        type: params.type,
        status: MessageStatus.SENT,
        body: '',
        whatsappMessageId: messageId,
        whatsappTimestamp: now,
        fromAi: false,
        sentByUserId: params.sentByUserId ?? null,
        mediaUrl,
        mimeType: mimetype,
        fileName,
      },
    });

    const msg: Message = {
      id: created.id,
      conversationId: created.conversationId,
      fromUser: false,
      text: created.body,
      timestamp: created.whatsappTimestamp.getTime(),
      fromAi: created.fromAi ?? undefined,
      type: created.type,
      mediaUrl: created.mediaUrl,
      mimeType: created.mimeType,
      fileName: created.fileName,
    };

    this.chatGateway.emitNewMessage(params.organizationId, params.conversationId, msg);
    await this.ensureCampaignAssignment(params.organizationId, conv.contact.id, params.conversationId);
    return msg;
  }

  async generateAiReply(
    organizationId: string,
    conversationId: string,
  ): Promise<{ text: string; usedFallbackModel?: boolean }> {
    await this.assertConversationInOrg(conversationId, organizationId);
    
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { whatsappTimestamp: 'desc' },
      take: 10,
    });
    
    const recent = rows
      .reverse()
      .map((m) => (m.direction === MessageDirection.IN ? `Cliente: ${m.body}` : `Agente: ${m.body}`));
      
    const context = recent.join('\n');
    return this.ai.generateReply(organizationId, context);
  }

  emitMessageStatusUpdate(organizationId: string, conversationId: string, messageId: string, status: string): void {
    this.chatGateway.emitMessageStatusUpdate(organizationId, conversationId, messageId, status);
  }

  emitMessageDeliveryFailed(
    organizationId: string,
    payload: {
      conversationId: string;
      contactPhone: string;
      contactName: string | null;
      category: string;
      label: string;
      detail: string;
    },
  ): void {
    this.chatGateway.emitMessageDeliveryFailed(organizationId, payload);
  }

  async assignConversation(
    conversationId: string,
    organizationId: string,
    assignToUserId: string | null,
  ): Promise<void> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    if (assignToUserId) {
      const user = await this.prisma.user.findFirst({
        where: { id: assignToUserId, organizationId },
      });
      if (!user) throw new BadRequestException('Usuario no encontrado en esta organización');
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        assignedToUserId: assignToUserId,
        assignedAt: assignToUserId ? new Date() : null,
      },
    });

    this.chatGateway.emitConversationAssigned(
      organizationId,
      conversationId,
      assignToUserId || '',
    );
  }

  private async assertConversationAccess(
    conversationId: string,
    organizationId: string,
    userId?: string,
    userRole?: string,
  ): Promise<void> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
      select: { id: true, assignedToUserId: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    if (userRole === 'AGENT' && userId && conv.assignedToUserId !== userId) {
      throw new ForbiddenException('No tienes acceso a esta conversación');
    }
  }

  private readonly fidelDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly processedIncomingMsgIds = new Set<string>();
  private readonly startedAt = new Date();
  private remotePollerTimer: NodeJS.Timeout | null = null;
  private isPollingRemote = false;

  onModuleInit(): void {
    this.remotePollerTimer = setInterval(() => {
      void this.pollRemoteIncomingMessages();
    }, 2500);
  }

  onModuleDestroy(): void {
    if (this.remotePollerTimer) {
      clearInterval(this.remotePollerTimer);
      this.remotePollerTimer = null;
    }
    for (const timer of this.fidelDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.fidelDebounceTimers.clear();
  }

  private async pollRemoteIncomingMessages(): Promise<void> {
    if (this.isPollingRemote) return;
    this.isPollingRemote = true;
    try {
      const recentCutoff = new Date(Date.now() - 30_000);
      const convs = await this.prisma.conversation.findMany({
        where: {
          OR: [
            { isAiActive: true },
            { lastUserMessageAt: { gte: recentCutoff } },
          ],
        },
        include: {
          contact: true,
          messages: {
            orderBy: { whatsappTimestamp: 'desc' },
            take: 1,
          },
        },
      });

      for (const conv of convs) {
        const lastMsg = conv.messages[0];
        if (!lastMsg) continue;
        if (lastMsg.direction !== MessageDirection.IN) continue;
        if (lastMsg.createdAt < this.startedAt) continue;
        if (this.processedIncomingMsgIds.has(lastMsg.id)) continue;

        this.processedIncomingMsgIds.add(lastMsg.id);

        this.chatGateway.emitNewMessage(conv.contact.organizationId, conv.id, {
          id: lastMsg.id,
          conversationId: conv.id,
          fromUser: true,
          text: lastMsg.body,
          timestamp: lastMsg.whatsappTimestamp.getTime(),
          mediaUrl: lastMsg.mediaUrl,
          mimeType: lastMsg.mimeType,
          fileName: lastMsg.fileName,
          type: lastMsg.type,
          status: lastMsg.status,
        } as any);

        if (conv.isAiActive === true) {
          this.logger.log(`Mensaje remoto detectado en conv=${conv.id} con Fidel activo. Disparando respuesta...`);
          this.triggerFidelAutoReply(conv.contact.organizationId, conv.id, conv.contact.phone);
        }
      }
    } catch (err) {
      // Silenciar errores transitorios de red en polling
    } finally {
      this.isPollingRemote = false;
    }
  }

  cancelFidelAutoReply(conversationId: string): void {
    const existing = this.fidelDebounceTimers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
      this.fidelDebounceTimers.delete(conversationId);
    }
  }

  triggerFidelAutoReply(organizationId: string, conversationId: string, contactPhone: string, delayMs = 3000): void {
    this.cancelFidelAutoReply(conversationId);

    const timer = setTimeout(async () => {
      this.fidelDebounceTimers.delete(conversationId);
      try {
        await this.executeFidelReply(organizationId, conversationId, contactPhone);
      } catch (err) {
        this.logger.error(`Error en respuesta automática de Fidel para conv=${conversationId}:`, err);
      }
    }, delayMs);

    this.fidelDebounceTimers.set(conversationId, timer);
  }

  async executeFidelReply(organizationId: string, conversationId: string, contactPhone: string): Promise<Message | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { isAiActive: true },
    });
    if (!conv || !conv.isAiActive) {
      this.logger.log(`Fidel omitido: la conversación ${conversationId} tiene isAiActive=false`);
      return null;
    }

    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { whatsappTimestamp: 'desc' },
      take: 10,
    });

    const ordered = [...rows].reverse();
    const recent = ordered.map((m) =>
      m.direction === MessageDirection.IN ? `Cliente: ${m.body}` : `Fidel: ${m.body}`,
    );
    const context = recent.join('\n');

    const inTraining = await this.isConversationInTrainingMode(conversationId, organizationId);
    let replyText = '';

    if (inTraining) {
      const lastIn = [...ordered].reverse().find((m) => m.direction === MessageDirection.IN);
      const latestText = lastIn?.body || '';
      const trainingResult = await this.ai.processFidelTrainingTurn(
        organizationId,
        context,
        latestText,
        'Entrenador',
      );
      replyText = trainingResult.text?.trim() || '';
      if (trainingResult.learnedRule) {
        this.chatGateway.server?.to(`org:${organizationId}`)?.emit('fidel_rule_learned', {
          conversationId,
          rule: trainingResult.learnedRule,
        });
      }
    } else {
      const result = await this.ai.generateFidelReply(organizationId, context);
      replyText = result.text?.trim() || '';
    }

    if (!replyText) return null;

    let wamid = `fidel_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Si WhatsApp está configurado en la organización, enviar saliente por Cloud API
    try {
      const sent = await this.whatsapp.sendTextMessageRaw(organizationId, contactPhone, replyText);
      if (sent?.messageId) wamid = sent.messageId;
    } catch (err: any) {
      this.logger.warn(`Envío WhatsApp omitido/fallido (${err?.message || err}), guardando localmente`);
    }

    const created = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUT,
        type: MessageType.TEXT,
        status: MessageStatus.SENT,
        body: replyText,
        fromAi: true,
        whatsappMessageId: wamid,
        whatsappTimestamp: new Date(),
      },
    });

    const msgPayload: any = {
      id: created.id,
      conversationId,
      fromUser: false,
      text: replyText,
      timestamp: created.whatsappTimestamp.getTime(),
      type: MessageType.TEXT,
      fromAi: true,
      status: MessageStatus.SENT,
    };

    this.chatGateway.emitNewMessage(organizationId, conversationId, msgPayload);
    return created as any;
  }

  async setConversationAiActive(conversationId: string, organizationId: string, isAiActive: boolean): Promise<boolean> {
    await this.assertConversationInOrg(conversationId, organizationId);
    if (!isAiActive) {
      this.cancelFidelAutoReply(conversationId);
    } else {
      const lastMsg = await this.prisma.message.findFirst({
        where: { conversationId },
        orderBy: { whatsappTimestamp: 'desc' },
        select: { id: true },
      });
      if (lastMsg) {
        this.processedIncomingMsgIds.add(lastMsg.id);
      }
    }
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { isAiActive },
    });
    this.chatGateway.server?.to(`org:${organizationId}`)?.emit('conversation_ai_status_updated', {
      conversationId,
      isAiActive,
    });
    return isAiActive;
  }

  private async getTrainingConversationIds(organizationId: string): Promise<string[]> {
    try {
      const row = await this.prisma.organizationSetting.findUnique({
        where: { organizationId_key: { organizationId, key: 'fidel_training_conversations' } },
      });
      if (!row?.value) return [];
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async isConversationInTrainingMode(conversationId: string, organizationId: string): Promise<boolean> {
    const ids = await this.getTrainingConversationIds(organizationId);
    return ids.includes(conversationId);
  }

  async setConversationTrainingMode(
    conversationId: string,
    organizationId: string,
    isTrainingMode: boolean,
  ): Promise<{ isTrainingMode: boolean; isAiActive: boolean }> {
    await this.assertConversationInOrg(conversationId, organizationId);
    const currentIds = await this.getTrainingConversationIds(organizationId);
    const nextIds = isTrainingMode
      ? Array.from(new Set([...currentIds, conversationId]))
      : currentIds.filter((id) => id !== conversationId);

    await this.prisma.organizationSetting.upsert({
      where: { organizationId_key: { organizationId, key: 'fidel_training_conversations' } },
      create: {
        organizationId,
        key: 'fidel_training_conversations',
        value: JSON.stringify(nextIds),
      },
      update: {
        value: JSON.stringify(nextIds),
      },
    });

    let isAiActive = false;
    if (isTrainingMode) {
      isAiActive = await this.setConversationAiActive(conversationId, organizationId, true);
    } else {
      const c = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { isAiActive: true },
      });
      isAiActive = c?.isAiActive ?? false;
    }

    this.chatGateway.server?.to(`org:${organizationId}`)?.emit('conversation_training_status_updated', {
      conversationId,
      isTrainingMode,
      isAiActive,
    });

    return { isTrainingMode, isAiActive };
  }

  async getFidelRules(organizationId: string) {
    return this.ai.getFidelTrainingRules(organizationId);
  }

  async addFidelRule(
    organizationId: string,
    params: { instruction: string; category?: string; sourceFeedback?: string; createdByName?: string },
  ) {
    const rule = await this.ai.addFidelTrainingRule(organizationId, params);
    this.chatGateway.server?.to(`org:${organizationId}`)?.emit('fidel_rule_learned', { rule });
    return rule;
  }

  async toggleFidelRule(organizationId: string, ruleId: string, isActive: boolean) {
    return this.ai.toggleFidelTrainingRule(organizationId, ruleId, isActive);
  }

  async deleteFidelRule(organizationId: string, ruleId: string) {
    return this.ai.deleteFidelTrainingRule(organizationId, ruleId);
  }

  async runSandboxTrainingTurn(
    organizationId: string,
    history: Array<{ role: 'trainer' | 'fidel'; text: string }>,
    message: string,
    trainerName?: string,
  ) {
    const context = history
      .slice(-10)
      .map((m) => (m.role === 'trainer' ? `Cliente/Entrenador: ${m.text}` : `Fidel: ${m.text}`))
      .join('\n');
    const res = await this.ai.processFidelTrainingTurn(organizationId, context, message, trainerName);
    if (res.learnedRule) {
      this.chatGateway.server?.to(`org:${organizationId}`)?.emit('fidel_rule_learned', {
        rule: res.learnedRule,
      });
    }
    return res;
  }
}

