import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export type BroadcastMessageType = 'manual' | 'template' | 'ia';

const BROADCAST_TYPES: BroadcastMessageType[] = ['manual', 'template', 'ia'];

export class SendBroadcastDto {
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  conversationIds!: string[];

  @IsIn(BROADCAST_TYPES)
  type!: BroadcastMessageType;

  /** Título interno del lote, solo para auditoría — nunca se envía a WhatsApp. */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  title?: string;

  @IsString()
  @IsOptional()
  text?: string;

  @IsString()
  @IsOptional()
  templateId?: string;

  @IsObject()
  @IsOptional()
  templateVariables?: Record<string, string>;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  templateAutoNameVariables?: string[];

  @IsString()
  @IsOptional()
  templateHeaderValue?: string;

  @IsObject()
  @IsOptional()
  templateButtonVariables?: Record<string, string>;
}
