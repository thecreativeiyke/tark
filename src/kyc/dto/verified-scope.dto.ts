import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/** Admin-controlled verified scope for an artisan (trade categories + service area). */
export class VerifiedScopeDto {
  // Category slugs or names; each must resolve to an active category.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  verifiedCategories?: string[];

  // City-level area; normalized to a slug (e.g. "Ibadan" -> "ibadan").
  @IsOptional()
  @IsString()
  @MaxLength(64)
  areaCode?: string;
}
