import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { SettingsService, type WhatsappTier } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  private async buildResponse(organizationId: string) {
    const [whatsappTier, dailyLimit, dailyUsed, nextFreeAt, geminiModel, geminiModelInUse] = await Promise.all([
      this.settings.getWhatsappTier(organizationId),
      this.settings.getDailyLimit(organizationId),
      this.settings.getDailyConversationCount(organizationId),
      this.settings.getNextCapacityFreeAt(organizationId),
      this.settings.getGeminiModel(organizationId),
      this.settings.getGeminiModelInUse(organizationId),
    ]);
    const isUnlimited = dailyLimit === Number.MAX_SAFE_INTEGER;
    return {
      whatsappTier,
      dailyLimit: isUnlimited ? null : dailyLimit,
      dailyUsed,
      dailyRemaining: isUnlimited ? null : Math.max(0, dailyLimit - dailyUsed),
      nextFreeAt: isUnlimited ? null : nextFreeAt?.toISOString() ?? null,
      geminiModel,
      geminiModelInUse,
    };
  }

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    return this.buildResponse(user.organizationId!);
  }

  @Patch()
  @Roles(UserRole.ORG_ADMIN)
  async update(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      whatsappTier?: WhatsappTier;
      geminiModel?: string;
    },
  ) {
    const orgId = user.organizationId!;
    if (body.whatsappTier !== undefined) {
      await this.settings.setWhatsappTier(orgId, body.whatsappTier);
    }
    if (body.geminiModel !== undefined) {
      await this.settings.setGeminiModel(orgId, body.geminiModel.trim());
    }
    return this.buildResponse(orgId);
  }
}
