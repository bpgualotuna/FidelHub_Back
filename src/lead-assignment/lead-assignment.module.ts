import { Module, forwardRef } from '@nestjs/common';
import { LeadAssignmentService } from './lead-assignment.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatModule } from '../chat/chat.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ChatModule), IntegrationsModule],
  providers: [LeadAssignmentService],
  exports: [LeadAssignmentService],
})
export class LeadAssignmentModule {}
