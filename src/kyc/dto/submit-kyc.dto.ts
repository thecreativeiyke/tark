import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsISO8601,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { KycIdType } from '../entities/kyc-record.entity';

export class SubmitKycDto {
  @IsEnum(KycIdType, {
    message: 'idType must be one of: NIN, VOTERS_CARD, DRIVERS_LICENSE, PASSPORT',
  })
  @IsNotEmpty()
  idType: KycIdType;

  @IsString()
  @IsNotEmpty()
  @Length(4, 64, { message: 'idNumber must be between 4 and 64 characters' })
  idNumber: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 60, { message: 'documentFirstName must be between 2 and 60 characters' })
  documentFirstName: string;

  @IsString()
  @IsOptional()
  @Length(1, 60, { message: 'documentMiddleName must be between 1 and 60 characters' })
  documentMiddleName?: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 60, { message: 'documentLastName (Surname) must be between 2 and 60 characters' })
  documentLastName: string;

  @IsString()
  @MaxLength(1024)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'documentUrl must be an https URL' })
  documentUrl: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'documentSha256 must be a 64-character hex SHA-256' })
  documentSha256?: string;

  @IsString()
  @MaxLength(1024)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'selfieUrl must be an https URL' })
  selfieUrl: string;

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'selfieSha256 must be a 64-character hex SHA-256' })
  selfieSha256?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'expiresAt must be an ISO date, e.g. 2030-05-31' })
  expiresAt?: string;
}
