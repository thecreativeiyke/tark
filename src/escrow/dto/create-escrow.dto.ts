import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

export class CreateEscrowDto {
  @IsString()
  jobId: string;

  @IsOptional()
  @IsString()
  artisanId?: string;

  @IsNumber()
  @Min(0)
  tranche1Amount: number;

  @IsNumber()
  @Min(0)
  tranche2Amount: number;
}
