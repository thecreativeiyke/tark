import {
  IsString,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsArray,
  IsUUID,
} from 'class-validator';

export class CreateReviewDto {
  @IsUUID()
  jobId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsString()
  comment: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proofMediaUrls?: string[];
}
