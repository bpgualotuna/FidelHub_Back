import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { TagsService } from './tags.service';

@Controller('tags')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  async findAll(@CurrentUser() user: AuthUser) {
    return this.tagsService.findAll(user.organizationId!);
  }

  @Post()
  @Roles(UserRole.ORG_ADMIN)
  async create(@CurrentUser() user: AuthUser, @Body() body: { name: string }) {
    return this.tagsService.create(user.organizationId!, body.name);
  }

  @Patch(':id')
  @Roles(UserRole.ORG_ADMIN)
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { name: string }) {
    return this.tagsService.update(user.organizationId!, id, body.name);
  }

  @Delete(':id')
  @Roles(UserRole.ORG_ADMIN)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.tagsService.remove(user.organizationId!, id);
    return { ok: true };
  }

  @Post('preview')
  async preview(@CurrentUser() user: AuthUser, @Body() body: { tagIds: string[] }) {
    return this.tagsService.previewByTags(user.organizationId!, body.tagIds || [], user.userId, user.role);
  }
}
