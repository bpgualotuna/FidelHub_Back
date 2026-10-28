import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class StorageService {
  private supabase: SupabaseClient;
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly config: ConfigService) {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL', '');
    const supabaseKey = this.config.get<string>('SUPABASE_KEY', ''); // Puede ser el anon_key o el service_role_key

    if (!supabaseUrl || !supabaseKey) {
      this.logger.warn('SUPABASE_URL o SUPABASE_KEY no definidos. StorageService no funcionará correctamente.');
    }

    this.supabase = createClient(supabaseUrl || 'http://localhost', supabaseKey || 'dummy');
  }

  /**
   * Sube un archivo al bucket de Supabase y retorna la URL pública.
   * @param bucketName Nombre del bucket (ej. 'chat-media')
   * @param path Ruta dentro del bucket (ej. 'chats/org1/123.jpg')
   * @param fileBuffer Buffer con los datos del archivo
   * @param mimeType Mime type del archivo (ej. 'image/jpeg')
   * @returns URL pública del archivo
   */
  async uploadFile(
    bucketName: string,
    path: string,
    fileBuffer: Buffer,
    mimeType: string,
  ): Promise<string | null> {
    try {
      const { data, error } = await this.supabase.storage
        .from(bucketName)
        .upload(path, fileBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (error) {
        this.logger.error(`Error subiendo archivo a Supabase Storage: ${error.message}`);
        return null;
      }

      const { data: publicUrlData } = this.supabase.storage
        .from(bucketName)
        .getPublicUrl(path);

      return publicUrlData.publicUrl;
    } catch (e) {
      this.logger.error('Excepción subiendo archivo a Supabase', e);
      return null;
    }
  }
}
