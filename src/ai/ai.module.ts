import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { SettingsModule } from '../settings/settings.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [SettingsModule, PrismaModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
