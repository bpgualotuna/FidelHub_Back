import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { Window24hService } from '../common/window-24h.service';
import { ChatModule } from '../chat/chat.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => ChatModule), AuthModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, Window24hService],
  exports: [WhatsAppService, Window24hService],
})
export class WhatsAppModule {}
