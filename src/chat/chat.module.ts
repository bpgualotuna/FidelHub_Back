import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { ConversationsQueryService } from './conversations-query.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AiModule } from '../ai/ai.module';
import { SettingsModule } from '../settings/settings.module';
import { LeadAssignmentModule } from '../lead-assignment/lead-assignment.module';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'default-secret-change-me'),
      }),
      inject: [ConfigService],
    }),
    forwardRef(() => WhatsAppModule),
    AiModule,
    SettingsModule,
    forwardRef(() => LeadAssignmentModule),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, ConversationsQueryService],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
