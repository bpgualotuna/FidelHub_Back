import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ContactDto {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  tagId: string | null;
  tagName: string | null;
  interestStatus: string | null;
  isSandboxAuthorized: boolean;
  createdAt: number;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export interface ImportContactsResultDto {
  created: number;
  updated: number;
  rejected: number;
  unmatchedTags: number;
}

export interface ContactsFilter {
  q?: string;
  campaignIds?: string[];
  agentIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  tagIds?: string[];
  interestStatus?: string;
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) { }

  private buildWhere(organizationId: string, userId?: string, userRole?: string, filter?: ContactsFilter) {
    const where: any = { organizationId };
    if (userRole === 'AGENT' && userId) {
      where.conversations = {
        some: { assignedToUserId: userId }
      };
    } else if (filter?.agentIds?.length) {
      where.conversations = {
        some: { assignedToUserId: { in: filter.agentIds } }
      };
    }
    if (filter?.q?.trim()) {
      const q = filter.q.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (filter?.campaignIds?.length) {
      where.campaignId = { in: filter.campaignIds };
    }
    if (filter?.tagIds?.length) {
      where.tagId = { in: filter.tagIds };
    }
    if (filter?.interestStatus === 'UNANSWERED') where.interestStatus = null;
    else if (filter?.interestStatus === 'INTERESTED' || filter?.interestStatus === 'NOT_INTERESTED') {
      where.interestStatus = filter.interestStatus;
    }
    if (filter?.dateFrom || filter?.dateTo) {
      where.createdAt = {};
      if (filter.dateFrom) where.createdAt.gte = new Date(filter.dateFrom);
      if (filter.dateTo) {
        const end = new Date(filter.dateTo);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }
    return where;
  }

  async findAll(
    organizationId: string,
    userId?: string,
    userRole?: string,
    filter?: ContactsFilter,
    cursor?: string,
    limit?: number,
  ): Promise<{ contacts: ContactDto[]; nextCursor: string | null; total: number }> {
    const where = this.buildWhere(organizationId, userId, userRole, filter);
    const take = limit && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

    const [rows, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        take: take + 1,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { createdAt: 'desc' },
        include: { tag: true },
      }),
      this.prisma.contact.count({ where }),
    ]);

    let nextCursor: string | null = null;
    if (rows.length > take) {
      nextCursor = rows.pop()!.id;
    }

    return {
      contacts: rows.map((c) => ({
        id: c.id,
        phone: c.phone,
        name: c.name,
        email: c.email,
        tagId: c.tagId,
        tagName: c.tag?.name ?? null,
        interestStatus: c.interestStatus,
        isSandboxAuthorized: c.isSandboxAuthorized,
        createdAt: c.createdAt.getTime(),
      })),
      nextCursor,
      total,
    };
  }

  async findAllIds(organizationId: string, userId?: string, userRole?: string, filter?: ContactsFilter): Promise<string[]> {
    const where = this.buildWhere(organizationId, userId, userRole, filter);
    const rows = await this.prisma.contact.findMany({ where, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private async validateTagId(organizationId: string, tagId: string | null | undefined): Promise<void> {
    if (!tagId) return;
    const tag = await this.prisma.tag.findFirst({ where: { id: tagId, organizationId } });
    if (!tag) throw new BadRequestException('Etiqueta inválida');
  }

  async createOrUpdate(
    organizationId: string,
    params: {
      phone: string;
      name?: string;
      email?: string;
      tagId?: string | null;
      isSandboxAuthorized?: boolean;
    },
  ): Promise<ContactDto> {
    const phone = normalizePhone(params.phone);
    if (!phone) throw new BadRequestException('El número no puede estar vacío');
    await this.validateTagId(organizationId, params.tagId);
    const contact = await this.prisma.contact.upsert({
      where: {
        organizationId_phone: { organizationId, phone },
      },
      create: {
        organizationId,
        phone,
        name: params.name?.trim() || null,
        email: params.email?.trim() || null,
        tagId: params.tagId || null,
        isSandboxAuthorized: params.isSandboxAuthorized ?? false,
      },
      update: {
        name: params.name !== undefined ? params.name?.trim() || null : undefined,
        email: params.email !== undefined ? params.email?.trim() || null : undefined,
        tagId: params.tagId !== undefined ? params.tagId || null : undefined,
        isSandboxAuthorized: params.isSandboxAuthorized ?? undefined,
      },
      include: { tag: true },
    });
    const existing = await this.prisma.conversation.findFirst({
      where: { contactId: contact.id },
    });
    if (!existing) {
      await this.prisma.conversation.create({
        data: { contactId: contact.id },
      });
    }
    return {
      id: contact.id,
      phone: contact.phone,
      name: contact.name,
      email: contact.email,
      tagId: contact.tagId,
      tagName: contact.tag?.name ?? null,
      interestStatus: contact.interestStatus,
      isSandboxAuthorized: contact.isSandboxAuthorized,
      createdAt: contact.createdAt.getTime(),
    };
  }

  async update(
    organizationId: string,
    id: string,
    params: { name?: string; email?: string; tagId?: string | null; isSandboxAuthorized?: boolean },
  ): Promise<ContactDto> {
    const existing = await this.prisma.contact.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Contacto no encontrado');
    await this.validateTagId(organizationId, params.tagId);
    const contact = await this.prisma.contact.update({
      where: { id },
      data: {
        name: params.name !== undefined ? params.name?.trim() || null : undefined,
        email: params.email !== undefined ? params.email?.trim() || null : undefined,
        tagId: params.tagId !== undefined ? params.tagId || null : undefined,
        isSandboxAuthorized: params.isSandboxAuthorized ?? undefined,
      },
      include: { tag: true },
    });
    return {
      id: contact.id,
      phone: contact.phone,
      name: contact.name,
      email: contact.email,
      tagId: contact.tagId,
      tagName: contact.tag?.name ?? null,
      interestStatus: contact.interestStatus,
      isSandboxAuthorized: contact.isSandboxAuthorized,
      createdAt: contact.createdAt.getTime(),
    };
  }

  async findOne(organizationId: string, id: string, userId?: string, userRole?: string): Promise<ContactDto | null> {
    const where: any = { id, organizationId };
    if (userRole === 'AGENT' && userId) {
      where.conversations = {
        some: { assignedToUserId: userId }
      };
    }
    const contact = await this.prisma.contact.findFirst({
      where,
      include: { tag: true },
    });
    if (!contact) return null;
    return {
      id: contact.id,
      phone: contact.phone,
      name: contact.name,
      email: contact.email,
      tagId: contact.tagId,
      tagName: contact.tag?.name ?? null,
      interestStatus: contact.interestStatus,
      isSandboxAuthorized: contact.isSandboxAuthorized,
      createdAt: contact.createdAt.getTime(),
    };
  }

  async getExportGroupedByCampaign(
    organizationId: string,
    campaignIds: string[],
    contactIds: string[],
    userId?: string,
    userRole?: string,
  ): Promise<Array<{
    campaign: {
      id: string;
      name: string;
      description: string | null;
      isActive: boolean;
      createdAt: number;
    };
    contacts: Array<{
      contactId: string;
      campaign_name: string;
      form_name: string;
      email: string;
      name: string;
      phone: string;
      agent: string;
      assignedAt?: number;
    }>;
  }>> {
    const campaigns = await this.prisma.campaign.findMany({
      where: { id: { in: campaignIds }, organizationId },
    });

    const campaignContactsDirect = await this.prisma.contact.findMany({
      where: {
        campaignId: { in: campaignIds },
        id: { in: contactIds },
        organizationId,
      },
      select: { id: true, campaignId: true, createdAt: true },
    });

    const contactIdsInCampaigns = campaignContactsDirect.map(c => c.id);

    const where: any = { organizationId, id: { in: contactIdsInCampaigns } };
    if (userRole === 'AGENT' && userId) {
      where.conversations = { some: { assignedToUserId: userId } };
    }

    const contacts = await this.prisma.contact.findMany({
      where,
      include: {
        conversations: {
          where: userRole === 'AGENT' && userId
            ? { assignedToUserId: userId }
            : {},
          include: {
            assignedToUser: {
              select: { id: true, email: true, displayName: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const contactMap = new Map(contacts.map(c => [c.id, c]));

    const result: Array<{
      campaign: any;
      contacts: any[];
    }> = [];

    const campaignGroup: Record<string, typeof campaignContactsDirect> = {};
    for (const c of campaignContactsDirect) {
      if (!campaignGroup[c.campaignId!]) campaignGroup[c.campaignId!] = [];
      campaignGroup[c.campaignId!].push(c);
    }

    for (const campaign of campaigns) {
      const records = campaignGroup[campaign.id] || [];
      const campaignContacts: any[] = [];

      const seenContactIds = new Set<string>();
      for (const r of records) {
        if (seenContactIds.has(r.id)) continue;
        seenContactIds.add(r.id);

        const c = contactMap.get(r.id);
        if (!c) continue;

        const conversation = c.conversations?.[0];
        const assignedUser = conversation?.assignedToUser;
        const agentName = assignedUser
          ? assignedUser.displayName || assignedUser.email
          : 'Sin asignar';

        campaignContacts.push({
          contactId: c.id,
          campaign_name: campaign.name,
          form_name: 'WSP KRAKE DEV',
          email: c.email ?? '',
          name: c.name ?? '',
          phone: c.phone,
          agent: agentName,
          assignedAt: r.createdAt.getTime(),
        });
      }

      result.push({
        campaign: {
          id: campaign.id,
          name: campaign.name,
          description: campaign.description,
          isActive: campaign.isActive,
          createdAt: campaign.createdAt.getTime(),
        },
        contacts: campaignContacts,
      });
    }

    return result;
  }

  async getCampaignContacts(
    organizationId: string,
    campaignIds: string[],
  ): Promise<Record<string, string[]>> {
    const contacts = await this.prisma.contact.findMany({
      where: {
        campaignId: { in: campaignIds },
        organizationId,
      },
      select: { id: true, campaignId: true },
    });

    const byCampaign: Record<string, string[]> = {};
    for (const c of contacts) {
      if (!byCampaign[c.campaignId!]) byCampaign[c.campaignId!] = [];
      byCampaign[c.campaignId!].push(c.id);
    }

    return byCampaign;
  }

  async getAgentContactMap(
    organizationId: string,
    agentIds: string[],
    dateFrom?: string,
    dateTo?: string,
    interestStatus?: string,
  ): Promise<Record<string, string[]>> {
    if (!agentIds.length) return {};
    const contactDateFilter: any = { organizationId };
    if (interestStatus === 'UNANSWERED') contactDateFilter.interestStatus = null;
    else if (interestStatus === 'INTERESTED' || interestStatus === 'NOT_INTERESTED') {
      contactDateFilter.interestStatus = interestStatus;
    }
    if (dateFrom || dateTo) {
      contactDateFilter.createdAt = {};
      if (dateFrom) contactDateFilter.createdAt.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        contactDateFilter.createdAt.lte = end;
      }
    }
    const conversations = await this.prisma.conversation.findMany({
      where: {
        assignedToUserId: { in: agentIds },
        contact: contactDateFilter,
      },
      select: { contactId: true, assignedToUserId: true },
    });

    const byAgent: Record<string, Set<string>> = {};
    for (const c of conversations) {
      if (!c.assignedToUserId) continue;
      if (!byAgent[c.assignedToUserId]) byAgent[c.assignedToUserId] = new Set();
      byAgent[c.assignedToUserId].add(c.contactId);
    }

    const result: Record<string, string[]> = {};
    for (const [agentId, ids] of Object.entries(byAgent)) result[agentId] = Array.from(ids);
    return result;
  }

  async exportContacts(
    organizationId: string,
    contactIds: string[],
    userId?: string,
    userRole?: string,
  ): Promise<Array<{
    contactId: string;
    crmLeadId: string;
    tagId: string;
    tagName: string;
    agentId: string;
    campaign_name: string;
    form_name: string;
    email: string;
    name: string;
    phone: string;
    agent: string;
    createdAt: number;
  }>> {
    // Get the active campaign for this org
    const activeCampaign = await this.prisma.campaign.findFirst({
      where: { organizationId, isActive: true },
    });
    const campaignName = activeCampaign?.name ?? 'Sin campaña';

    // Build the where clause based on role
    const where: any = { organizationId, id: { in: contactIds } };
    if (userRole === 'AGENT' && userId) {
      where.conversations = {
        some: { assignedToUserId: userId },
      };
    }

    const contacts = await this.prisma.contact.findMany({
      where,
      include: {
        tag: true,
        crmContactLinks: {
          select: { crmLeadId: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        conversations: {
          where: userRole === 'AGENT' && userId
            ? { assignedToUserId: userId }
            : {},
          include: {
            assignedToUser: {
              select: { id: true, email: true, displayName: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return contacts.map((c) => {
      const conversation = c.conversations[0];
      const assignedUser = conversation?.assignedToUser;
      const agentName = assignedUser
        ? assignedUser.displayName || assignedUser.email
        : 'Sin asignar';

      return {
        contactId: c.id,
        crmLeadId: c.crmContactLinks[0]?.crmLeadId ?? '',
        tagId: c.tagId ?? '',
        tagName: c.tag?.name ?? '',
        agentId: assignedUser?.id ?? '',
        campaign_name: campaignName,
        form_name: 'WSP KRAKE DEV',
        email: c.email ?? '',
        name: c.name ?? '',
        phone: c.phone,
        agent: agentName,
        createdAt: c.createdAt.getTime(),
      };
    });
  }

  /**
   * Alta/actualización masiva de contactos desde Excel (upsert por teléfono, igual que el
   * registro manual). Si una celda opcional (nombre/correo/etiqueta) viene vacía, no pisa el
   * valor ya guardado de un contacto existente — solo actualiza los campos que sí traen dato.
   */
  async importFromExcel(
    organizationId: string,
    rows: Array<{ name?: string; phone: string; email?: string; tag?: string }>,
  ): Promise<ImportContactsResultDto> {
    if (!rows?.length) {
      throw new BadRequestException('No hay contactos para importar');
    }

    const tags = await this.prisma.tag.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const tagIdByName = new Map(tags.map((t) => [t.name.trim().toUpperCase(), t.id]));

    let rejected = 0;
    let unmatchedTags = 0;
    const prepared: Array<{ phone: string; name: string | null; email: string | null; tagId: string | null }> = [];
    const seenPhones = new Set<string>();

    for (const row of rows) {
      const phone = normalizePhone(row.phone || '');
      if (!phone || phone.length < 7) {
        rejected++;
        continue;
      }
      if (seenPhones.has(phone)) continue;
      seenPhones.add(phone);

      let tagId: string | null = null;
      const tagName = row.tag?.trim();
      if (tagName) {
        const matched = tagIdByName.get(tagName.toUpperCase());
        if (matched) tagId = matched;
        else unmatchedTags++;
      }

      prepared.push({
        phone,
        name: row.name?.trim() || null,
        email: row.email?.trim() || null,
        tagId,
      });
    }

    if (!prepared.length) {
      throw new BadRequestException('Ningún contacto tiene un teléfono válido');
    }

    const phones = prepared.map((p) => p.phone);
    const existing = await this.prisma.contact.findMany({
      where: { organizationId, phone: { in: phones } },
      select: { phone: true },
    });
    const existingPhones = new Set(existing.map((c) => c.phone));

    const BATCH_SIZE = 50;
    let created = 0;
    let updated = 0;
    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const chunk = prepared.slice(i, i + BATCH_SIZE);
      await this.prisma.$transaction(
        chunk.map((item) =>
          this.prisma.contact.upsert({
            where: { organizationId_phone: { organizationId, phone: item.phone } },
            create: {
              organizationId,
              phone: item.phone,
              name: item.name,
              email: item.email,
              tagId: item.tagId,
            },
            update: {
              ...(item.name ? { name: item.name } : {}),
              ...(item.email ? { email: item.email } : {}),
              ...(item.tagId ? { tagId: item.tagId } : {}),
            },
          }),
        ),
      );
      for (const item of chunk) {
        if (existingPhones.has(item.phone)) updated++;
        else created++;
      }
    }

    return { created, updated, rejected, unmatchedTags };
  }
}
