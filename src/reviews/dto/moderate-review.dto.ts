import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ReviewStatus } from '../entities/review.entity';

export class ModerateReviewDto {
  @IsEnum(ReviewStatus)
  status: ReviewStatus.APPROVED | ReviewStatus.REJECTED;

  @IsOptional()
  @IsString()
  adminNotes?: string;
}
