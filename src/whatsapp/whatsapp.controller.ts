import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { Response } from 'express';
import { WhatsAppService } from './whatsapp.service';
import { ChatService } from '../chat/chat.service';
import { StorageService } from '../common/storage.service';
import { classifyWhatsAppFailure } from '../common/whatsapp-error-catalog.util';
import { MessageType, MessageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { extname } from 'path';

const mimeExtensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

function fileExtension(fileName: unknown, mimeType: string): string {
  if (typeof fileName === 'string') {
    const extension = extname(fileName).toLowerCase();
    if (/^\.[a-z0-9]{1,20}$/.test(extension)) return extension;
  }
  return mimeExtensions[mimeType.toLowerCase()] || '.bin';
}

@Controller('whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ChatService)) private readonly chat: ChatService,
  ) {}

  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const result = this.whatsapp.verifyWebhook(mode, token, challenge);
    if (result != null) {
      return res.status(200).send(result);
    }
    throw new UnauthorizedException('Token de verificación inválido');
  }

  @Post('webhook')
  async webhook(@Body() body: Record<string, unknown>, @Res() res: Response) {
    res.status(200).send('OK');

    try {
      const fs = require('fs');
      fs.appendFileSync('webhook-debug.log', JSON.stringify({ timestamp: new Date().toISOString(), body }, null, 2) + '\n---\n');
    } catch (e) {}

    const value = body as { object?: string; entry?: Array<Record<string, unknown>> };
    if (value.object !== 'whatsapp_business_account' || !Array.isArray(value.entry)) return;

    for (const entry of value.entry) {
      const changes = entry.changes as
        | Array<{ field?: string; value?: Record<string, unknown> }>
        | undefined;
      if (!changes) continue;
      for (const change of changes) {
        if (change.field === 'phone_number_quality_update') {
          const qualityVal = change.value as
            | { event?: string; current_limit?: string; display_phone_number?: string }
            | undefined;
          this.logger.log(
            `phone_number_quality_update recibido: event=${qualityVal?.event} current_limit=${qualityVal?.current_limit} display_phone_number=${qualityVal?.display_phone_number}`,
          );
          // No trae phone_number_id, así que no se puede mapear a una sola organización con certeza;
          // se re-sincroniza el tier real de todas las organizaciones configuradas.
          this.whatsapp.resyncAllOrganizationsMessagingLimit().catch((err) =>
            this.logger.error('Error re-sincronizando tiers tras phone_number_quality_update', err),
          );
          continue;
        }

        const val = change.value as
          | {
              contacts?: Array<{
                profile?: { name: string };
                wa_id: string;
              }>;
              messages?: Array<{
                from: string;
                id: string;
                timestamp: string;
                type: string;
                text?: { body: string };
                button?: { text: string; payload?: string };
                interactive?: {
                  type: string;
                  button_reply?: { id: string; title: string };
                  list_reply?: { id: string; title: string };
                };
                context?: { from: string; id: string; referral?: Record<string, unknown> };
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
                  [key: string]: unknown;
                };
              }>;
              statuses?: Array<{
                id: string;
                status: string;
                timestamp: string;
                recipient_id: string;
                errors?: Array<{
                  code: number;
                  title?: string;
                  message?: string;
                  error_data?: { details?: string };
                }>;
              }>;
              metadata?: { phone_number_id?: string };
            }
          | undefined;
        if (!val) continue;
        const phoneNumberId = val.metadata?.phone_number_id;
        const organizationId =
          await this.whatsapp.resolveOrganizationIdFromWebhookPhoneNumberId(phoneNumberId);
        if (!organizationId) {
          this.logger.warn(`Webhook sin organización para phone_number_id=${phoneNumberId}`);
          continue;
        }

        // Procesar actualizaciones de estado (sent, delivered, read)
        if (val.statuses?.length) {
          for (const st of val.statuses) {
            try {
              const failureInfo = st.status === 'failed' && st.errors?.length ? st.errors[0] : null;
              if (failureInfo) {
                this.logger.error(
                  `Mensaje ${st.id} falló para ${st.recipient_id}: ${st.errors!
                    .map((e) => `[${e.code}] ${e.title || ''} ${e.message || ''} ${e.error_data?.details || ''}`.trim())
                    .join(' | ')}`,
                );
              }

              const msg = await this.prisma.message.findFirst({
                where: { whatsappMessageId: st.id },
                include: { conversation: { include: { contact: true } } },
              });

              if (msg) {
                const newStatus = this.mapWhatsappStatus(st.status);
                if (newStatus) {
                  const progress = { SENT: 1, DELIVERED: 2, READ: 3 } as Record<string, number>;
                  const shouldApply = newStatus === MessageStatus.FAILED
                    ? msg.status !== MessageStatus.READ && msg.status !== MessageStatus.DELIVERED
                    : msg.status !== MessageStatus.FAILED && (progress[newStatus] ?? 0) >= (progress[msg.status] ?? 0);
                  if (!shouldApply) continue;
                  const classification = newStatus === MessageStatus.FAILED
                    ? classifyWhatsAppFailure({ code: failureInfo?.code, message: failureInfo?.message })
                    : null;

                  await this.prisma.message.update({
                    where: { id: msg.id },
                    data: {
                      status: newStatus,
                      ...(classification
                        ? { errorCategory: classification.category, errorDetail: failureInfo?.message || failureInfo?.title || '' }
                        : {}),
                    },
                  });
                  this.chat.emitMessageStatusUpdate(
                    organizationId,
                    msg.conversationId,
                    msg.id,
                    newStatus,
                  );

                  if (classification) {
                    this.chat.emitMessageDeliveryFailed(organizationId, {
                      conversationId: msg.conversationId,
                      contactPhone: msg.conversation.contact.phone,
                      contactName: msg.conversation.contact.name,
                      category: classification.category,
                      label: classification.label,
                      detail: failureInfo?.message || failureInfo?.title || 'Error desconocido',
                    });

                    // El BroadcastLog de este mensaje se escribió como 'sent' al momento del envío
                    // (WhatsApp lo había aceptado); este es el único punto donde se entera el motivo
                    // real de rechazo (spam/experimento/etc.), así que se corrige acá para que
                    // "Masivos Enviados" muestre el resultado real, no el estado inicial optimista.
                    await this.prisma.broadcastLog.updateMany({
                      where: { messageId: msg.id },
                      data: {
                        status: 'failed',
                        failureCategory: classification.category,
                        errorMessage: failureInfo?.message || failureInfo?.title || 'Error desconocido',
                      },
                    });
                  }
                }
              }
            } catch (err) {
              this.logger.error(`Error actualizando estado de mensaje ${st.id}:`, err);
            }
          }
        }

        if (!val.messages) continue;
        const contactsList = val.contacts || [];
        for (const msg of val.messages) {
          const pushName = contactsList.find(c => c.wa_id === msg.from)?.profile?.name;
          const isMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(msg.type);
          const referral = msg.referral || (msg as any).context?.referral || undefined;

          this.logger.log(
            `Mensaje entrante type=${msg.type} context=${JSON.stringify((msg as any).context)} referral=${JSON.stringify(referral)}`,
          );

          if (msg.type === 'text' && msg.text?.body) {
            await this.chat.registerIncomingMessage({
              organizationId,
              from: msg.from,
              contactName: pushName,
              messageId: msg.id,
              timestamp: parseInt(msg.timestamp, 10) * 1000,
              text: msg.text.body,
              type: MessageType.TEXT,
              replyToWamid: msg.context?.id,
              referral,
            });
          } else if (msg.type === 'button' && msg.button?.text) {
            await this.chat.registerIncomingMessage({
              organizationId,
              from: msg.from,
              contactName: pushName,
              messageId: msg.id,
              timestamp: parseInt(msg.timestamp, 10) * 1000,
              text: msg.button.text,
              type: MessageType.TEXT,
              replyToWamid: msg.context?.id,
              referral,
              quickReply: true,
            });
          } else if (msg.type === 'interactive' && (msg.interactive?.button_reply || msg.interactive?.list_reply)) {
            const replyText = msg.interactive.button_reply?.title || msg.interactive.list_reply?.title || '';
            await this.chat.registerIncomingMessage({
              organizationId,
              from: msg.from,
              contactName: pushName,
              messageId: msg.id,
              timestamp: parseInt(msg.timestamp, 10) * 1000,
              text: replyText,
              type: MessageType.TEXT,
              replyToWamid: msg.context?.id,
              referral,
              quickReply: !!msg.interactive.button_reply,
            });
          } else if (isMedia) {
            const mediaData = (msg as any)[msg.type];
            if (mediaData && mediaData.id) {
              const mediaId = mediaData.id;
              const downloaded = await this.whatsapp.downloadMedia(mediaId, organizationId);
              if (downloaded) {
                // Preserve the original extension. Structured MIME subtypes are not file extensions.
                const extension = fileExtension(mediaData.filename, downloaded.mimeType);
                const path = `chats/${organizationId}/${mediaId}${extension}`;
                const mediaUrl = await this.storage.uploadFile('chat-media', path, downloaded.buffer, downloaded.mimeType);
                if (mediaUrl) {
                  let dbType: MessageType = msg.type.toUpperCase() as MessageType;
                  if (msg.type === 'sticker') {
                    dbType = MessageType.IMAGE;
                  }
                  await this.chat.registerIncomingMessage({
                    organizationId,
                    from: msg.from,
                    contactName: pushName,
                    messageId: msg.id,
                    timestamp: parseInt(msg.timestamp, 10) * 1000,
                    text: mediaData.caption || '',
                    type: dbType,
                    mediaUrl,
                    mimeType: downloaded.mimeType,
                    fileName: mediaData.filename || undefined,
                    replyToWamid: msg.context?.id,
                    referral,
                  });
                } else {
                  this.logger.error(`No se pudo subir a Supabase el archivo de WhatsApp ${mediaId}`);
                }
              } else {
                this.logger.error(`No se pudo descargar de WhatsApp el archivo ${mediaId}`);
              }
            }
          }
        }
      }
    }
  }

  @Post('sync-limit')
  @UseGuards(JwtAuthGuard)
  async syncLimit(@CurrentUser() user: AuthUser) {
    return this.whatsapp.syncMessagingLimit(user.organizationId!);
  }

  private mapWhatsappStatus(status: string): MessageStatus | null {
    switch (status) {
      case 'sent': return MessageStatus.SENT;
      case 'delivered': return MessageStatus.DELIVERED;
      case 'read': return MessageStatus.READ;
      case 'failed': return MessageStatus.FAILED;
      default: return null;
    }
  }
}
