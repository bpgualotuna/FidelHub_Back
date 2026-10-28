import {
  Body, Controller, Get, Post, Headers, HttpCode, HttpStatus, UseGuards, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrgMemberGuard } from '../auth/org-member.guard';
import type { AuthUser } from '../auth/auth.types';
import { CrmIntegrationsService } from './crm-integrations.service';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { SyncContactsDto } from './dto/sync-contacts.dto';
import { CheckUserDto } from './dto/check-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { CrmIntegrationRateLimitGuard } from './crm-integration-rate-limit.guard';
import { ContactsService } from '../contacts/contacts.service';

@Controller('crm-integrations')
export class CrmIntegrationsController {
  constructor(
    private readonly service: CrmIntegrationsService,
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
  ) {}

  // ── Endpoints protegidos (requieren JWT + rol ORG_ADMIN) ──

  @Get('code')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN)
  async getVinculacionCode(@CurrentUser() user: AuthUser) {
    const existing = await this.prisma.crmIntegration.findUnique({
      where: { organizationId: user.organizationId! },
    });
    if (existing) {
      return {
        codigoVinculacion: existing.codigoVinculacion,
        isActive: existing.isActive,
        crmUrl: existing.crmUrl,
        crmName: existing.crmName,
        createdAt: existing.createdAt,
      };
    }
    const code = this.service.generateCodigoVinculacion();
    const integration = await this.prisma.crmIntegration.create({
      data: {
        organizationId: user.organizationId!,
        codigoVinculacion: code,
        apiKeyHash: '',
      },
    });
    return {
      codigoVinculacion: integration.codigoVinculacion,
      isActive: integration.isActive,
      crmUrl: integration.crmUrl,
      crmName: integration.crmName,
      createdAt: integration.createdAt,
      newCode: true,
    };
  }

  @Post('code/regenerate')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN)
  async regenerateCode(@CurrentUser() user: AuthUser) {
    const code = this.service.generateCodigoVinculacion();
    const integration = await this.prisma.crmIntegration.upsert({
      where: { organizationId: user.organizationId! },
      create: {
        organizationId: user.organizationId!,
        codigoVinculacion: code,
        apiKeyHash: '',
      },
      update: {
        codigoVinculacion: code,
        apiKeyHash: '',
      },
    });
    return {
      codigoVinculacion: integration.codigoVinculacion,
      isActive: integration.isActive,
    };
  }

  @Post('verify-code')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN)
  @HttpCode(HttpStatus.OK)
  async verifyCodeAndGenerateKey(
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyCodeDto,
  ) {
    const result = await this.service.generateApiKey(
      user.organizationId!,
      dto.codigoVinculacion,
    );
    return {
      ok: true,
      apiKey: result.apiKey,
      message: 'Código verificado. API Key generada correctamente.',
    };
  }

  @Get('status')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN, UserRole.AGENT)
  async getStatus(@CurrentUser() user: AuthUser) {
    const integration = await this.prisma.crmIntegration.findUnique({
      where: { organizationId: user.organizationId! },
    });
    if (!integration) {
      return { connected: false };
    }
    return {
      connected: integration.isActive && !!integration.apiKeyHash,
      codigoVinculacion: integration.codigoVinculacion,
      crmUrl: integration.crmUrl,
      crmName: integration.crmName,
      isActive: integration.isActive,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    };
  }

  @Get('audit')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN)
  async getAuditLogs(@CurrentUser() user: AuthUser) {
    const logs = await this.prisma.crmAuditLog.findMany({
      where: { organizationId: user.organizationId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { logs };
  }

  @Post('reports/send-to-crm')
  @UseGuards(JwtAuthGuard, OrgMemberGuard, RolesGuard)
  @Roles(UserRole.ORG_ADMIN)
  @HttpCode(HttpStatus.OK)
  async sendReportToCrm(
    @CurrentUser() user: AuthUser,
    @Body() body: { contactIds?: string[] },
  ) {
    const ids = body?.contactIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30 ||
      ids.some((id) => typeof id !== 'string' || !id.trim()) ||
      new Set(ids).size !== ids.length) {
      throw new BadRequestException('Seleccione entre 1 y 30 contactos distintos por envío');
    }
    const rows = await this.contacts.exportContacts(user.organizationId!, ids, user.userId, user.role);
    if (rows.length !== ids.length) {
      throw new ForbiddenException('Uno o más contactos no pertenecen a su organización');
    }
    return this.service.sendReportToCrm(user.organizationId!, rows);
  }

  // ── Endpoint público para vinculación desde CRM (sin JWT) ──

  @Post('verify-code-public')
  @HttpCode(HttpStatus.OK)
  async verifyCodePublic(@Body() body: { codigoVinculacion: string; crmUrl?: string; crmName?: string }) {
    if (!body.codigoVinculacion) {
      return { ok: false, error: 'Código de vinculación requerido' };
    }
    const integration = await this.prisma.crmIntegration.findUnique({
      where: { codigoVinculacion: body.codigoVinculacion },
    });
    if (!integration) {
      return { ok: false, error: 'Código de vinculación inválido' };
    }
    if (!integration.isActive) {
      return { ok: false, error: 'La integración está desactivada' };
    }

    // Actualizar URL y nombre del CRM si se proporcionan
    if (body.crmUrl || body.crmName) {
      await this.prisma.crmIntegration.update({
        where: { id: integration.id },
        data: {
          crmUrl: body.crmUrl || integration.crmUrl,
          crmName: body.crmName || integration.crmName,
        },
      });
    }

    const result = await this.service.generateApiKeyByCode(body.codigoVinculacion);
    return {
      ok: true,
      apiKey: result.apiKey,
      organizationId: integration.organizationId,
      message: 'Vinculación exitosa con CRM',
    };
  }

  // ── Endpoint público (sin JWT, autenticado via API Key + HMAC) ──

  @Get('agents')
  @UseGuards(CrmIntegrationRateLimitGuard)
  async listAgentsForCrm(
    @Headers('x-api-key') apiKey: string | undefined,
    @Headers('x-hmac-signature') signature: string | undefined,
  ) {
    if (!apiKey || !signature) return { ok: false, error: 'Credenciales requeridas' };
    const integration = await this.service.verifyApiKey(apiKey);
    if (!integration || !this.service.verifyHmac('agents', signature)) {
      return { ok: false, error: 'Credenciales inválidas' };
    }
    const agents = await this.prisma.user.findMany({
      where: { organizationId: integration.organizationId, role: UserRole.AGENT, isActive: true },
      select: { id: true, email: true, displayName: true },
      orderBy: { email: 'asc' },
    });
    return { ok: true, agents };
  }

  @Post('check-user')
  @UseGuards(CrmIntegrationRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async checkUser(
    @Headers('x-api-key') apiKey: string | undefined,
    @Headers('x-hmac-signature') signature: string | undefined,
    @Body() dto: CheckUserDto,
  ) {
    if (!apiKey || !signature) {
      return { ok: false, error: 'API Key y HMAC signature requeridos' };
    }

    const integration = await this.service.verifyApiKey(apiKey);
    if (!integration) {
      return { ok: false, error: 'API Key inválida' };
    }

    const payload = JSON.stringify(dto);
    if (!this.service.verifyHmac(payload, signature)) {
      return { ok: false, error: 'Firma HMAC inválida' };
    }

    const result = await this.service.checkUser(dto.email, integration.organizationId);
    return { ok: true, ...result };
  }

  @Post('contacts/sync')
  @UseGuards(CrmIntegrationRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async syncContacts(
    @Headers('x-api-key') apiKey: string | undefined,
    @Headers('x-hmac-signature') signature: string | undefined,
    @Body() dto: SyncContactsDto,
  ) {
    if (!apiKey || !signature) {
      return { ok: false, error: 'API Key y HMAC signature requeridos' };
    }

    const integration = await this.service.verifyApiKey(apiKey);
    if (!integration) {
      return { ok: false, error: 'API Key inválida' };
    }

    const payload = JSON.stringify(dto);
    if (!this.service.verifyHmac(payload, signature)) {
      return { ok: false, error: 'Firma HMAC inválida' };
    }

    const userCheck = await this.service.checkUser(dto.userEmail, integration.organizationId);
    if (!userCheck.exists || !userCheck.user) {
      return { ok: false, error: `El usuario ${dto.userEmail} no existe en ChatControl` };
    }

    const user = await this.prisma.user.findUnique({
      where: { email: dto.userEmail.trim().toLowerCase() },
      select: { id: true, organizationId: true },
    });
    if (!user) {
      return { ok: false, error: `El usuario ${dto.userEmail} no existe en ChatControl` };
    }
    if (user.organizationId !== integration.organizationId) {
      return { ok: false, error: `El usuario ${dto.userEmail} no pertenece a la organización vinculada` };
    }

    const normalizedContacts = dto.contacts.map((c) => ({
      externalId: c.externalId || c.crmId || '',
      name: c.name,
      phone: c.phone,
      email: c.email,
      campaign: c.campaign,
      seller: c.seller,
      source: c.source,
    })).filter((c) => c.externalId && c.phone);

    const targetOrgId = integration.organizationId;
    const result = await this.service.syncContacts(
      targetOrgId,
      user.id,
      dto.listName,
      normalizedContacts,
      dto.crmUser,
      dto.crmName,
    );

    return {
      ok: true,
      created: result.created,
      updated: result.updated,
      rejected: result.rejected,
      listId: result.listId,
      total: result.created + result.updated + result.rejected,
      errors: result.errors,
    };
  }
}
