import { Injectable, OnModuleInit, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCryptoService } from '../common/secrets-crypto.service';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ContactsService } from '../contacts/contacts.service';

export interface CrmConnectionDto {
  organizationId: string;
  codigoVinculacion: string;
  crmUrl: string;
  crmName: string;
  apiKey: string;
  isActive: boolean;
  createdAt: Date;
}

export interface SyncContactDto {
  externalId: string;
  name?: string;
  phone: string;
  email?: string;
  campaign?: string;
  seller?: string;
  source?: string;
}

export interface SyncResultDto {
  created: number;
  updated: number;
  rejected: number;
  errors: Array<{ externalId: string; error: string }>;
}

@Injectable()
export class CrmIntegrationsService implements OnModuleInit {
  private readonly hmacSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
    private readonly config: ConfigService,
  ) {
    this.hmacSecret = this.config.get<string>('CRM_HMAC_SECRET', 'crm-integration-secret-change-me');
  }

  async onModuleInit() {
    try {
      const apiKey = this.config.get<string>('CRM_DEFAULT_API_KEY');
      if (!apiKey) return;

      const existing = await this.prisma.crmIntegration.findFirst({
        where: { isActive: true },
      });
      if (existing) return;

      const firstOrg = await this.prisma.organization.findFirst({
        where: { status: 'ACTIVE' },
      });
      if (!firstOrg) return;

      const code = this.generateCodigoVinculacion();
      const apiKeyHash = createHmac('sha256', this.hmacSecret).update(apiKey).digest('hex');
      const apiKeyEncrypted = this.crypto.encrypt(apiKey);

      await this.prisma.crmIntegration.create({
        data: {
          organizationId: firstOrg.id,
          codigoVinculacion: code,
          apiKeyHash,
          apiKeyEncrypted,
          isActive: true,
          crmName: 'CRM Ventas',
        },
      });
    } catch (err) {
      console.warn('[CrmIntegrations] No se pudo auto-crear integración (probablemente falta correr migración):', (err as Error).message);
    }
  }

  generateCodigoVinculacion(): string {
    const raw = randomBytes(6).toString('hex').toUpperCase();
    return `CRM-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  }

  verifyHmac(payload: string, signature: string): boolean {
    const expected = createHmac('sha256', this.hmacSecret).update(payload).digest('hex');
    try {
      const received = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (received.length !== expectedBuf.length) return false;
      return timingSafeEqual(received, expectedBuf);
    } catch {
      return false;
    }
  }

  async generateApiKey(organizationId: string, codigoVinculacion: string): Promise<{ apiKey: string; apiKeyEncrypted: string }> {
    const integration = await this.prisma.crmIntegration.findUnique({
      where: { codigoVinculacion },
    });
    if (!integration || integration.organizationId !== organizationId) {
      throw new NotFoundException('Código de vinculación inválido');
    }
    if (!integration.isActive) {
      throw new ForbiddenException('La integración está desactivada');
    }
    return this.createApiKey(integration.id);
  }

  async generateApiKeyByCode(codigoVinculacion: string): Promise<{ apiKey: string }> {
    const integration = await this.prisma.crmIntegration.findUnique({
      where: { codigoVinculacion },
    });
    if (!integration) {
      throw new NotFoundException('Código de vinculación inválido');
    }
    if (!integration.isActive) {
      throw new ForbiddenException('La integración está desactivada');
    }
    const result = await this.createApiKey(integration.id);
    return { apiKey: result.apiKey };
  }

  private async createApiKey(integrationId: string): Promise<{ apiKey: string; apiKeyEncrypted: string }> {
    const apiKey = randomBytes(32).toString('hex');
    const apiKeyHash = createHmac('sha256', this.hmacSecret).update(apiKey).digest('hex');
    const apiKeyEncrypted = this.crypto.encrypt(apiKey);
    await this.prisma.crmIntegration.update({
      where: { id: integrationId },
      data: { apiKeyHash, apiKeyEncrypted },
    });
    return { apiKey, apiKeyEncrypted };
  }

  async verifyApiKey(apiKey: string): Promise<{ organizationId: string; crmUrl: string | null } | null> {
    const apiKeyHash = createHmac('sha256', this.hmacSecret).update(apiKey).digest('hex');
    const integration = await this.prisma.crmIntegration.findFirst({
      where: { apiKeyHash, isActive: true },
      select: { organizationId: true, crmUrl: true },
    });
    if (!integration) return null;
    return { organizationId: integration.organizationId, crmUrl: integration.crmUrl };
  }

  async sendReportToCrm(
    organizationId: string,
    rows: Awaited<ReturnType<ContactsService['exportContacts']>>,
  ): Promise<{ ok: true; created: number; updated: number; duplicates: number; rejected: number; errors: unknown[] }> {
    const integration = await this.prisma.crmIntegration.findUnique({ where: { organizationId } });
    if (!integration?.isActive || !integration.apiKeyEncrypted) {
      throw new BadRequestException('Vincule el CRM desde Integraciones antes de enviar el informe');
    }
    const crmUrl = integration.crmUrl || this.config.get<string>('CRM_BASE_URL');
    if (!crmUrl) {
      throw new BadRequestException('Falta la URL del CRM. Vuelva a vincular el CRM desde Integraciones');
    }
    let url: URL;
    try {
      url = new URL('/api/integrations/chatcontrol/import-nextline', crmUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
        throw new Error('Protocolo no permitido');
      }
    } catch {
      throw new BadRequestException('La URL del CRM vinculada no es válida');
    }
    const valid = rows.filter((row) => {
      const digits = row.phone.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15;
    });
    const rejected = rows.length - valid.length;
    if (!valid.length) {
      return { ok: true, created: 0, updated: 0, duplicates: 0, rejected, errors: [] };
    }
    const payload = {
      leads: valid.map((row) => ({
        createdTime: new Date(row.createdAt).toISOString(),
        formName: row.form_name,
        platform: 'Nextline',
        fullName: row.name || row.phone,
        phoneNumber: row.phone,
        email: row.email || undefined,
        campaignName: row.campaign_name,
        nextlineContactId: row.contactId,
        crmLeadId: row.crmLeadId || undefined,
        nextlineTagId: row.tagId || null,
        nextlineTagName: row.tagName || null,
        nextlineAgentId: row.agentId || null,
        nextlineAgentName: row.agent === 'Sin asignar' ? null : row.agent,
        nextlineRegisteredAt: new Date(row.createdAt).toISOString(),
      })),
    };
    const timestamp = String(Date.now());
    const apiKey = this.crypto.decrypt(integration.apiKeyEncrypted);
    const signature = createHmac('sha256', apiKey)
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest('hex');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nextline-timestamp': timestamp,
          'x-nextline-signature': signature,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
        redirect: 'error',
      });
    } catch {
      throw new BadRequestException('No se pudo conectar con el CRM configurado');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new BadRequestException(result?.message || 'El CRM rechazó el envío');
    }
    return {
      ok: true,
      created: result.created || 0,
      updated: result.updated || 0,
      duplicates: result.duplicates || 0,
      rejected,
      errors: result.errors || [],
    };
  }

  async checkUser(
    email: string,
    organizationId?: string,
  ): Promise<{ exists: boolean; user?: { email: string; displayName: string; organizationName: string; role: string } }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      include: { organization: { select: { name: true, id: true } } },
    });
    if (!user || (organizationId && user.organizationId !== organizationId)) return { exists: false };
    return {
      exists: true,
      user: {
        email: user.email,
        displayName: user.displayName || user.email,
        organizationName: user.organization?.name || 'Sin organización',
        role: user.role,
      },
    };
  }

  async syncContacts(
    organizationId: string,
    assignedToUserId: string,
    listName: string,
    contacts: SyncContactDto[],
    crmUser?: string,
    crmName?: string,
  ): Promise<SyncResultDto & { listId: string }> {
    if (!contacts?.length) {
      throw new BadRequestException('No hay contactos para sincronizar');
    }

    const result: SyncResultDto = { created: 0, updated: 0, rejected: 0, errors: [] };
    const UPSERT_BATCH_SIZE = 50;

    type PreparedContact = SyncContactDto & { phone: string; crmLeadId: string };

    const prepared: PreparedContact[] = [];
    for (const contact of contacts) {
      const phone = contact.phone.replace(/\D/g, '');
      if (!phone) {
        result.rejected++;
        result.errors.push({
          externalId: contact.externalId,
          error: 'Teléfono inválido',
        });
        continue;
      }
      prepared.push({
        ...contact,
        phone,
        crmLeadId: contact.externalId || phone,
      });
    }

    if (!prepared.length) {
      throw new BadRequestException('Ningún contacto tiene un teléfono válido');
    }

    let list = await this.prisma.broadcastList.findUnique({
      where: { organizationId_name: { organizationId, name: listName } },
    });
    if (!list) {
      list = await this.prisma.broadcastList.create({
        data: {
          organizationId,
          name: listName,
          source: 'crm',
          crmExportedAt: new Date(),
          createdBy: crmUser,
          assignedToUserId,
        },
      });
    }

    const phones = [...new Set(prepared.map((c) => c.phone))];
    const existingContacts = await this.prisma.contact.findMany({
      where: { organizationId, phone: { in: phones } },
      select: { id: true, phone: true },
    });
    const existingByPhone = new Map(existingContacts.map((c) => [c.phone, c]));

    const contactsToCreate = phones
      .filter((phone) => !existingByPhone.has(phone))
      .map((phone) => {
        const item = prepared.find((c) => c.phone === phone)!;
        return {
          organizationId,
          phone,
          name: item.name?.trim() || null,
        };
      });

    if (contactsToCreate.length) {
      await this.prisma.contact.createMany({
        data: contactsToCreate,
        skipDuplicates: true,
      });
    }

    const allContacts = await this.prisma.contact.findMany({
      where: { organizationId, phone: { in: phones } },
      select: { id: true, phone: true },
    });
    const contactByPhone = new Map(allContacts.map((c) => [c.phone, c]));

    for (const item of prepared) {
      if (!contactByPhone.has(item.phone)) {
        result.rejected++;
        result.errors.push({
          externalId: item.externalId,
          error: 'No se pudo crear o recuperar el contacto',
        });
      }
    }

    const validItems = prepared.filter((item) => contactByPhone.has(item.phone));
    result.created = validItems.filter((item) => !existingByPhone.has(item.phone)).length;
    result.updated = validItems.filter((item) => existingByPhone.has(item.phone)).length;

    const contactIds = validItems.map((item) => contactByPhone.get(item.phone)!.id);
    const existingConversations = await this.prisma.conversation.findMany({
      where: { contactId: { in: contactIds } },
      select: { contactId: true },
    });
    const contactsWithConversation = new Set(existingConversations.map((c) => c.contactId));
    const conversationsToCreate = contactIds
      .filter((contactId) => !contactsWithConversation.has(contactId))
      .map((contactId) => ({ contactId }));

    if (conversationsToCreate.length) {
      await this.prisma.conversation.createMany({
        data: conversationsToCreate,
      });
    }

    for (let i = 0; i < validItems.length; i += UPSERT_BATCH_SIZE) {
      const chunk = validItems.slice(i, i + UPSERT_BATCH_SIZE);
      await this.prisma.$transaction(
        chunk.flatMap((item) => {
          const dbContact = contactByPhone.get(item.phone)!;
          const externalData = {
            campaign: item.campaign,
            seller: item.seller,
            source: item.source || 'crm',
            name: item.name,
            email: item.email,
          };

          return [
            this.prisma.broadcastListContact.upsert({
              where: {
                listId_contactId: { listId: list.id, contactId: dbContact.id },
              },
              create: {
                listId: list.id,
                contactId: dbContact.id,
                externalId: item.externalId,
                campaign: item.campaign,
                seller: item.seller,
                source: item.source || 'crm',
              },
              update: {
                externalId: item.externalId,
                campaign: item.campaign,
                seller: item.seller,
              },
            }),
            this.prisma.crmContactLink.upsert({
              where: {
                organizationId_crmLeadId: {
                  organizationId,
                  crmLeadId: item.crmLeadId,
                },
              },
              create: {
                organizationId,
                crmLeadId: item.crmLeadId,
                chatcontrolContactId: dbContact.id,
                phone: item.phone,
                listId: list.id,
                assignedToUserId,
                externalData,
              },
              update: {
                chatcontrolContactId: dbContact.id,
                phone: item.phone,
                listId: list.id,
                assignedToUserId,
                externalData,
              },
            }),
          ];
        }),
      );
    }

    const [count] = await Promise.all([
      this.prisma.broadcastListContact.count({ where: { listId: list.id } }),
      this.prisma.crmAuditLog.create({
        data: {
          organizationId,
          action: 'contacts_exported',
          crmUser,
          crmName,
          contactsTotal: contacts.length,
          contactsCreated: result.created,
          contactsUpdated: result.updated,
          contactsRejected: result.rejected,
          listName,
          details: {
            errors: result.errors,
            assignedToUserId,
            listId: list.id,
          },
        },
      }),
    ]);

    await this.prisma.broadcastList.update({
      where: { id: list.id },
      data: { contactCount: count },
    });

    return { ...result, listId: list.id };
  }
}
