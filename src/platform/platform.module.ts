import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformAuditController } from './platform-audit.controller';
import { PlatformService } from './platform.service';

@Module({
  controllers: [PlatformController, PlatformAuditController],
  providers: [PlatformService],
})
export class PlatformModule {}
