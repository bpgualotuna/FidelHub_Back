import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CampaignsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, name: string, description?: string) {
    // Usamos una transacción para desactivar campañas existentes y crear la nueva como activa
    return this.prisma.$transaction(async (tx) => {
      // 1. Desactivar todas las campañas anteriores de esta organización
      await tx.campaign.updateMany({
        where: { organizationId, isActive: true },
        data: { isActive: false },
      });

      // 2. Crear la nueva campaña activa
      return tx.campaign.create({
        data: {
          organizationId,
          name,
          description,
          isActive: true,
        },
      });
    });
  }

  async findAll(organizationId: string) {
    return this.prisma.campaign.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async activate(organizationId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaña no encontrada');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Desactivar cualquier otra campaña activa de la organización
      await tx.campaign.updateMany({
        where: { organizationId, isActive: true },
        data: { isActive: false },
      });

      // 2. Activar la campaña solicitada
      return tx.campaign.update({
        where: { id: campaignId },
        data: { isActive: true },
      });
    });
  }

  async remove(organizationId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaña no encontrada');
    }

    return this.prisma.campaign.delete({
      where: { id: campaignId },
    });
  }
}
