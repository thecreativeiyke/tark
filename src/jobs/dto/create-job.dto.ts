import {
  IsString,
  IsNumber,
  IsOptional,
  IsArray,
  Min,
} from 'class-validator';

export class CreateJobDto {
  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsString()
  category: string;

  @IsNumber()
  @Min(0)
  budget: number;

  @IsString()
  location: string;

  @IsString()
  clientId: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaUrls?: string[];
}
