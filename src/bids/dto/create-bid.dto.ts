import { IsString, IsNumber, Min, Max, IsOptional } from 'class-validator';

export class CreateBidDto {
  @IsString()
  jobId: string;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount must have at most 2 decimal places' })
  @Min(100, { message: 'amount must be at least NGN 100' })
  @Max(50000000, { message: 'amount cannot exceed NGN 50,000,000' })
  amount: number;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'tranche1Amount must have at most 2 decimal places' })
  @Min(0)
  @Max(50000000)
  tranche1Amount: number;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'tranche2Amount must have at most 2 decimal places' })
  @Min(0)
  @Max(50000000)
  tranche2Amount: number;

  @IsOptional()
  @IsString()
  coverNote?: string;
}
