import { IsNotEmpty, IsString } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}
