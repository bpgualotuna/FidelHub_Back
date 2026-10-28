import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { computeAudiencePreview, AudiencePreviewResult } from '../common/audience-preview.util';

export interface TagDto {
  id: string;
  organizationId: string;
  name: string;
  createdAt: number;
  contactCount: number;
}

@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  private toDto(tag: { id: string; organizationId: string; name: string; createdAt: Date; _count?: { contacts: number } }): TagDto {
    return {
      id: tag.id,
      organizationId: tag.organizationId,
      name: tag.name,
      createdAt: tag.createdAt.getTime(),
      contactCount: tag._count?.contacts ?? 0,
    };
  }

  async findAll(organizationId: string): Promise<TagDto[]> {
    const tags = await this.prisma.tag.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { contacts: true } } },
    });
    return tags.map((t) => this.toDto(t));
  }

  async create(organizationId: string, name: string): Promise<TagDto> {
    const trimmed = name?.trim().toUpperCase();
    if (!trimmed) throw new BadRequestException('El nombre de la etiqueta no puede estar vacío');
    try {
      const tag = await this.prisma.tag.create({
        data: { organizationId, name: trimmed },
        include: { _count: { select: { contacts: true } } },
      });
      return this.toDto(tag);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('Ya existe una etiqueta con ese nombre');
      }
      throw err;
    }
  }

  async update(organizationId: string, id: string, name: string): Promise<TagDto> {
    const trimmed = name?.trim().toUpperCase();
    if (!trimmed) throw new BadRequestException('El nombre de la etiqueta no puede estar vacío');
    const existing = await this.prisma.tag.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException('Etiqueta no encontrada');
    try {
      const tag = await this.prisma.tag.update({
        where: { id },
        data: { name: trimmed },
        include: { _count: { select: { contacts: true } } },
      });
      return this.toDto(tag);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('Ya existe una etiqueta con ese nombre');
      }
      throw err;
    }
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const existing = await this.prisma.tag.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundException('Etiqueta no encontrada');
    await this.prisma.tag.delete({ where: { id } });
  }

  async previewByTags(
    organizationId: string,
    tagIds: string[],
    userId?: string,
    userRole?: string,
  ): Promise<AudiencePreviewResult> {
    if (!tagIds?.length) {
      throw new BadRequestException('Selecciona al menos una etiqueta');
    }

    const contacts = await this.prisma.contact.findMany({
      where: { organizationId, tagId: { in: tagIds } },
      select: { id: true, phone: true },
    });

    const audience = contacts.map((c) => ({ contactId: c.id, phone: c.phone }));

    return computeAudiencePreview(this.prisma, this.chat, organizationId, audience, userId, userRole);
  }
}
