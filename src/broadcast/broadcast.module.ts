import { Module } from '@nestjs/common';
import { BroadcastController } from './broadcast.controller';
import { BroadcastService } from './broadcast.service';
import { ChatModule } from '../chat/chat.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AiModule } from '../ai/ai.module';
import { SettingsModule } from '../settings/settings.module';
import { TemplatesModule } from '../templates/templates.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, ChatModule, WhatsAppModule, AiModule, SettingsModule, TemplatesModule],
  controllers: [BroadcastController],
  providers: [BroadcastService],
  exports: [BroadcastService],
})
export class BroadcastModule {}
