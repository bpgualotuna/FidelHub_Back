import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { OrgAuditService } from './org-audit.service';

@Controller('org/audit')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN)
export class OrgAuditController {
  constructor(private readonly orgAudit: OrgAuditService) {}

  /** Mensajes salientes recientes con quién los envió (auditoría interna). */
  @Get('outbound')
  outbound(@CurrentUser() user: AuthUser, @Query('take') takeRaw?: string) {
    const take = takeRaw ? parseInt(takeRaw, 10) : 80;
    return this.orgAudit.listOutboundMessages(user.organizationId!, take);
  }
}
