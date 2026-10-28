import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaService };

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super();
    if (globalForPrisma.prisma) {
      return globalForPrisma.prisma;
    }
    globalForPrisma.prisma = this;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
