import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { DisputeVerdict } from '../entities/dispute.entity';

export class ResolveDisputeDto {
  @IsEnum(DisputeVerdict)
  verdict: DisputeVerdict;

  @IsOptional()
  @IsNumber()
  @Min(0)
  clientRefundAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  artisanPayoutAmount?: number;

  @IsString()
  resolutionNotes: string;
}
