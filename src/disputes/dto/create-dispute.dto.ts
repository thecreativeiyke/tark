import {
  IsUUID,
  IsEnum,
  IsString,
  IsOptional,
  IsArray,
} from 'class-validator';
import { DisputeCategory } from '../entities/dispute.entity';

export class CreateDisputeDto {
  @IsUUID()
  escrowId: string;

  @IsEnum(DisputeCategory)
  category: DisputeCategory;

  @IsString()
  claimStatement: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidenceUrls?: string[];
}
