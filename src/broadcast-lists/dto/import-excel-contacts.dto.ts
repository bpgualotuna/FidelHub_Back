import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, MinLength, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class ImportExcelContactRowDto {
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
  @MaxLength(100)
  tag?: string;
}

export class ImportExcelContactsDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  listName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportExcelContactRowDto)
  contacts!: ImportExcelContactRowDto[];
}
