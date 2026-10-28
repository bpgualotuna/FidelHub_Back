import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Cifrado AES-256-GCM para secretos en BD.
 * Requiere ENCRYPTION_MASTER_KEY (mín. 32 caracteres recomendado).
 */
@Injectable()
export class SecretsCryptoService {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const secret = this.config.get<string>('ENCRYPTION_MASTER_KEY', '');
    if (!secret || secret.length < 32) {
      throw new InternalServerErrorException(
        'ENCRYPTION_MASTER_KEY no configurada o demasiado corta (mín. 32 caracteres).',
      );
    }
    return scryptSync(secret, 'chatcontrol-secrets', 32);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
  }

  decrypt(blob: string): string {
    try {
      const buf = Buffer.from(blob, 'base64url');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('No se pudo descifrar el secreto');
    }
  }
}
