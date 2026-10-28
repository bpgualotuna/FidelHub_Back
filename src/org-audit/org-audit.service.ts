import { Injectable } from '@nestjs/common';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrgAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listOutboundMessages(organizationId: string, take = 80) {
    const limit = Math.min(Math.max(take, 1), 200);
    const rows = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.OUT,
        conversation: { contact: { organizationId } },
      },
      orderBy: { whatsappTimestamp: 'desc' },
      take: limit,
      include: {
        sentByUser: { select: { id: true, email: true, displayName: true } },
        conversation: {
          include: { contact: { select: { phone: true, name: true } } },
        },
      },
    });
    return rows.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      contactPhone: m.conversation.contact.phone,
      contactName: m.conversation.contact.name,
      bodyPreview: m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body,
      fromAi: m.fromAi ?? false,
      whatsappTimestamp: m.whatsappTimestamp.getTime(),
      sentBy: m.sentByUser
        ? {
            id: m.sentByUser.id,
            email: m.sentByUser.email,
            displayName: m.sentByUser.displayName,
          }
        : null,
    }));
  }
}
