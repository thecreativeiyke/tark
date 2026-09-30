import { IsArray, IsOptional, IsString } from 'class-validator';

export class InitiateHandshakeDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proofOfWorkUrls?: string[];
}
