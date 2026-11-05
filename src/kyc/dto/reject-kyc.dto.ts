import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RejectKycDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'Rejection reason must be at least 5 characters to give clear artisan guidance' })
  reason: string;
}
