import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { TemplatesService } from './templates.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  @Get()
  async findAll(@CurrentUser() user: AuthUser) {
    return this.templates.findAll(user.organizationId!);
  }

  @Get('from-meta')
  async getMetaTemplates(@CurrentUser() user: AuthUser) {
    return this.whatsapp.getMessageTemplates(user.organizationId!);
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const template = await this.templates.findOne(user.organizationId!, id);
    if (!template) return { ok: false, template: null };
    return { ok: true, template };
  }

  @Post()
  @Roles(UserRole.ORG_ADMIN)
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateTemplateDto) {
    const template = await this.templates.create(user.organizationId!, {
      name: dto.name,
      body: dto.body,
    });
    return { ok: true, template };
  }

  @Patch(':id')
  @Roles(UserRole.ORG_ADMIN)
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    const template = await this.templates.update(user.organizationId!, id, {
      name: dto.name,
      body: dto.body,
    });
    return { ok: true, template };
  }

  @Delete(':id')
  @Roles(UserRole.ORG_ADMIN)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.templates.remove(user.organizationId!, id);
    return { ok: true };
  }
}
