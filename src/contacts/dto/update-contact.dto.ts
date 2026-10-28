import { IsBoolean, IsOptional, IsString, IsEmail } from 'class-validator';

export class UpdateContactDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEmail({}, { message: 'Formato de correo electrónico inválido' })
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  tagId?: string;

  /** Solo pruebas: número autorizado en Meta (sandbox). TODO: eliminar en producción. */
  @IsBoolean()
  @IsOptional()
  isSandboxAuthorized?: boolean;
}
