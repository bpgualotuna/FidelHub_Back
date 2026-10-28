import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { OrganizationStatus, UserRole } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { PlatformService } from './platform.service';

class CreateOrgBodyDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  /** Email del primer administrador de la empresa (opcional; requiere adminPassword). */
  @IsOptional()
  @IsEmail()
  adminEmail?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  adminPassword?: string;

  @IsOptional()
  @IsString()
  adminDisplayName?: string;

  /** Dato administrativo del super-admin: si esta empresa tiene contratado el addon de CRM. */
  @IsOptional()
  @IsBoolean()
  hasCrm?: boolean;
}

class OrgStatusBodyDto {
  @IsEnum(OrganizationStatus)
  status!: OrganizationStatus;
}

class OrgCrmBodyDto {
  @IsBoolean()
  hasCrm!: boolean;
}

class RenameOrgBodyDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

class ResetAdminPasswordBodyDto {
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

class BootstrapFirstAdminBodyDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

@Controller('platform/organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list() {
    return this.platform.listOrganizations();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgBodyDto) {
    return this.platform.createOrganization(user.userId, {
      name: dto.name,
      hasCrm: dto.hasCrm ?? false,
      firstAdmin:
        dto.adminEmail?.trim() && dto.adminPassword
          ? {
              email: dto.adminEmail.trim(),
              password: dto.adminPassword,
              displayName: dto.adminDisplayName?.trim(),
            }
          : undefined,
    });
  }

  @Patch(':id/status')
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: OrgStatusBodyDto,
  ) {
    return this.platform.setOrganizationStatus(user.userId, id, dto.status);
  }

  @Patch(':id/crm')
  setCrm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: OrgCrmBodyDto,
  ) {
    return this.platform.setOrganizationCrm(user.userId, id, dto.hasCrm);
  }

  @Patch(':id/rename')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RenameOrgBodyDto,
  ) {
    return this.platform.renameOrganization(user.userId, id, dto.name);
  }

  @Patch(':id/reset-admin-password')
  resetAdminPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResetAdminPasswordBodyDto,
  ) {
    return this.platform.resetAdminPassword(user.userId, id, dto.newPassword);
  }

  /** Solo si la empresa aún no tiene usuarios (p. ej. se creó solo con nombre). */
  @Post(':id/first-admin')
  bootstrapFirstAdmin(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: BootstrapFirstAdminBodyDto,
  ) {
    return this.platform.bootstrapFirstOrgAdmin(user.userId, id, {
      email: dto.email,
      password: dto.password,
      displayName: dto.displayName,
    });
  }
}
