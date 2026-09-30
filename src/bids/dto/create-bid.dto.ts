import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

export class CreateBidDto {
  @IsString()
  jobId: string;

  @IsNumber()
  @Min(100)
  amount: number;

  @IsNumber()
  @Min(0)
  tranche1Amount: number;

  @IsNumber()
  @Min(0)
  tranche2Amount: number;

  @IsOptional()
  @IsString()
  coverNote?: string;
}
