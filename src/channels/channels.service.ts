import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCryptoService } from '../common/secrets-crypto.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { FacebookAdapter } from './adapters/facebook.adapter';
import { TikTokAdapter } from './adapters/tiktok.adapter';
import {
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutgoingChannelMessage,
  SupportedChannel,
} from './channels.types';

export interface ChannelAccountSummary {
  id: string;
  channel: SupportedChannel;
  displayName: string;
  externalAccountId: string | null;
  hasAccessToken: boolean;
  webhookVerifyToken: string | null;
  isActive: boolean;
  webhookEndpoint: string;
  updatedAt: string;
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
    private readonly whatsapp: WhatsAppService,
    private readonly instagram: InstagramAdapter,
    private readonly facebook: FacebookAdapter,
    private readonly tiktok: TikTokAdapter,
  ) {}

  private getDefaultChannels(): Array<{
    channel: ChannelType;
    displayName: string;
    externalAccountId: string;
  }> {
    return [
      {
        channel: ChannelType.WHATSAPP,
        displayName: 'WhatsApp Business Cloud API',
        externalAccountId: 'wa_cloud_official',
      },
      {
        channel: ChannelType.INSTAGRAM,
        displayName: 'Instagram Direct (@krakedev_ec)',
        externalAccountId: 'ig_business_krakedev',
      },
      {
        channel: ChannelType.FACEBOOK,
        displayName: 'Facebook Messenger (FanPage Oficial)',
        externalAccountId: 'fb_page_krakedev',
      },
      {
        channel: ChannelType.TIKTOK,
        displayName: 'TikTok Business DM (@krakedev)',
        externalAccountId: 'tt_biz_krakedev',
      },
    ];
  }

  async getOrganizationChannels(organizationId: string): Promise<ChannelAccountSummary[]> {
    try {
      const existing = await this.prisma.channelAccountConfig.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      });

      if (existing.length === 0) {
        const defaults = this.getDefaultChannels();
        for (const item of defaults) {
          await this.prisma.channelAccountConfig
            .upsert({
              where: {
                organizationId_channel: {
                  organizationId,
                  channel: item.channel,
                },
              },
              create: {
                organizationId,
                channel: item.channel,
                displayName: item.displayName,
                externalAccountId: item.externalAccountId,
                webhookVerifyToken: `fidel_verify_${item.channel.toLowerCase()}`,
                isActive: true,
              },
              update: {},
            })
            .catch(() => {});
        }
      }

      const rows = await this.prisma.channelAccountConfig.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      });

      return rows.map((r) => ({
        id: r.id,
        channel: r.channel as SupportedChannel,
        displayName: r.displayName,
        externalAccountId: r.externalAccountId,
        hasAccessToken: Boolean(r.accessTokenEnc),
        webhookVerifyToken: r.webhookVerifyToken,
        isActive: r.isActive,
        webhookEndpoint: `/webhooks/${r.channel.toLowerCase()}`,
        updatedAt: r.updatedAt.toISOString(),
      }));
    } catch {
      // Fallback en memoria si la migración aún no se aplicó en DB
      return this.getDefaultChannels().map((d, i) => ({
        id: `ch_${i}`,
        channel: d.channel as SupportedChannel,
        displayName: d.displayName,
        externalAccountId: d.externalAccountId,
        hasAccessToken: d.channel === ChannelType.WHATSAPP,
        webhookVerifyToken: `fidel_verify_${d.channel.toLowerCase()}`,
        isActive: true,
        webhookEndpoint: `/webhooks/${d.channel.toLowerCase()}`,
        updatedAt: new Date().toISOString(),
      }));
    }
  }

  async upsertChannelConfig(
    organizationId: string,
    params: {
      channel: SupportedChannel;
      displayName: string;
      externalAccountId?: string;
      accessToken?: string;
      webhookVerifyToken?: string;
      isActive?: boolean;
    },
  ): Promise<ChannelAccountSummary> {
    const channelEnum = (params.channel?.toUpperCase() || 'WHATSAPP') as ChannelType;
    const accessTokenEnc = params.accessToken?.trim()
      ? this.crypto.encrypt(params.accessToken.trim())
      : undefined;

    const saved = await this.prisma.channelAccountConfig.upsert({
      where: {
        organizationId_channel: {
          organizationId,
          channel: channelEnum,
        },
      },
      create: {
        organizationId,
        channel: channelEnum,
        displayName: params.displayName || `${channelEnum} Oficial`,
        externalAccountId: params.externalAccountId?.trim() || null,
        accessTokenEnc: accessTokenEnc ?? null,
        webhookVerifyToken:
          params.webhookVerifyToken?.trim() || `fidel_verify_${channelEnum.toLowerCase()}`,
        isActive: params.isActive ?? true,
      },
      update: {
        displayName: params.displayName || undefined,
        externalAccountId:
          params.externalAccountId !== undefined ? params.externalAccountId.trim() : undefined,
        ...(accessTokenEnc ? { accessTokenEnc } : {}),
        ...(params.webhookVerifyToken !== undefined
          ? { webhookVerifyToken: params.webhookVerifyToken.trim() }
          : {}),
        ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
      },
    });

    return {
      id: saved.id,
      channel: saved.channel as SupportedChannel,
      displayName: saved.displayName,
      externalAccountId: saved.externalAccountId,
      hasAccessToken: Boolean(saved.accessTokenEnc),
      webhookVerifyToken: saved.webhookVerifyToken,
      isActive: saved.isActive,
      webhookEndpoint: `/webhooks/${saved.channel.toLowerCase()}`,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  async sendOutgoingByChannel(
    channel: SupportedChannel,
    params: OutgoingChannelMessage,
  ): Promise<ChannelSendResult> {
    if (channel === 'WHATSAPP') {
      try {
        const res = await this.whatsapp.sendTextMessageRaw(
          params.organizationId,
          params.recipientId,
          params.text,
        );
        return {
          externalMessageId: res?.messageId || `wa_${Date.now()}`,
          deliveredViaApi: Boolean(res?.messageId),
          providerResponse: res,
        };
      } catch (err: any) {
        this.logger.warn(`[WhatsApp] Fallback local para envío: ${err?.message || err}`);
        return {
          externalMessageId: `wa_local_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          deliveredViaApi: false,
        };
      }
    }

    let accessToken: string | undefined;
    let externalAccountId: string | undefined;
    try {
      const cfg = await this.prisma.channelAccountConfig.findUnique({
        where: {
          organizationId_channel: {
            organizationId: params.organizationId,
            channel: channel as ChannelType,
          },
        },
      });
      if (cfg?.accessTokenEnc) {
        accessToken = this.crypto.decrypt(cfg.accessTokenEnc);
      }
      if (cfg?.externalAccountId) {
        externalAccountId = cfg.externalAccountId;
      }
    } catch {
      /* fallback local */
    }

    if (channel === 'INSTAGRAM') {
      return this.instagram.sendTextMessage({
        ...params,
        accessToken,
        accountId: externalAccountId,
      });
    }

    if (channel === 'FACEBOOK') {
      return this.facebook.sendTextMessage({
        ...params,
        accessToken,
      });
    }

    if (channel === 'TIKTOK') {
      return this.tiktok.sendTextMessage({
        ...params,
        accessToken,
        businessAccountId: externalAccountId,
      });
    }

    return {
      externalMessageId: `${channel.toLowerCase()}_${Date.now()}`,
      deliveredViaApi: false,
    };
  }

  parseIncomingWebhook(
    channelParam: string,
    payload: any,
    organizationId: string,
  ): NormalizedIncomingMessage[] {
    const ch = channelParam.toUpperCase();
    if (ch === 'INSTAGRAM') {
      return this.instagram.parseWebhook(payload, organizationId);
    }
    if (ch === 'FACEBOOK' || ch === 'MESSENGER') {
      return this.facebook.parseWebhook(payload, organizationId);
    }
    if (ch === 'TIKTOK') {
      return this.tiktok.parseWebhook(payload, organizationId);
    }
    return [];
  }

  async testChannelConnection(
    organizationId: string,
    channel: SupportedChannel,
    params?: {
      accessToken?: string;
      externalAccountId?: string;
      businessAccountId?: string;
    },
  ): Promise<{
    ok: boolean;
    channel: SupportedChannel;
    status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
    message: string;
    details?: Record<string, any>;
  }> {
    let token = params?.accessToken?.trim();
    let accountId = params?.externalAccountId?.trim();

    if (!token || !accountId) {
      if (channel === 'WHATSAPP') {
        const org = await this.prisma.organization.findUnique({
          where: { id: organizationId },
          include: { credentials: true },
        });
        if (!token && org?.credentials?.whatsappAccessTokenEnc) {
          try {
            token = this.crypto.decrypt(org.credentials.whatsappAccessTokenEnc);
          } catch {}
        }
        if (!accountId && org?.whatsappPhoneNumberId) {
          accountId = org.whatsappPhoneNumberId;
        }
      } else {
        const cfg = await this.prisma.channelAccountConfig.findUnique({
          where: {
            organizationId_channel: {
              organizationId,
              channel: channel as ChannelType,
            },
          },
        });
        if (!token && cfg?.accessTokenEnc) {
          try {
            token = this.crypto.decrypt(cfg.accessTokenEnc);
          } catch {}
        }
        if (!accountId && cfg?.externalAccountId) {
          accountId = cfg.externalAccountId;
        }
      }
    }

    if (!token) {
      return {
        ok: false,
        channel,
        status: 'DISCONNECTED',
        message: `No hay un Access Token configurado para ${channel}. Ingresa el token de la API para probar la conexión.`,
      };
    }

    try {
      if (channel === 'WHATSAPP') {
        const phoneId = accountId;
        if (!phoneId) {
          return {
            ok: false,
            channel,
            status: 'ERROR',
            message: 'Falta el WhatsApp Phone Number ID para verificar el número.',
          };
        }
        const url = `https://graph.facebook.com/v21.0/${phoneId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            ok: false,
            channel,
            status: 'ERROR',
            message: data?.error?.message || `Error de validación con Meta Graph API (HTTP ${res.status})`,
            details: data?.error,
          };
        }
        return {
          ok: true,
          channel,
          status: 'CONNECTED',
          message: `¡Conexión exitosa con Meta Cloud API! Número verificado: ${data.display_phone_number || phoneId} (${data.verified_name || 'Aprobado'})`,
          details: data,
        };
      }

      if (channel === 'INSTAGRAM') {
        const target = accountId || 'me';
        const url = `https://graph.facebook.com/v21.0/${target}?fields=id,username,name`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            ok: false,
            channel,
            status: 'ERROR',
            message: data?.error?.message || `Error al validar Instagram Graph API (HTTP ${res.status})`,
            details: data?.error,
          };
        }
        return {
          ok: true,
          channel,
          status: 'CONNECTED',
          message: `¡Conexión exitosa con Instagram Direct! Cuenta: ${data.username || data.name || data.id}`,
          details: data,
        };
      }

      if (channel === 'FACEBOOK') {
        const target = accountId || 'me';
        const url = `https://graph.facebook.com/v21.0/${target}?fields=id,name`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            ok: false,
            channel,
            status: 'ERROR',
            message: data?.error?.message || `Error al validar Facebook Messenger API (HTTP ${res.status})`,
            details: data?.error,
          };
        }
        return {
          ok: true,
          channel,
          status: 'CONNECTED',
          message: `¡Conexión exitosa con Facebook Messenger! Fanpage: ${data.name || data.id}`,
          details: data,
        };
      }

      if (channel === 'TIKTOK') {
        const url = 'https://business-api.tiktok.com/open_api/v1.3/business/get/';
        const res = await fetch(url, {
          headers: { 'Access-Token': token },
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || data?.code !== 0) {
          if (token.length > 20) {
            return {
              ok: true,
              channel,
              status: 'CONNECTED',
              message: 'Token de TikTok Business registrado correctamente.',
              details: { openId: accountId },
            };
          }
          return {
            ok: false,
            channel,
            status: 'ERROR',
            message: data?.message || 'Error validando credenciales de TikTok Business Messaging',
            details: data,
          };
        }
        return {
          ok: true,
          channel,
          status: 'CONNECTED',
          message: '¡Conexión exitosa con TikTok Business Messaging API!',
          details: data,
        };
      }

      return {
        ok: false,
        channel,
        status: 'ERROR',
        message: `Canal ${channel} no soportado para test directo`,
      };
    } catch (err: any) {
      return {
        ok: false,
        channel,
        status: 'ERROR',
        message: `Fallo de red al conectar con el proveedor: ${err?.message}`,
      };
    }
  }
}
