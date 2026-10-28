import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatModule } from '../chat/chat.module';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';

@Module({
  imports: [PrismaModule, ChatModule],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
