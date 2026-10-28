import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../chat/chat.gateway';
import { IntegrationsService } from '../integrations/integrations.service';

export interface AssignedResult {
  conversationId: string;
  assignedToUserId: string | null;
  isNewAssignment: boolean;
}

@Injectable()
export class LeadAssignmentService {
  private readonly logger = new Logger(LeadAssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatGateway: ChatGateway,
    private readonly integrations: IntegrationsService,
  ) {}

  async assignNewLead(conversationId: string, organizationId: string): Promise<AssignedResult> {
    const alreadyAssigned = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { assignedToUserId: true, isNewLead: true },
    });
    if (alreadyAssigned?.assignedToUserId) {
      return { conversationId, assignedToUserId: alreadyAssigned.assignedToUserId, isNewAssignment: false };
    }

    const nextAgentId = await this.getNextAgentInTurn(organizationId);
    const now = new Date();

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        assignedToUserId: nextAgentId,
        assignedAt: now,
        isNewLead: true,
      },
    });

    if (nextAgentId) {
      this.chatGateway.emitConversationAssigned(organizationId, conversationId, nextAgentId);
    }

    return { conversationId, assignedToUserId: nextAgentId, isNewAssignment: true };
  }

  async tryAutoAssignNewLead(conversationId: string, organizationId: string): Promise<AssignedResult> {
    const enabled = await this.integrations.getLeadAssignmentEnabled(organizationId);
    if (!enabled) {
      return { conversationId, assignedToUserId: null, isNewAssignment: false };
    }
    return this.assignNewLead(conversationId, organizationId);
  }

  async peekNextAgent(organizationId: string): Promise<{ id: string; displayName: string | null; email: string } | null> {
    const agentId = await this.getNextAgentInTurn(organizationId);
    if (!agentId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: agentId },
      select: { id: true, displayName: true, email: true },
    });
    return user;
  }

  async assignHistoricalChats(organizationId: string): Promise<{ assigned: number; total: number }> {
    const unassigned = await this.prisma.conversation.findMany({
      where: {
        contact: { organizationId },
        assignedToUserId: null,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const total = unassigned.length;
    let assigned = 0;
    for (const conv of unassigned) {
      const result = await this.assignNewLead(conv.id, organizationId);
      if (result.isNewAssignment && result.assignedToUserId) assigned++;
    }
    return { assigned, total };
  }

  async getNextAgentInTurn(organizationId: string): Promise<string | null> {
    const configuredIds = await this.integrations.getLeadAssignmentAgents(organizationId);

    const where: any = {
      organizationId,
      isActive: true,
      role: UserRole.AGENT,
    };
    if (configuredIds.length > 0) {
      where.id = { in: configuredIds };
    }

    const agents = await this.prisma.user.findMany({
      where,
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });

    if (agents.length === 0) return null;

    const agentIds = agents.map(a => a.id);

    const lastAssigned = await this.prisma.conversation.findFirst({
      where: {
        assignedToUserId: { in: agentIds, not: null },
        contact: { organizationId },
      },
      orderBy: { assignedAt: 'desc' },
      select: { assignedToUserId: true },
    });

    const lastIndex = lastAssigned?.assignedToUserId
      ? agentIds.indexOf(lastAssigned.assignedToUserId)
      : -1;

    const nextIndex = (lastIndex + 1) % agentIds.length;
    return agentIds[nextIndex];
  }
}
