export type SupportedChannel =
  | 'WHATSAPP'
  | 'INSTAGRAM'
  | 'FACEBOOK'
  | 'TIKTOK'
  | 'WEBCHAT'
  | 'TELEGRAM';

export interface NormalizedIncomingMessage {
  channel: SupportedChannel;
  organizationId: string;
  externalUserId: string;
  externalUsername?: string;
  contactName?: string;
  avatarUrl?: string;
  messageId: string;
  timestamp: number;
  text: string;
  type?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  metadata?: {
    platform?: string;
    storyUrl?: string;
    reelUrl?: string;
    postLink?: string;
    isStoryReply?: boolean;
    isQuickReply?: boolean;
    [key: string]: any;
  };
}

export interface OutgoingChannelMessage {
  organizationId: string;
  recipientId: string;
  text: string;
  mediaUrl?: string;
  mediaType?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  metadata?: Record<string, any>;
}

export interface ChannelSendResult {
  externalMessageId: string;
  deliveredViaApi: boolean;
  providerResponse?: any;
}

export interface ChannelAdapter {
  readonly channel: SupportedChannel;
  parseWebhook(payload: any, organizationId: string): NormalizedIncomingMessage[];
  sendTextMessage(params: OutgoingChannelMessage): Promise<ChannelSendResult>;
}
