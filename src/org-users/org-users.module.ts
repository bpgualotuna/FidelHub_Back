import { Module } from '@nestjs/common';
import { OrgUsersController } from './org-users.controller';
import { OrgUsersService } from './org-users.service';
import { LeadAssignmentModule } from '../lead-assignment/lead-assignment.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [LeadAssignmentModule, IntegrationsModule],
  controllers: [OrgUsersController],
  providers: [OrgUsersService],
})
export class OrgUsersModule {}
