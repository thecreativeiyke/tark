import { IsString, IsOptional, IsArray, IsNumber } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  // KYC
  @IsOptional()
  @IsString()
  idType?: string;

  @IsOptional()
  @IsString()
  idNumber?: string;

  // Payout Configuration
  @IsOptional()
  @IsString()
  payoutProvider?: string;

  @IsOptional()
  @IsString()
  payoutAccountIdentifier?: string;

  @IsOptional()
  @IsString()
  payoutBankOrNetwork?: string;
}
