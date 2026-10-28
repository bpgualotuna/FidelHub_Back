import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelAdapter,
  ChannelSendResult,
  NormalizedIncomingMessage,
  OutgoingChannelMessage,
} from '../channels.types';

@Injectable()
export class TikTokAdapter implements ChannelAdapter {
  readonly channel = 'TIKTOK' as const;
  private readonly logger = new Logger(TikTokAdapter.name);

  parseWebhook(payload: any, organizationId: string): NormalizedIncomingMessage[] {
    const results: NormalizedIncomingMessage[] = [];
    if (!payload) return results;

    // Formato TikTok Business Messaging Webhook (event: 'receive_message' | 'im_receive_msg' o lista events)
    const events = Array.isArray(payload.events)
      ? payload.events
      : payload.content || payload.data || payload.event
        ? [payload]
        : [];

    for (const evt of events) {
      const content = evt.content || evt.data || evt.message || evt;
      const senderId = String(
        content.from_user_id ||
          content.sender_open_id ||
          evt.user_openid ||
          content.sender?.id ||
          'tt_unknown',
      );
      const username =
        content.sender_username ||
        content.sender?.username ||
        evt.username ||
        `@tiktok_${senderId.slice(-5)}`;
      const displayName =
        content.sender_display_name ||
        content.sender?.display_name ||
        username;
      const msgId = String(
        content.message_id || evt.msg_id || evt.log_id || `tt_${Date.now()}`,
      );
      const timestamp = Number(
        content.create_time
          ? Number(content.create_time) < 1e12
            ? Number(content.create_time) * 1000
            : Number(content.create_time)
          : Date.now(),
      );
      const text = String(content.text || content.body || evt.text || '');
      const mediaUrl = content.media_url || content.video_url || content.image_url;

      let type: NormalizedIncomingMessage['type'] = 'TEXT';
      if (content.msg_type === 'image' || content.image_url) type = 'IMAGE';
      else if (content.msg_type === 'video' || content.video_url || content.share_video) type = 'VIDEO';

      results.push({
        channel: 'TIKTOK',
        organizationId,
        externalUserId: senderId,
        externalUsername: username.startsWith('@') ? username : `@${username}`,
        contactName: displayName,
        messageId: msgId,
        timestamp,
        text: text || (type === 'VIDEO' ? '🎵 Compartió un video de TikTok' : '💬 Mensaje directo de TikTok'),
        type,
        mediaUrl,
        metadata: {
          platform: 'TIKTOK',
          tiktokVideoId: content.item_id || content.video_id,
          postLink: content.share_url,
        },
      });
    }

    return results;
  }

  async sendTextMessage(
    params: OutgoingChannelMessage & { accessToken?: string; businessAccountId?: string },
  ): Promise<ChannelSendResult> {
    if (!params.accessToken || !params.businessAccountId) {
      this.logger.debug(
        `[TikTok DM] Modo local/sandbox para OpenID ${params.recipientId} (sin TikTok Business Access Token)`,
      );
      return {
        externalMessageId: `tt_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        deliveredViaApi: false,
      };
    }

    const url = 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Access-Token': params.accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        business_id: params.businessAccountId,
        recipient_open_id: params.recipientId,
        message_type: 'TEXT',
        text: { body: params.text },
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || (data.code && data.code !== 0)) {
      throw new Error(data?.message || `Error enviando DM de TikTok (${res.status})`);
    }

    return {
      externalMessageId: data?.data?.message_id || `tt_out_${Date.now()}`,
      deliveredViaApi: true,
      providerResponse: data,
    };
  }
}
