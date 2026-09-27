import { IsString, IsNumber, Min } from 'class-validator';

export class CreateEscrowDto {
  @IsString()
  jobId: string;

  @IsNumber()
  @Min(0)
  tranche1Amount: number;

  @IsNumber()
  @Min(0)
  tranche2Amount: number;
}
