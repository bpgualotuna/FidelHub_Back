import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutgoingChannelMessage,
} from '../channels.types';

@Injectable()
export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'INSTAGRAM' as const;
  private readonly logger = new Logger(InstagramAdapter.name);

  parseWebhook(payload: any, organizationId: string): NormalizedIncomingMessage[] {
    const results: NormalizedIncomingMessage[] = [];
    if (!payload) return results;

    // Formato oficial de Meta Graph API para Instagram Messaging (object: 'instagram')
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const messagingList = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const event of messagingList) {
        if (!event.message || event.message.is_echo) continue;
        const senderId = String(event.sender?.id || 'ig_unknown');
        const msgId = String(event.message.mid || `ig_${Date.now()}`);
        const timestamp = Number(event.timestamp || Date.now());
        const text = String(event.message.text || '');

        let type: NormalizedIncomingMessage['type'] = 'TEXT';
        let mediaUrl: string | undefined;
        const metadata: Record<string, any> = { platform: 'INSTAGRAM' };

        if (Array.isArray(event.message.attachments) && event.message.attachments.length > 0) {
          const att = event.message.attachments[0];
          mediaUrl = att.payload?.url;
          if (att.type === 'image') type = 'IMAGE';
          else if (att.type === 'video' || att.type === 'ig_reel') {
            type = 'VIDEO';
            metadata.reelUrl = mediaUrl;
          } else if (att.type === 'audio') type = 'AUDIO';
          else if (att.type === 'story_mention') {
            metadata.storyUrl = mediaUrl;
            metadata.isStoryReply = true;
          }
        }

        if (event.message.reply_to?.story) {
          metadata.isStoryReply = true;
          metadata.storyUrl = event.message.reply_to.story.url;
        }

        results.push({
          channel: 'INSTAGRAM',
          organizationId,
          externalUserId: senderId,
          externalUsername: event.sender?.username || `@ig_${senderId.slice(-5)}`,
          contactName: event.sender?.name || event.sender?.username || `Instagram User ${senderId.slice(-4)}`,
          messageId: msgId,
          timestamp,
          text: text || (metadata.isStoryReply ? '📸 Respondió a tu historia de Instagram' : '📎 Adjunto de Instagram'),
          type,
          mediaUrl,
          metadata,
        });
      }
    }

    return results;
  }

  async sendTextMessage(
    params: OutgoingChannelMessage & { accessToken?: string; accountId?: string },
  ): Promise<ChannelSendResult> {
    if (!params.accessToken || !params.accountId) {
      this.logger.debug(
        `[Instagram] Modo local/sandbox para destinatario ${params.recipientId} (sin token de Graph API activo)`,
      );
      return {
        externalMessageId: `ig_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        deliveredViaApi: false,
      };
    }

    const url = `https://graph.facebook.com/v21.0/${params.accountId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: params.recipientId },
        message: { text: params.text },
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Error enviando DM de Instagram (${res.status})`);
    }

    return {
      externalMessageId: data.message_id || `ig_out_${Date.now()}`,
      deliveredViaApi: true,
      providerResponse: data,
    };
  }
}
