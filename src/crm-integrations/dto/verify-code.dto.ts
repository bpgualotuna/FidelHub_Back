import { IsString, IsNotEmpty, MinLength, MaxLength, Matches } from 'class-validator';

export class VerifyCodeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^CRM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, {
    message: 'El código de vinculación debe tener el formato CRM-XXXX-XXXX-XXXX',
  })
  codigoVinculacion!: string;
}
