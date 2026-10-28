import { Global, Module } from '@nestjs/common';
import { SecretsCryptoService } from './secrets-crypto.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [SecretsCryptoService, StorageService],
  exports: [SecretsCryptoService, StorageService],
})
export class CommonModule {}
