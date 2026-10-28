import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationStatus, Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { PLATFORM_AUDIT_ACTIONS } from './platform-audit.constants';

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrganizations() {
    return this.prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        hasCrm: true,
        whatsappPhoneNumberId: true,
        createdAt: true,
        _count: { select: { users: true, contacts: true } },
      },
    });
  }

  private async logAudit(params: {
    actorUserId: string;
    action: string;
    targetOrganizationId?: string | null;
    metadata?: Prisma.InputJsonValue;
  }) {
    await this.prisma.platformAuditLog.create({
      data: {
        actorUserId: params.actorUserId,
        action: params.action,
        targetOrganizationId: params.targetOrganizationId ?? null,
        ...(params.metadata !== undefined
          ? { metadata: params.metadata as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async createOrganization(
    actorUserId: string,
    params: {
      name: string;
      hasCrm?: boolean;
      firstAdmin?: { email: string; password: string; displayName?: string };
    },
  ) {
    const name = params.name.trim() || 'Sin nombre';
    const fa = params.firstAdmin;
    if (fa) {
      const email = fa.email.trim().toLowerCase();
      if (!email) throw new BadRequestException('Email del administrador inválido');
      if (!fa.password || fa.password.length < 6) {
        throw new BadRequestException('La contraseña del administrador debe tener al menos 6 caracteres');
      }
      const taken = await this.prisma.user.findUnique({ where: { email } });
      if (taken) {
        throw new ConflictException('Ese email ya está registrado; usa otro o crea la empresa sin administrador');
      }
    }

    const org = await this.prisma.organization.create({
      data: { name, hasCrm: params.hasCrm ?? false },
      select: {
        id: true,
        name: true,
        status: true,
        hasCrm: true,
        createdAt: true,
      },
    });

    let firstAdminOut:
      | { id: string; email: string; displayName: string | null; role: UserRole }
      | undefined;

    await this.logAudit({
      actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.ORG_CREATED,
      targetOrganizationId: org.id,
      metadata: { name: org.name, withFirstAdmin: Boolean(fa) },
    });

    if (fa) {
      const email = fa.email.trim().toLowerCase();
      const passwordHash = await bcrypt.hash(fa.password, 10);
      const admin = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          displayName: fa.displayName?.trim() || null,
          role: UserRole.ORG_ADMIN,
          organizationId: org.id,
        },
        select: { id: true, email: true, displayName: true, role: true },
      });
      firstAdminOut = admin;
      await this.logAudit({
        actorUserId,
        action: PLATFORM_AUDIT_ACTIONS.ORG_FIRST_ADMIN_CREATED,
        targetOrganizationId: org.id,
        metadata: { email: admin.email },
      });
    }

    return { ...org, firstAdmin: firstAdminOut };
  }

  async bootstrapFirstOrgAdmin(
    actorUserId: string,
    organizationId: string,
    params: { email: string; password: string; displayName?: string },
  ) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Empresa no encontrada');
    const userCount = await this.prisma.user.count({ where: { organizationId } });
    if (userCount > 0) {
      throw new BadRequestException(
        'Esta empresa ya tiene usuarios; el admin debe crear más cuentas en Usuarios.',
      );
    }
    const email = params.email.trim().toLowerCase();
    const taken = await this.prisma.user.findUnique({ where: { email } });
    if (taken) throw new ConflictException('El email ya está registrado');
    const passwordHash = await bcrypt.hash(params.password, 10);
    const admin = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: params.displayName?.trim() || null,
        role: UserRole.ORG_ADMIN,
        organizationId,
      },
      select: { id: true, email: true, displayName: true, role: true },
    });
    await this.logAudit({
      actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.ORG_FIRST_ADMIN_CREATED,
      targetOrganizationId: organizationId,
      metadata: { email: admin.email, bootstrap: true },
    });
    return admin;
  }

  async setOrganizationStatus(
    actorUserId: string,
    id: string,
    status: OrganizationStatus,
  ) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Empresa no encontrada');
    const previous = org.status;
    const updated = await this.prisma.organization.update({
      where: { id },
      data: { status },
      select: { id: true, name: true, status: true },
    });
    await this.logAudit({
      actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.ORG_STATUS_CHANGED,
      targetOrganizationId: id,
      metadata: { previous, next: status },
    });
    return updated;
  }

  async setOrganizationCrm(actorUserId: string, id: string, hasCrm: boolean) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Empresa no encontrada');
    const previous = org.hasCrm;
    const updated = await this.prisma.organization.update({
      where: { id },
      data: { hasCrm },
      select: { id: true, name: true, hasCrm: true },
    });
    await this.logAudit({
      actorUserId,
      action: PLATFORM_AUDIT_ACTIONS.ORG_CRM_CHANGED,
      targetOrganizationId: id,
      metadata: { previous, next: hasCrm },
    });
    return updated;
  }

  async renameOrganization(actorUserId: string, id: string, name: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Empresa no encontrada');
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('El nombre no puede estar vacío');
    const updated = await this.prisma.organization.update({
      where: { id },
      data: { name: trimmed },
      select: { id: true, name: true, status: true },
    });
    await this.logAudit({
      actorUserId,
      action: 'ORG_RENAMED',
      targetOrganizationId: id,
      metadata: { previous: org.name, next: trimmed },
    });
    return updated;
  }

  async resetAdminPassword(
    actorUserId: string,
    organizationId: string,
    newPassword: string,
  ) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Empresa no encontrada');
    const admin = await this.prisma.user.findFirst({
      where: { organizationId, role: 'ORG_ADMIN' },
    });
    if (!admin) throw new NotFoundException('La empresa no tiene un administrador asignado');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await this.prisma.user.update({
      where: { id: admin.id },
      data: { passwordHash },
      select: { id: true, email: true },
    });
    await this.logAudit({
      actorUserId,
      action: 'ORG_ADMIN_PASSWORD_RESET',
      targetOrganizationId: organizationId,
      metadata: { adminEmail: admin.email },
    });
    return { success: true, adminEmail: updated.email };
  }

  async listAuditLogs(params: { organizationId?: string; take?: number }) {
    const take = Math.min(params.take ?? 100, 200);
    return this.prisma.platformAuditLog.findMany({
      where: params.organizationId
        ? { targetOrganizationId: params.organizationId }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: { select: { id: true, email: true, displayName: true } },
      },
    });
  }
}
