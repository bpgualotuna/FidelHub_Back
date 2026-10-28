import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { McpHubController } from './mcp-hub.controller';
import { McpHubService } from './mcp-hub.service';

@Module({
  imports: [CommonModule],
  controllers: [McpHubController],
  providers: [McpHubService],
  exports: [McpHubService],
})
export class McpHubModule {}
