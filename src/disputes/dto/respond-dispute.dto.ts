import { IsString, IsOptional, IsArray } from 'class-validator';

export class RespondDisputeDto {
  @IsString()
  counterStatement: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  counterEvidenceUrls?: string[];
}
