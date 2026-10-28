import { Module } from '@nestjs/common';
import { OrgAuditController } from './org-audit.controller';
import { OrgAuditService } from './org-audit.service';

@Module({
  controllers: [OrgAuditController],
  providers: [OrgAuditService],
})
export class OrgAuditModule {}
