import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import type { Response } from 'express';
import { MessageType, UserRole } from '@prisma/client';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { ChannelsService } from './channels.service';
import type { SupportedChannel } from './channels.types';

class UpsertChannelConfigDto {
  @IsString()
  @IsNotEmpty()
  channel!: SupportedChannel;

  @IsString()
  @IsNotEmpty()
  displayName!: string;

  @IsOptional()
  @IsString()
  externalAccountId?: string;

  @IsOptional()
  @IsString()
  accessToken?: string;

  @IsOptional()
  @IsString()
  webhookVerifyToken?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@Controller()
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ChatService))
    private readonly chat: ChatService,
  ) {}

  @Get('channels/accounts')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
  async getAccounts(@CurrentUser() user: AuthUser) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const accounts = await this.channels.getOrganizationChannels(user.organizationId);
    return { ok: true, accounts };
  }

  @Post('channels/accounts')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN)
  async saveAccount(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertChannelConfigDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const account = await this.channels.upsertChannelConfig(user.organizationId, dto);
    return { ok: true, account };
  }

  /**
   * Verificación pública de Webhooks para Meta (Instagram / Facebook Messenger) y TikTok
   */
  @Get('webhooks/:channel')
  async verifyWebhook(
    @Param('channel') channel: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Query('challenge') tiktokChallenge: string,
    @Res() res: Response,
  ) {
    if (tiktokChallenge) {
      return res.status(200).json({ challenge: tiktokChallenge });
    }
    if (mode === 'subscribe' && challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(200).json({ ok: true, channel: channel.toUpperCase() });
  }

  /**
   * Recepción unificada de Webhooks entrantes de Instagram Direct, Facebook Messenger y TikTok DM
   */
  @Post('webhooks/:channel')
  @HttpCode(200)
  async receiveWebhook(
    @Param('channel') channel: string,
    @Query('orgId') queryOrgId: string | undefined,
    @Body() payload: any,
  ) {
    let organizationId = queryOrgId;
    if (!organizationId) {
      const firstOrg = await this.prisma.organization.findFirst({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
      organizationId = firstOrg?.id;
    }

    if (!organizationId) {
      return { ok: false, reason: 'no_active_organization' };
    }

    const normalizedList = this.channels.parseIncomingWebhook(channel, payload, organizationId);
    for (const item of normalizedList) {
      await this.chat.registerIncomingMessage({
        organizationId: item.organizationId,
        from: item.externalUserId,
        externalUsername: item.externalUsername,
        contactName: item.contactName,
        messageId: item.messageId,
        timestamp: item.timestamp,
        text: item.text,
        channel: item.channel,
        type: (item.type as MessageType) || MessageType.TEXT,
        mediaUrl: item.mediaUrl,
        mimeType: item.mimeType,
        fileName: item.fileName,
        metadata: item.metadata,
      });
    }

    return { ok: true, processed: normalizedList.length };
  }
}
