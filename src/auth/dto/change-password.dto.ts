import { IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  currentPassword: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  newPassword: string;
}
