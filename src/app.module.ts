import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { ChatModule } from './chat/chat.module';
import { AiModule } from './ai/ai.module';
import { BroadcastModule } from './broadcast/broadcast.module';
import { ContactsModule } from './contacts/contacts.module';
import { TemplatesModule } from './templates/templates.module';
import { SettingsModule } from './settings/settings.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { PlatformModule } from './platform/platform.module';
import { OrgUsersModule } from './org-users/org-users.module';
import { OrgAuditModule } from './org-audit/org-audit.module';
import { LeadAssignmentModule } from './lead-assignment/lead-assignment.module';
import { CrmIntegrationsModule } from './crm-integrations/crm-integrations.module';
import { BroadcastListsModule } from './broadcast-lists/broadcast-lists.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { TagsModule } from './tags/tags.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    PrismaModule,
    AuthModule,
    WhatsAppModule,
    ChatModule,
    AiModule,
    BroadcastModule,
    BroadcastListsModule,
    ContactsModule,
    TemplatesModule,
    SettingsModule,
    IntegrationsModule,
    CrmIntegrationsModule,
    PlatformModule,
    OrgUsersModule,
    OrgAuditModule,
    LeadAssignmentModule,
    CampaignsModule,
    TagsModule,
  ],
})
export class AppModule {}
