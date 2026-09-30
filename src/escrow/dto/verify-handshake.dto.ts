import { IsString, Length, Matches } from 'class-validator';

export class VerifyHandshakeDto {
  @IsString()
  @Length(6, 6, { message: 'Handshake PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Handshake PIN must contain only digits' })
  pin: string;
}
