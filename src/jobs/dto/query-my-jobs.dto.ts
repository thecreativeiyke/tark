import { IsOptional, IsString, IsInt, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryMyJobsDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
