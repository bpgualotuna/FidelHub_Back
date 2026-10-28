import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function extractVariables(body: string): string[] {
  const matches = body.matchAll(/\{\{\s*(\w+)\s*\}\}/g);
  const vars = new Set<string>();
  for (const m of matches) vars.add(m[1]);
  return Array.from(vars);
}

export interface TemplateDto {
  id: string;
  name: string;
  body: string;
  variables: string[];
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId: string): Promise<TemplateDto[]> {
    const list = await this.prisma.template.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return list.map((t) => ({
      id: t.id,
      name: t.name,
      body: t.body,
      variables: t.variables,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
    }));
  }

  async findOne(organizationId: string, id: string): Promise<TemplateDto | null> {
    const t = await this.prisma.template.findFirst({
      where: { id, organizationId },
    });
    if (!t) return null;
    return {
      id: t.id,
      name: t.name,
      body: t.body,
      variables: t.variables,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
    };
  }

  async create(organizationId: string, params: { name: string; body: string }): Promise<TemplateDto> {
    const name = params.name?.trim();
    const body = params.body?.trim();
    if (!name) throw new BadRequestException('El nombre no puede estar vacío');
    if (!body) throw new BadRequestException('El cuerpo de la plantilla no puede estar vacío');
    const variables = extractVariables(body);
    const t = await this.prisma.template.create({
      data: { organizationId, name, body, variables },
    });
    return {
      id: t.id,
      name: t.name,
      body: t.body,
      variables: t.variables,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
    };
  }

  async update(
    organizationId: string,
    id: string,
    params: { name?: string; body?: string },
  ): Promise<TemplateDto> {
    const existing = await this.prisma.template.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Plantilla no encontrada');
    const name = params.name !== undefined ? params.name.trim() : undefined;
    const body = params.body !== undefined ? params.body.trim() : undefined;
    if (name !== undefined && !name) throw new BadRequestException('El nombre no puede estar vacío');
    if (body !== undefined && !body) throw new BadRequestException('El cuerpo no puede estar vacío');
    const variables = body !== undefined ? extractVariables(body) : undefined;
    const t = await this.prisma.template.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(body !== undefined && { body }),
        ...(variables !== undefined && { variables }),
      },
    });
    return {
      id: t.id,
      name: t.name,
      body: t.body,
      variables: t.variables,
      createdAt: t.createdAt.getTime(),
      updatedAt: t.updatedAt.getTime(),
    };
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const existing = await this.prisma.template.findFirst({
      where: { id, organizationId },
    });
    if (!existing) throw new NotFoundException('Plantilla no encontrada');
    await this.prisma.template.delete({ where: { id } });
  }
}
