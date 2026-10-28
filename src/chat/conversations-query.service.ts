import { Injectable } from '@nestjs/common';
import { MessageDirection, MessageType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Conversation } from './chat.service';

@Injectable()
export class ConversationsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async searchByMessage(
    organizationId: string,
    query: string,
    userId?: string,
    userRole?: string,
  ): Promise<Array<{ conversationId: string; message: string }>> {
    const text = query.trim().slice(0, 120);
    if (text.length < 2) return [];

    const messageFilter = { body: { contains: text, mode: 'insensitive' as const } };
    const conversations = await this.prisma.conversation.findMany({
      where: {
        contact: { organizationId },
        ...(userRole === 'AGENT' && userId ? { assignedToUserId: userId } : {}),
        messages: { some: messageFilter },
      },
      select: {
        id: true,
        messages: {
          where: messageFilter,
          orderBy: { whatsappTimestamp: 'desc' },
          take: 1,
          select: { body: true },
        },
      },
    });
    return conversations.map((conversation) => {
      const body = conversation.messages[0].body;
      const matchAt = body.toLowerCase().indexOf(text.toLowerCase());
      const start = Math.max(0, matchAt - 35);
      const end = Math.min(body.length, start + 100);
      return {
        conversationId: conversation.id,
        message: `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`,
      };
    });
  }

  async getConversations(
    organizationId: string,
    userId?: string,
    userRole?: string,
    channelFilter?: string,
  ): Promise<Conversation[]> {
    const where: any = { contact: { organizationId } };

    if (userRole === 'AGENT' && userId) {
      where.assignedToUserId = userId;
    }
    if (channelFilter && channelFilter !== 'ALL') {
      where.channel = channelFilter.toUpperCase();
    }

    const list = await this.prisma.conversation.findMany({
      where,
      include: {
        contact: { include: { tag: true } },
        messages: {
          orderBy: { whatsappTimestamp: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const unreadCounts = await this.getUnreadCountsBulk(list.map((c) => c.id));
    const withUnread = list.map((c) => {
      const lastMsg = c.messages[0];
      const unreadCount = unreadCounts.get(c.id) ?? 0;
      return {
        id: c.id,
        phone: c.contact.phone,
        name: c.contact.name ?? undefined,
        email: c.contact.email ?? undefined,
        tag: c.contact.tag?.name ?? undefined,
        tagId: c.contact.tagId ?? undefined,
        contactId: c.contact.id,
        channel: ((c as any).channel || (c.contact as any).channel || 'WHATSAPP') as any,
        externalHandle: (c.contact as any).externalHandle ?? undefined,
        activeMcpServerId: (c as any).activeMcpServerId ?? null,
        isSandboxAuthorized: c.contact.isSandboxAuthorized,
        lastUserMessageAt: c.lastUserMessageAt?.getTime() ?? null,
        lastMessagePreview: this.buildPreview(lastMsg),
        lastMessageAt: lastMsg?.whatsappTimestamp.getTime() ?? c.createdAt.getTime(),
        unreadCount,
        assignedToUserId: c.assignedToUserId,
        isNewLead: c.isNewLead,
        isAiActive: (c as any).isAiActive ?? false,
        adReferral: (c as any).adReferral ?? undefined,
      };
    });
    return withUnread.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  async getConversation(
    conversationId: string,
    organizationId: string,
    userId?: string,
    userRole?: string,
  ): Promise<Conversation | undefined> {
    const c = await this.prisma.conversation.findFirst({
      where: { id: conversationId, contact: { organizationId } },
      include: {
        contact: { include: { tag: true } },
        messages: {
          orderBy: { whatsappTimestamp: 'desc' },
          take: 1,
        },
      },
    });
    if (!c) return undefined;

    if (userRole === 'AGENT' && userId && c.assignedToUserId !== userId) {
      return undefined;
    }

    const lastMsg = c.messages[0];
    const unreadCount = await this.getUnreadCount(conversationId, c.lastReadAt);
    return {
      id: c.id,
      phone: c.contact.phone,
      name: c.contact.name ?? undefined,
      email: c.contact.email ?? undefined,
      tag: c.contact.tag?.name ?? undefined,
      tagId: c.contact.tagId ?? undefined,
      contactId: c.contact.id,
      channel: ((c as any).channel || (c.contact as any).channel || 'WHATSAPP') as any,
      externalHandle: (c.contact as any).externalHandle ?? undefined,
      activeMcpServerId: (c as any).activeMcpServerId ?? null,
      isSandboxAuthorized: c.contact.isSandboxAuthorized,
      lastUserMessageAt: c.lastUserMessageAt?.getTime() ?? null,
      lastMessagePreview: this.buildPreview(lastMsg),
      lastMessageAt: lastMsg?.whatsappTimestamp.getTime() ?? c.createdAt.getTime(),
      unreadCount,
      assignedToUserId: c.assignedToUserId,
      isNewLead: c.isNewLead,
      isAiActive: (c as any).isAiActive ?? false,
      adReferral: (c as any).adReferral ?? undefined,
    };
  }

  private buildPreview(lastMsg: { body: string; type: MessageType } | undefined): string {
    const preview = lastMsg?.body.slice(0, 80) ?? '';
    if (lastMsg && !preview) {
      if (lastMsg.type === MessageType.IMAGE) return '📷 Imagen';
      if (lastMsg.type === MessageType.VIDEO) return '🎥 Video';
      if (lastMsg.type === MessageType.AUDIO) return '🎵 Audio';
      if (lastMsg.type === MessageType.DOCUMENT) return '📄 Documento';
    }
    return preview;
  }

  private async getUnreadCountsBulk(conversationIds: string[]): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ conversationId: string; unreadCount: bigint }[]>`
      SELECT m."conversationId" as "conversationId", COUNT(*)::bigint as "unreadCount"
      FROM "Message" m
      JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
        AND m.direction = 'IN'::"MessageDirection"
        AND m."whatsappTimestamp" > COALESCE(c."lastReadAt", to_timestamp(0))
      GROUP BY m."conversationId"
    `;
    return new Map(rows.map((r) => [r.conversationId, Number(r.unreadCount)]));
  }

  private async getUnreadCount(conversationId: string, lastReadAt: Date | null): Promise<number> {
    return this.prisma.message.count({
      where: {
        conversationId,
        direction: MessageDirection.IN,
        whatsappTimestamp: { gt: lastReadAt ?? new Date(0) },
      },
    });
  }
}
