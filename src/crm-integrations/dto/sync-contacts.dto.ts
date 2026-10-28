import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, MinLength, MaxLength, IsEmail } from 'class-validator';
import { Type } from 'class-transformer';

export class SyncContactItemDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  externalId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  crmId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(7)
  @MaxLength(20)
  phone!: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  campaign?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  seller?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  source?: string;
}

export class SyncContactsDto {
  @IsEmail()
  @IsNotEmpty()
  userEmail!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  listName!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncContactItemDto)
  contacts!: SyncContactItemDto[];

  @IsString()
  @IsOptional()
  crmUser?: string;

  @IsString()
  @IsOptional()
  crmName?: string;
}
