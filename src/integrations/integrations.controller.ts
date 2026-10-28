import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { UserRole } from '@prisma/client';
import { IsArray, IsString } from 'class-validator';
import { IntegrationsService, type UpdateIntegrationsDto } from './integrations.service';

class LeadAssignmentAgentsDto {
  @IsArray()
  @IsString({ each: true })
  agentIds!: string[];
}

@Controller('org/integrations')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  async getStatus(@CurrentUser() user: AuthUser) {
    return this.integrations.getStatus(user.organizationId!);
  }

  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() body: UpdateIntegrationsDto) {
    return this.integrations.update(user.organizationId!, body);
  }

  @Get('lead-assignment-enabled')
  async getLeadAssignmentEnabled(@CurrentUser() user: AuthUser) {
    const enabled = await this.integrations.getLeadAssignmentEnabled(user.organizationId!);
    return { enabled };
  }

  @Patch('lead-assignment-enabled')
  async updateLeadAssignmentEnabled(
    @CurrentUser() user: AuthUser,
    @Body() body: { enabled: boolean },
  ) {
    await this.integrations.updateLeadAssignmentEnabled(user.organizationId!, body.enabled);
    return { enabled: body.enabled };
  }

  @Get('lead-assignment')
  async getLeadAssignment(@CurrentUser() user: AuthUser) {
    const agentIds = await this.integrations.getLeadAssignmentAgents(user.organizationId!);
    return { agentIds };
  }

  @Patch('lead-assignment')
  async updateLeadAssignment(
    @CurrentUser() user: AuthUser,
    @Body() dto: LeadAssignmentAgentsDto,
  ) {
    await this.integrations.updateLeadAssignmentAgents(user.organizationId!, dto.agentIds);
    return { agentIds: dto.agentIds };
  }
}
