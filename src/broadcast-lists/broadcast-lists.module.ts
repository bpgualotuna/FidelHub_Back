import { Module } from '@nestjs/common';
import { BroadcastListsController } from './broadcast-lists.controller';
import { BroadcastListsService } from './broadcast-lists.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [PrismaModule, ChatModule],
  controllers: [BroadcastListsController],
  providers: [BroadcastListsService],
  exports: [BroadcastListsService],
})
export class BroadcastListsModule {}
