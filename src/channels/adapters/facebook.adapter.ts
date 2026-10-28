import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutgoingChannelMessage,
} from '../channels.types';

@Injectable()
export class FacebookAdapter implements ChannelAdapter {
  readonly channel = 'FACEBOOK' as const;
  private readonly logger = new Logger(FacebookAdapter.name);

  parseWebhook(payload: any, organizationId: string): NormalizedIncomingMessage[] {
    const results: NormalizedIncomingMessage[] = [];
    if (!payload) return results;

    // Formato oficial de Meta Messenger Platform (object: 'page')
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const messagingList = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const event of messagingList) {
        if (!event.message || event.message.is_echo) continue;
        const senderPsid = String(event.sender?.id || 'fb_unknown');
        const msgId = String(event.message.mid || `fb_${Date.now()}`);
        const timestamp = Number(event.timestamp || Date.now());
        const text = String(event.message.text || '');

        let type: NormalizedIncomingMessage['type'] = 'TEXT';
        let mediaUrl: string | undefined;
        const metadata: Record<string, any> = { platform: 'FACEBOOK' };

        if (Array.isArray(event.message.attachments) && event.message.attachments.length > 0) {
          const att = event.message.attachments[0];
          mediaUrl = att.payload?.url;
          if (att.type === 'image') type = 'IMAGE';
          else if (att.type === 'video') type = 'VIDEO';
          else if (att.type === 'audio') type = 'AUDIO';
          else if (att.type === 'file') type = 'DOCUMENT';
        }

        if (event.referral || event.message?.quick_reply) {
          metadata.referral = event.referral;
          metadata.isQuickReply = Boolean(event.message?.quick_reply);
        }

        results.push({
          channel: 'FACEBOOK',
          organizationId,
          externalUserId: senderPsid,
          externalUsername: event.sender?.name || `fb_${senderPsid.slice(-5)}`,
          contactName: event.sender?.name || `Messenger User ${senderPsid.slice(-4)}`,
          messageId: msgId,
          timestamp,
          text: text || '📎 Adjunto de Facebook Messenger',
          type,
          mediaUrl,
          metadata,
        });
      }
    }

    return results;
  }

  async sendTextMessage(
    params: OutgoingChannelMessage & { accessToken?: string },
  ): Promise<ChannelSendResult> {
    if (!params.accessToken) {
      this.logger.debug(
        `[Facebook Messenger] Modo local/sandbox para PSID ${params.recipientId} (sin Page Access Token)`,
      );
      return {
        externalMessageId: `fb_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        deliveredViaApi: false,
      };
    }

    const url = `https://graph.facebook.com/v21.0/me/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: params.recipientId },
        messaging_type: 'RESPONSE',
        message: { text: params.text },
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Error enviando mensaje por Messenger (${res.status})`);
    }

    return {
      externalMessageId: data.message_id || `fb_out_${Date.now()}`,
      deliveredViaApi: true,
      providerResponse: data,
    };
  }
}
