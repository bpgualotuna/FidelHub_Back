import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class AssignRunTagDto {
  @IsString()
  @MinLength(1)
  tagId!: string;

  /** Si es true, solo vincula contactos con envío exitoso. Por defecto, todos los del masivo. */
  @IsBoolean()
  @IsOptional()
  onlySent?: boolean;
}
