import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { Message } from './chat.service';
import type { JwtPayload } from '../auth/auth.types';

export interface NewMessagePayload {
  conversationId: string;
  message: {
    id: string;
    conversationId: string;
    fromUser: boolean;
    text: string;
    timestamp: number;
    fromAi?: boolean;
    status?: string;
    type?: string;
    mediaUrl?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    replyTo?: {
      id: string;
      text: string;
      fromUser: boolean;
      type?: string;
      mediaUrl?: string | null;
    } | null;
    isReply?: boolean;
    referral?: any;
  };
  companyId?: string;
}

type SocketUserData = {
  userId?: string;
  organizationId?: string | null;
  email?: string;
  currentConversationId?: string;
};

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private data(client: Socket): SocketUserData {
    return client.data as SocketUserData;
  }

  private verifyClient(client: Socket): JwtPayload | null {
    const raw =
      (client.handshake.auth as { token?: string } | undefined)?.token ||
      (typeof client.handshake.query.token === 'string' ? client.handshake.query.token : undefined);
    if (!raw) return null;
    try {
      return this.jwt.verify<JwtPayload>(raw);
    } catch {
      return null;
    }
  }

  handleConnection(client: Socket) {
    this.logger.debug('Cliente WebSocket conectado');
    const payload = this.verifyClient(client);
    if (!payload) return;
    const d = this.data(client);
    d.userId = payload.sub;
    d.organizationId = payload.organizationId;
    d.email = payload.email;
    if (payload.organizationId) {
      void client.join(`org:${payload.organizationId}`);
    }
    void client.join(`user:${payload.sub}`);
  }

  handleDisconnect(client: Socket) {
    const d = this.data(client);
    if (d.currentConversationId && d.userId) {
      client.to(`conversation:${d.currentConversationId}`).emit('presence', {
        conversationId: d.currentConversationId,
        userId: d.userId,
        displayName: d.email ?? d.userId,
        state: 'left' as const,
      });
    }
    this.logger.debug('Cliente WebSocket desconectado');
  }

  @SubscribeMessage('join_conversation')
  async joinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ ok: boolean }> {
    const payload = this.verifyClient(client);
    if (!payload?.organizationId || !body?.conversationId) return { ok: false };
    const conv = await this.prisma.conversation.findFirst({
      where: { id: body.conversationId, contact: { organizationId: payload.organizationId } },
      select: { id: true },
    });
    if (!conv) return { ok: false };

    const d = this.data(client);
    const prev = d.currentConversationId;
    if (prev && prev !== body.conversationId) {
      await client.leave(`conversation:${prev}`);
      client.to(`conversation:${prev}`).emit('presence', {
        conversationId: prev,
        userId: payload.sub,
        displayName: payload.email,
        state: 'left' as const,
      });
    }
    await client.join(`conversation:${body.conversationId}`);
    d.currentConversationId = body.conversationId;
    client.to(`conversation:${body.conversationId}`).emit('presence', {
      conversationId: body.conversationId,
      userId: payload.sub,
      displayName: payload.email,
      state: 'in_chat' as const,
    });
    return { ok: true };
  }

  @SubscribeMessage('leave_conversation')
  async leaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ ok: boolean }> {
    const payload = this.verifyClient(client);
    if (!payload?.organizationId || !body?.conversationId) return { ok: false };
    const d = this.data(client);
    await client.leave(`conversation:${body.conversationId}`);
    if (d.currentConversationId === body.conversationId) {
      d.currentConversationId = undefined;
    }
    client.to(`conversation:${body.conversationId}`).emit('presence', {
      conversationId: body.conversationId,
      userId: payload.sub,
      displayName: payload.email,
      state: 'left' as const,
    });
    return { ok: true };
  }

  @SubscribeMessage('typing_start')
  async typingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ ok: boolean }> {
    const payload = this.verifyClient(client);
    if (!payload?.organizationId || !body?.conversationId) return { ok: false };
    const ok = await this.prisma.conversation.findFirst({
      where: { id: body.conversationId, contact: { organizationId: payload.organizationId } },
      select: { id: true },
    });
    if (!ok) return { ok: false };
    client.to(`conversation:${body.conversationId}`).emit('typing', {
      conversationId: body.conversationId,
      userId: payload.sub,
      displayName: payload.email,
      typing: true,
    });
    return { ok: true };
  }

  @SubscribeMessage('typing_stop')
  async typingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ ok: boolean }> {
    const payload = this.verifyClient(client);
    if (!payload?.organizationId || !body?.conversationId) return { ok: false };
    client.to(`conversation:${body.conversationId}`).emit('typing', {
      conversationId: body.conversationId,
      userId: payload.sub,
      displayName: payload.email,
      typing: false,
    });
    return { ok: true };
  }

  emitNewMessage(organizationId: string, conversationId: string, message: Message): void {
    const payload: NewMessagePayload = {
      conversationId,
      message: {
        id: message.id,
        conversationId: message.conversationId,
        fromUser: message.fromUser,
        text: message.text,
        timestamp: message.timestamp,
        fromAi: message.fromAi,
        status: message.status,
        type: message.type,
        mediaUrl: message.mediaUrl,
        mimeType: message.mimeType,
        fileName: message.fileName,
        replyTo: message.replyTo,
        isReply: message.isReply,
      },
      companyId: organizationId,
    };
    this.server.to(`org:${organizationId}`).emit('new_message', payload);
  }

  emitConversationRead(organizationId: string, conversationId: string): void {
    this.server.to(`org:${organizationId}`).emit('conversation_read', { conversationId });
  }

  emitConversationAssigned(organizationId: string, conversationId: string, assignedToUserId: string): void {
    this.server.to(`org:${organizationId}`).emit('conversation_assigned', {
      conversationId,
      assignedToUserId,
    });
    if (assignedToUserId) {
      this.server.to(`user:${assignedToUserId}`).emit('conversation_assigned_to_me', {
        conversationId,
      });
    }
  }

  emitBroadcastStarted(organizationId: string, total: number): void {
    this.server.to(`org:${organizationId}`).emit('broadcast_started', { total });
  }

  emitBroadcastMessageSent(organizationId: string, conversationId: string, index: number): void {
    this.server.to(`org:${organizationId}`).emit('broadcast_message_sent', { conversationId, index });
  }

  emitBroadcastCompleted(
    organizationId: string,
    result: { sent: number; failed: number; errors: Array<{ conversationId: string; error: string }> },
  ): void {
    this.server.to(`org:${organizationId}`).emit('broadcast_completed', result);
  }

  emitMessageEdited(organizationId: string, conversationId: string, messageId: string, newText: string): void {
    const payload = {
      conversationId,
      messageId,
      newText,
    };
    this.server.to(`org:${organizationId}`).emit('message_edited', payload);
  }

  emitMessageStatusUpdate(organizationId: string, conversationId: string, messageId: string, status: string): void {
    this.server.to(`org:${organizationId}`).emit('message_status', {
      conversationId,
      messageId,
      status,
    });
  }

  emitBroadcastMessageFailed(
    organizationId: string,
    conversationId: string,
    index: number,
    errorMessage: string,
  ): void {
    const p = { conversationId, index, errorMessage };
    this.server.to(`org:${organizationId}`).emit('broadcast_message_failed', p);
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
    this.server.to(`org:${organizationId}`).emit('message_delivery_failed', payload);
  }
}
