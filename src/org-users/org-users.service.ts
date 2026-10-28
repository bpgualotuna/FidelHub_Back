import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAssignmentService } from '../lead-assignment/lead-assignment.service';
import { IntegrationsService } from '../integrations/integrations.service';

@Injectable()
export class OrgUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadAssignment: LeadAssignmentService,
    private readonly integrations: IntegrationsService,
  ) {}

  async list(organizationId: string, assignableOnly = false) {
    const where: any = { organizationId };
    if (assignableOnly) {
      where.role = UserRole.AGENT;
      where.isActive = true;
    }
    return this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    organizationId: string,
    params: { email: string; password: string; displayName?: string; role: UserRole },
  ) {
    if (params.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException('No se puede crear super admin desde la empresa');
    }
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Empresa no encontrada');
    const email = params.email.trim().toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('El email ya está registrado');
    const passwordHash = await bcrypt.hash(params.password, 10);
    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: params.displayName?.trim() || null,
        role: params.role,
        organizationId,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async deactivate(organizationId: string, targetUserId: string, adminUserId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.id === adminUserId) {
      throw new BadRequestException('No puedes desactivarte a ti mismo');
    }
    if (!user.isActive) {
      throw new BadRequestException('El usuario ya está inactivo');
    }

    // 1. Remove user from the round-robin agents list
    const configuredIds = await this.integrations.getLeadAssignmentAgents(organizationId);
    if (configuredIds.includes(targetUserId)) {
      await this.integrations.updateLeadAssignmentAgents(
        organizationId,
        configuredIds.filter((id) => id !== targetUserId),
      );
    }

    // 2. Mark user as inactive so getNextAgentInTurn skips them
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: false },
    });

    // 3. Find conversations assigned to this user
    const assignedConversations = await this.prisma.conversation.findMany({
      where: { assignedToUserId: targetUserId, contact: { organizationId } },
      select: { id: true },
    });

    // 4. Clear assignments so assignNewLead sees them as unassigned
    if (assignedConversations.length > 0) {
      await this.prisma.conversation.updateMany({
        where: { id: { in: assignedConversations.map(c => c.id) } },
        data: { assignedToUserId: null },
      });
    }

    // 5. Reassign each conversation via round-robin
    for (const conv of assignedConversations) {
      const result = await this.leadAssignment.assignNewLead(conv.id, organizationId);
      if (result.assignedToUserId) {
        await this.prisma.conversationAssignmentLog.create({
          data: {
            conversationId: conv.id,
            fromUserId: targetUserId,
            toUserId: result.assignedToUserId,
            reassignedByUserId: adminUserId,
            reason: 'user_deactivated',
          },
        });
      }
    }

    // 6. Clear related broadcast and CRM links
    await this.prisma.broadcastList.updateMany({
      where: { assignedToUserId: targetUserId },
      data: { assignedToUserId: null },
    });

    await this.prisma.crmContactLink.updateMany({
      where: { assignedToUserId: targetUserId },
      data: { assignedToUserId: null },
    });

    return {
      deactivatedUser: user.email,
      reassigned: assignedConversations.length,
    };
  }

  async reactivate(organizationId: string, targetUserId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.isActive) {
      throw new BadRequestException('El usuario ya está activo');
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: true },
    });

    return { reactivatedUser: user.email };
  }
}
