import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { computeAudiencePreview } from '../common/audience-preview.util';

export interface BroadcastListDto {
  id: string;
  name: string;
  source: string;
  contactCount: number;
  crmExportedAt: number | null;
  createdAt: number;
  assignedToUserId: string | null;
}

export interface BroadcastListDetailDto extends BroadcastListDto {
  contacts: Array<{
    id: string;
    contactId: string;
    phone: string;
    name: string | null;
    externalId: string | null;
    campaign: string | null;
    seller: string | null;
    canSend: boolean;
    windowSecondsRemaining: number;
    isSandboxAuthorized: boolean;
  }>;
}

export interface ImportExcelContactsResultDto {
  listId: string;
  created: number;
  updated: number;
  rejected: number;
  unmatchedTags: number;
  errors: Array<{ phone?: string; error: string }>;
  newContactIds: string[];
  conversationIds: string[];
  outOfWindowCount: number;
}

@Injectable()
export class BroadcastListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  async findAll(
    organizationId: string,
    userId?: string,
    userRole?: string,
    crmOnly = false,
  ): Promise<BroadcastListDto[]> {
    const where: {
      organizationId: string;
      source?: { in: string[] };
      assignedToUserId?: string;
    } = { organizationId };

    if (crmOnly) {
      where.source = { in: ['crm', 'excel'] };
    }
    if (userRole === UserRole.AGENT && userId) {
      where.assignedToUserId = userId;
    }

    const allLists = await this.prisma.broadcastList.findMany({
      where: { organizationId },
    });
    console.log('[BroadcastLists] todas las listas en org', organizationId, ':', allLists.map(l => ({ id: l.id, name: l.name, source: l.source, contactCount: l.contactCount, assignedToUserId: l.assignedToUserId })));

    const lists = await this.prisma.broadcastList.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    console.log('[BroadcastLists] lista filtrada (crmOnly=' + crmOnly + ', role=' + userRole + ', userId=' + userId + '):', lists.map(l => ({ id: l.id, name: l.name, source: l.source })));
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      source: l.source,
      contactCount: l.contactCount,
      crmExportedAt: l.crmExportedAt?.getTime() ?? null,
      createdAt: l.createdAt.getTime(),
      assignedToUserId: l.assignedToUserId,
    }));
  }

  async findOne(organizationId: string, id: string): Promise<BroadcastListDetailDto> {
    const list = await this.prisma.broadcastList.findFirst({
      where: { id, organizationId },
    });
    if (!list) throw new NotFoundException('Lista no encontrada');

    const listContacts = await this.prisma.broadcastListContact.findMany({
      where: { listId: id },
      include: {
        contact: true,
      },
    });

    return {
      id: list.id,
      name: list.name,
      source: list.source,
      contactCount: list.contactCount,
      crmExportedAt: list.crmExportedAt?.getTime() ?? null,
      createdAt: list.createdAt.getTime(),
      assignedToUserId: list.assignedToUserId,
      contacts: listContacts.map(lc => ({
        id: lc.id,
        contactId: lc.contactId,
        phone: lc.contact.phone,
        name: lc.contact.name,
        externalId: lc.externalId,
        campaign: lc.campaign,
        seller: lc.seller,
        canSend: true,
        windowSecondsRemaining: 0,
        isSandboxAuthorized: lc.contact.isSandboxAuthorized,
      })),
    };
  }

  async findContactsForBroadcast(organizationId: string, listId: string): Promise<string[]> {
    const list = await this.prisma.broadcastList.findFirst({
      where: { id: listId, organizationId },
    });
    if (!list) throw new NotFoundException('Lista no encontrada');

    const links = await this.prisma.broadcastListContact.findMany({
      where: { listId },
      include: { contact: true },
    });

    const conversationIds: string[] = [];
    for (const link of links) {
      const conv = await this.prisma.conversation.findFirst({
        where: { contactId: link.contactId },
      });
      if (conv) {
        conversationIds.push(conv.id);
      } else {
        const created = await this.prisma.conversation.create({
          data: { contactId: link.contactId },
        });
        conversationIds.push(created.id);
      }
    }
    return conversationIds;
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const list = await this.prisma.broadcastList.findFirst({
      where: { id, organizationId },
    });
    if (!list) throw new NotFoundException('Lista no encontrada');
    await this.prisma.broadcastList.delete({ where: { id } });
  }

  async previewLists(
    organizationId: string,
    listIds: string[],
    userId?: string,
    userRole?: string,
  ): Promise<{
    total: number;
    unique: number;
    duplicates: number;
    invalid: number;
    blocked: number;
    conversationIds: string[];
  }> {
    if (!listIds?.length) {
      throw new BadRequestException('Selecciona al menos una lista CRM');
    }

    const lists = await this.prisma.broadcastList.findMany({
      where: {
        id: { in: listIds },
        organizationId,
        source: { in: ['crm', 'excel'] },
        ...(userRole === UserRole.AGENT && userId ? { assignedToUserId: userId } : {}),
      },
    });
    if (!lists.length) {
      throw new NotFoundException('No se encontraron listas válidas');
    }

    const links = await this.prisma.broadcastListContact.findMany({
      where: { listId: { in: lists.map((l) => l.id) } },
      include: { contact: true },
    });

    const contacts = links.map((l) => ({ contactId: l.contactId, phone: l.contact.phone }));

    return computeAudiencePreview(this.prisma, this.chat, organizationId, contacts, userId, userRole);
  }

  async importExcelContacts(
    organizationId: string,
    userId: string | undefined,
    listName: string | undefined,
    rows: Array<{ name?: string; phone: string; tag?: string }>,
  ): Promise<ImportExcelContactsResultDto> {
    if (!rows?.length) {
      throw new BadRequestException('No hay contactos para importar');
    }

    const tags = await this.prisma.tag.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const tagIdByName = new Map(tags.map((t) => [t.name.trim().toUpperCase(), t.id]));

    const UPSERT_BATCH_SIZE = 50;
    const errors: Array<{ phone?: string; error: string }> = [];
    let rejected = 0;
    let unmatchedTags = 0;

    const prepared: Array<{ phone: string; name: string | null; tagId: string | null }> = [];
    const seenPhones = new Set<string>();
    for (const row of rows) {
      const phone = (row.phone || '').replace(/\D/g, '');
      if (!phone || phone.length < 7) {
        rejected++;
        errors.push({ phone: row.phone, error: 'Teléfono inválido' });
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

      prepared.push({ phone, name: row.name?.trim() || null, tagId });
    }

    if (!prepared.length) {
      throw new BadRequestException('Ningún contacto tiene un teléfono válido');
    }

    const name = listName?.trim() || `Excel ${new Date().toISOString().slice(0, 10)}`;
    let list = await this.prisma.broadcastList.findUnique({
      where: { organizationId_name: { organizationId, name } },
    });
    if (!list) {
      list = await this.prisma.broadcastList.create({
        data: { organizationId, name, source: 'excel', crmExportedAt: new Date(), createdBy: userId },
      });
    }

    const phones = prepared.map((p) => p.phone);
    const existingContacts = await this.prisma.contact.findMany({
      where: { organizationId, phone: { in: phones } },
      select: { id: true, phone: true },
    });
    const existingByPhone = new Set(existingContacts.map((c) => c.phone));
    const newContactPhones = phones.filter((p) => !existingByPhone.has(p));

    const contactByPhone = new Map<string, string>(existingContacts.map((c) => [c.phone, c.id]));
    for (let i = 0; i < prepared.length; i += UPSERT_BATCH_SIZE) {
      const chunk = prepared.slice(i, i + UPSERT_BATCH_SIZE);
      const upserted = await this.prisma.$transaction(
        chunk.map((item) =>
          this.prisma.contact.upsert({
            where: { organizationId_phone: { organizationId, phone: item.phone } },
            create: { organizationId, phone: item.phone, name: item.name, tagId: item.tagId },
            // Si la fila no trae nombre o etiqueta (o la etiqueta no existe), no se pisa el
            // dato ya guardado del contacto existente.
            update: {
              ...(item.name ? { name: item.name } : {}),
              ...(item.tagId ? { tagId: item.tagId } : {}),
            },
            select: { id: true, phone: true },
          }),
        ),
      );
      for (const c of upserted) contactByPhone.set(c.phone, c.id);
    }

    const contactIds = prepared.map((p) => contactByPhone.get(p.phone)!);
    const existingConversations = await this.prisma.conversation.findMany({
      where: { contactId: { in: contactIds } },
      select: { id: true, contactId: true },
    });
    const conversationByContact = new Map(existingConversations.map((c) => [c.contactId, c.id]));
    const conversationsToCreate = contactIds
      .filter((id) => !conversationByContact.has(id))
      .map((id) => ({ contactId: id }));
    if (conversationsToCreate.length) {
      await this.prisma.conversation.createMany({ data: conversationsToCreate });
      const created = await this.prisma.conversation.findMany({
        where: { contactId: { in: conversationsToCreate.map((c) => c.contactId) } },
        select: { id: true, contactId: true },
      });
      for (const c of created) conversationByContact.set(c.contactId, c.id);
    }
    // Solo los contactos de este archivo, no todo el historial de la lista (que puede acumular importaciones previas).
    const conversationIds = contactIds.map((id) => conversationByContact.get(id)!);

    // Sin userRole: necesitamos el estado de ventana de TODAS las conversaciones de la org,
    // no solo las asignadas al usuario actual (las recién creadas no tienen asignación todavía).
    const windowStatuses = await this.chat.getConversationsWithWindowStatus(organizationId);
    const canSendByConversation = new Map(windowStatuses.map((c) => [c.id, c.canSend]));
    const outOfWindowCount = conversationIds.filter((id) => !(canSendByConversation.get(id) ?? false)).length;

    for (let i = 0; i < prepared.length; i += UPSERT_BATCH_SIZE) {
      const chunk = prepared.slice(i, i + UPSERT_BATCH_SIZE);
      await this.prisma.$transaction(
        chunk.map((item) => {
          const contactId = contactByPhone.get(item.phone)!;
          return this.prisma.broadcastListContact.upsert({
            where: { listId_contactId: { listId: list.id, contactId } },
            create: { listId: list.id, contactId, source: 'excel' },
            update: {},
          });
        }),
      );
    }

    const count = await this.prisma.broadcastListContact.count({ where: { listId: list.id } });
    await this.prisma.broadcastList.update({ where: { id: list.id }, data: { contactCount: count } });

    const created = newContactPhones.length;
    const updated = prepared.length - created;
    const newContactIds = newContactPhones.map((p) => contactByPhone.get(p)!);

    return { listId: list.id, created, updated, rejected, unmatchedTags, errors, newContactIds, conversationIds, outOfWindowCount };
  }
}
