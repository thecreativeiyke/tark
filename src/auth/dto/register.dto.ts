import { IsEmail, IsString, MinLength, IsIn, IsOptional } from 'class-validator';
import { UserRole } from '../../users/entities/user.entity';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  fullName: string;

  // Public self-registration may ONLY create client or artisan accounts.
  // Admin / super_admin accounts must never be creatable from this endpoint.
  @IsOptional()
  @IsIn([UserRole.CLIENT, UserRole.ARTISAN])
  role?: UserRole;
}
