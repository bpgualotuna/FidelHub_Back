import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ChatModule } from '../chat/chat.module';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { FacebookAdapter } from './adapters/facebook.adapter';
import { TikTokAdapter } from './adapters/tiktok.adapter';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';

@Module({
  imports: [CommonModule, forwardRef(() => WhatsAppModule), forwardRef(() => ChatModule)],
  controllers: [ChannelsController],
  providers: [InstagramAdapter, FacebookAdapter, TikTokAdapter, ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
