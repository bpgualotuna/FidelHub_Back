import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole, MessageType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { OrgMemberGuard } from '../auth/org-member.guard';
import { ChatService } from './chat.service';
import { StorageService } from '../common/storage.service';
import { LeadAssignmentService } from '../lead-assignment/lead-assignment.service';
import type { SupportedChannel } from '../channels/channels.types';
import { IsNotEmpty, IsString, IsOptional, IsBoolean, IsArray } from 'class-validator';

class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsString()
  replyToId?: string;
}

class AssignConversationDto {
  @IsOptional()
  @IsString()
  assignToUserId?: string | null;
}

class ToggleAiDto {
  @IsBoolean()
  isAiActive!: boolean;
}

class ToggleTrainingDto {
  @IsBoolean()
  isTrainingMode!: boolean;
}

class SetConversationMcpDto {
  @IsOptional()
  @IsString()
  mcpServerId?: string | null;
}

class CreateFidelRuleDto {
  @IsString()
  @IsNotEmpty()
  instruction!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  sourceFeedback?: string;
}

class ToggleFidelRuleDto {
  @IsBoolean()
  isActive!: boolean;
}

class SandboxTrainingTurnDto {
  @IsString()
  @IsNotEmpty()
  message!: string;

  @IsOptional()
  @IsArray()
  history?: Array<{ role: 'trainer' | 'fidel'; text: string }>;
}

class SimulateMessageDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  channel?: SupportedChannel;

  @IsOptional()
  @IsString()
  externalUsername?: string;

  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsOptional()
  @IsString()
  contactName?: string;
}

@Controller('chat')
@UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
@Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly storage: StorageService,
    private readonly leadAssignment: LeadAssignmentService,
  ) {}

  @Get('conversations')
  async getConversations(
    @CurrentUser() user: AuthUser,
    @Query('channel') channel?: string,
  ) {
    return this.chat.getConversations(user.organizationId!, user.userId, user.role, channel);
  }

  @Get('conversations/search')
  async searchConversationsByMessage(
    @CurrentUser() user: AuthUser,
    @Query('q') query?: string,
  ) {
    return this.chat.searchConversationsByMessage(
      user.organizationId!,
      query || '',
      user.userId,
      user.role,
    );
  }

  @Get('conversations/:id')
  async getConversation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const conv = await this.chat.getConversation(
      id,
      user.organizationId!,
      user.userId,
      user.role,
    );
    if (!conv) return { ok: false, conversation: null };
    const [canSend, windowSecondsRemaining] = await Promise.all([
      this.chat.canSendToConversation(id, user.organizationId!),
      this.chat.getWindowSecondsRemaining(id, user.organizationId!),
    ]);
    return {
      ok: true,
      conversation: conv,
      canSend,
      windowSecondsRemaining,
    };
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.chat.getMessages(id, user.organizationId!, cursor, user.userId, user.role);
  }

  @Get('conversations/:id/gallery')
  async getGallery(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.chat.getGallery(id, user.organizationId!, user.userId, user.role, cursor);
  }

  @Get('conversations/:id/search')
  async searchMessages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('q') query: string,
  ) {
    return this.chat.searchMessages(id, user.organizationId!, query, user.userId, user.role);
  }

  @Patch('conversations/:id/read')
  async markAsRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.chat.markConversationAsRead(id, user.organizationId!);
    return { ok: true };
  }

  @Get('conversations/:id/can-send')
  async canSend(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const [canSend, windowSecondsRemaining] = await Promise.all([
      this.chat.canSendToConversation(id, user.organizationId!),
      this.chat.getWindowSecondsRemaining(id, user.organizationId!),
    ]);
    return { canSend, windowSecondsRemaining };
  }

  @Post('conversations/:id/send')
  async sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    const msg = await this.chat.sendMessage({
      organizationId: user.organizationId!,
      conversationId: id,
      text: dto.text,
      sentByUserId: user.userId,
      replyToId: dto.replyToId,
    });
    return { ok: true, message: msg };
  }

  @Post('conversations/:id/send-media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  async sendMedia(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Query('type') type: string,
  ) {
    if (!file) throw new BadRequestException('Archivo no proveído');
    const validTypes = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'];
    if (!validTypes.includes(type)) {
      throw new BadRequestException(
        'Tipo de mensaje inválido. Debe ser IMAGE, VIDEO, AUDIO o DOCUMENT',
      );
    }
    const msg = await this.chat.sendMediaMessage({
      organizationId: user.organizationId!,
      conversationId: id,
      file,
      type: type as any,
      sentByUserId: user.userId,
    });
    return { ok: true, message: msg };
  }

  @Post('conversations/:id/generate-reply')
  async generateReply(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const { text, usedFallbackModel, mcpToolTraces } = await this.chat.generateAiReply(
      user.organizationId!,
      id,
    );
    return { ok: true, text, usedFallbackModel, mcpToolTraces };
  }

  @Get('lead-assignment/next-agent')
  async getNextAgent(@CurrentUser() user: AuthUser) {
    return this.leadAssignment.peekNextAgent(user.organizationId!);
  }

  @Post('conversations/backfill-assignment')
  @Roles(UserRole.ORG_ADMIN)
  async backfillAssignment(@CurrentUser() user: AuthUser) {
    return this.leadAssignment.assignHistoricalChats(user.organizationId!);
  }

  @Post('conversations/:id/assign')
  @Roles(UserRole.ORG_ADMIN)
  async assignConversation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssignConversationDto,
  ) {
    await this.chat.assignConversation(id, user.organizationId!, dto.assignToUserId ?? null);
    return { ok: true };
  }

  @Patch('conversations/:id/toggle-ai')
  async toggleAi(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ToggleAiDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const isAiActive = await this.chat.setConversationAiActive(
      id,
      user.organizationId,
      body.isAiActive,
    );
    return { ok: true, isAiActive };
  }

  @Patch('conversations/:id/mcp-server')
  async setConversationMcpServer(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: SetConversationMcpDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const res = await this.chat.setConversationMcpServer(
      id,
      user.organizationId,
      body.mcpServerId ?? null,
    );
    return { ok: true, ...res };
  }

  @Post('simulator/message')
  async simulateMessage(
    @CurrentUser() user: AuthUser,
    @Body() body: SimulateMessageDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    if (!body.text?.trim()) throw new BadRequestException('El texto del mensaje es obligatorio');

    const channel = (body.channel?.toUpperCase() as SupportedChannel) || 'WHATSAPP';
    const from =
      body.phone?.trim() ||
      (channel === 'WHATSAPP'
        ? '593999999999'
        : `${channel.toLowerCase()}_lead_${Math.floor(1000 + Math.random() * 9000)}`);
    const contactName =
      body.contactName?.trim() ||
      (channel === 'WHATSAPP'
        ? 'Cliente WhatsApp'
        : `Lead ${channel.charAt(0) + channel.slice(1).toLowerCase()}`);
    const messageId = `sim_${channel.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await this.chat.registerIncomingMessage({
      organizationId: user.organizationId,
      from,
      externalUsername: body.externalUsername?.trim() || undefined,
      channel,
      contactName,
      messageId,
      timestamp: Date.now(),
      text: body.text.trim(),
      type: MessageType.TEXT,
    });

    return { ok: true, simulatedMessageId: messageId, channel };
  }

  @Get('conversations/:id/training-status')
  async getTrainingStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const isTrainingMode = await this.chat.isConversationInTrainingMode(id, user.organizationId);
    return { ok: true, isTrainingMode };
  }

  @Patch('conversations/:id/toggle-training')
  async toggleTrainingMode(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ToggleTrainingDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const res = await this.chat.setConversationTrainingMode(
      id,
      user.organizationId,
      body.isTrainingMode,
    );
    return { ok: true, ...res };
  }

  @Get('fidel/rules')
  async getFidelRules(@CurrentUser() user: AuthUser) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const rules = await this.chat.getFidelRules(user.organizationId);
    return { ok: true, rules };
  }

  @Post('fidel/rules')
  async createFidelRule(@CurrentUser() user: AuthUser, @Body() body: CreateFidelRuleDto) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const rule = await this.chat.addFidelRule(user.organizationId, {
      instruction: body.instruction,
      category: body.category,
      sourceFeedback: body.sourceFeedback,
      createdByName: user.email || 'Entrenador',
    });
    return { ok: true, rule };
  }

  @Patch('fidel/rules/:ruleId')
  async toggleFidelRule(
    @CurrentUser() user: AuthUser,
    @Param('ruleId') ruleId: string,
    @Body() body: ToggleFidelRuleDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const rules = await this.chat.toggleFidelRule(
      user.organizationId,
      ruleId,
      body.isActive,
    );
    return { ok: true, rules };
  }

  @Delete('fidel/rules/:ruleId')
  async deleteFidelRule(@CurrentUser() user: AuthUser, @Param('ruleId') ruleId: string) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const rules = await this.chat.deleteFidelRule(user.organizationId, ruleId);
    return { ok: true, rules };
  }

  @Post('fidel/training-turn')
  async runSandboxTrainingTurn(
    @CurrentUser() user: AuthUser,
    @Body() body: SandboxTrainingTurnDto,
  ) {
    if (!user.organizationId) throw new BadRequestException('Usuario sin organización');
    const res = await this.chat.runSandboxTrainingTurn(
      user.organizationId,
      body.history || [],
      body.message,
      user.email || 'Entrenador',
    );
    return { ok: true, ...res };
  }
}
