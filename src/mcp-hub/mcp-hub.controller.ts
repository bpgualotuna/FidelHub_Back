import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { McpHubService } from './mcp-hub.service';

class CreateMcpServerDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  transport?: 'http' | 'sse' | 'websocket' | 'stdio';

  @IsString()
  @IsNotEmpty()
  endpointUrl!: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsArray()
  assignedChannels?: string[];

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

class UpdateMcpServerDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsArray()
  assignedChannels?: string[];

  @IsOptional()
  @IsString()
  endpointUrl?: string;

  @IsOptional()
  @IsString()
  name?: string;
}

class ExecuteMcpToolDto {
  @IsOptional()
  @IsString()
  serverId?: string;

  @IsString()
  @IsNotEmpty()
  toolName!: string;

  @IsOptional()
  arguments?: Record<string, any>;
}

@Controller('mcp-hub')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
export class McpHubController {
  constructor(private readonly mcpHub: McpHubService) {}

  @Get('servers')
  async listServers(@CurrentUser() user: AuthUser) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const servers = await this.mcpHub.listServers(user.organizationId);
    return { ok: true, servers };
  }

  @Post('servers')
  async registerServer(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMcpServerDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const server = await this.mcpHub.registerServer(user.organizationId, dto);
    return { ok: true, server };
  }

  @Patch('servers/:id')
  async updateServer(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const server = await this.mcpHub.updateServer(user.organizationId, id, dto);
    return { ok: true, server };
  }

  @Delete('servers/:id')
  async deleteServer(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const servers = await this.mcpHub.deleteServer(user.organizationId, id);
    return { ok: true, servers };
  }

  @Post('servers/:id/discover')
  async discoverCapabilities(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const res = await this.mcpHub.discoverServerCapabilities(user.organizationId, id);
    return { ok: true, ...res };
  }

  @Post('execute-tool')
  async executeTool(
    @CurrentUser() user: AuthUser,
    @Body() dto: ExecuteMcpToolDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const trace = await this.mcpHub.executeTool(
      user.organizationId,
      dto.serverId,
      dto.toolName,
      dto.arguments || {},
    );
    return { ok: true, trace };
  }
}
