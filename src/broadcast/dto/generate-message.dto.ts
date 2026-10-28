import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class GenerateBroadcastMessageDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  instruction!: string;
}
