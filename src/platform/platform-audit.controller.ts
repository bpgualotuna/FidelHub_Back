import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformService } from './platform.service';

@Controller('platform/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class PlatformAuditController {
  constructor(private readonly platform: PlatformService) {}

  /** Lista acciones de plataforma; filtro opcional por empresa afectada. */
  @Get()
  list(
    @Query('organizationId') organizationId?: string,
    @Query('take') takeRaw?: string,
  ) {
    const take = takeRaw ? parseInt(takeRaw, 10) : undefined;
    return this.platform.listAuditLogs({
      organizationId: organizationId?.trim() || undefined,
      take: Number.isFinite(take) ? take : undefined,
    });
  }
}
