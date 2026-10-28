import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { SettingsModule } from '../settings/settings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { McpHubModule } from '../mcp-hub/mcp-hub.module';

@Module({
  imports: [SettingsModule, PrismaModule, McpHubModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
