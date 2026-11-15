import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  Min,
  IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { SUPPORTED_CURRENCIES } from '../../common/currency';

export class CreateJobDto {
  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsString()
  category: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn([...SUPPORTED_CURRENCIES], {
    message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  currency?: string;

  @IsNumber()
  @Min(0)
  budget: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tranche1Amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tranche2Amount?: number;

  @IsString()
  location: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaUrls?: string[];
}
