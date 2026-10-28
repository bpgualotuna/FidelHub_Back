import { Module } from '@nestjs/common';
import { CrmIntegrationsController } from './crm-integrations.controller';
import { CrmIntegrationsService } from './crm-integrations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [PrismaModule, ContactsModule],
  controllers: [CrmIntegrationsController],
  providers: [CrmIntegrationsService],
  exports: [CrmIntegrationsService],
})
export class CrmIntegrationsModule {}
