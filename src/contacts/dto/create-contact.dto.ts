import { IsBoolean, IsOptional, IsString, Matches, MinLength, IsEmail } from 'class-validator';

export class CreateContactDto {
  @IsString()
  @MinLength(1)
  @Matches(/^[0-9+\s\-()]+$/, { message: 'El número debe contener solo dígitos y opcionalmente +, espacios o guiones' })
  phone!: string;

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
