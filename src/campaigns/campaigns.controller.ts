import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { CampaignsService } from './campaigns.service';

@Controller('campaigns')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  async findAll(@CurrentUser() user: AuthUser) {
    return this.campaignsService.findAll(user.organizationId!);
  }

  @Post()
  @Roles(UserRole.ORG_ADMIN)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: { name: string; description?: string },
  ) {
    return this.campaignsService.create(user.organizationId!, body.name.trim(), body.description?.trim());
  }

  @Patch(':id/activate')
  @Roles(UserRole.ORG_ADMIN)
  async activate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.campaignsService.activate(user.organizationId!, id);
  }

  @Delete(':id')
  @Roles(UserRole.ORG_ADMIN)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.campaignsService.remove(user.organizationId!, id);
  }
}
