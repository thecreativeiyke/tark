import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ConfigService } from '@nestjs/config';

/** A single pre-hashed dummy used to keep login timing constant for unknown emails. */
const DUMMY_HASH =
  '$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private notificationsService: NotificationsService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto) {
    const user = await this.usersService.create(registerDto);
    return this.buildToken(user.id, user.email, user.role, user.tokenVersion);
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByEmail(loginDto.email);

    // Constant-time: always call bcrypt.compare, even when the user does not exist.
    // This prevents timing-based email enumeration.
    const passwordMatches = await bcrypt.compare(
      loginDto.password,
      user?.password ?? DUMMY_HASH,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildToken(user.id, user.email, user.role, user.tokenVersion);
  }

  /**
   * Step 1 of password reset.
   * Always returns the same message regardless of whether the email exists.
   * Prevents email enumeration.
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const user = await this.usersService.findByEmail(normalizedEmail);

    if (user) {
      // 32-byte random token; store only its SHA-256 hash in the DB
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      await this.usersService.setPasswordResetToken(user.id, tokenHash, expiresAt);

      const appUrl =
        this.configService.get<string>('APP_URL') ?? 'https://tark.ng';
      const resetLink = `${appUrl}/reset-password?token=${rawToken}`;

      await this.notificationsService.dispatch({
        userId: user.id,
        type: NotificationType.PASSWORD_RESET,
        title: 'Password Reset Request',
        message:
          'You requested a password reset. The link expires in 30 minutes. If you did not request this, ignore this message.',
        email: {
          subject: 'Tark – Reset your password',
          html: `
            <p>Hi ${user.fullName || 'there'},</p>
            <p>Click the link below to reset your Tark password. It is valid for <strong>30 minutes</strong>.</p>
            <p><a href="${resetLink}" style="color:#4f46e5">Reset Password</a></p>
            <p>If you did not request a password reset, you can safely ignore this email.</p>
            <p>— The Tark Team</p>
          `,
        },
      });
    }

    // Always identical response — no email enumeration possible
    return {
      message:
        'If that email address is registered, a password reset link has been sent.',
    };
  }

  /**
   * Step 2 of password reset.
   * Validates token, updates password, invalidates all existing sessions.
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Invalid or expired reset token.');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await this.usersService.findByPasswordResetTokenHash(tokenHash);

    if (
      !user ||
      !user.passwordResetExpiresAt ||
      user.passwordResetExpiresAt < new Date()
    ) {
      // Same message for "not found" and "expired" — prevents oracle attacks
      throw new BadRequestException('Invalid or expired reset token.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Order matters: update password → clear token → bump tokenVersion (revokes all sessions)
    await this.usersService.updatePassword(user.id, hashedPassword);
    await this.usersService.clearPasswordResetToken(user.id);
    await this.usersService.incrementTokenVersion(user.id);

    return {
      message: 'Password reset successfully. Please log in again.',
    };
  }

  /**
   * Authenticated password change (must know current password).
   * Revokes all existing sessions on success.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.usersService.findOneWithPassword(userId);
    if (!user) {
      throw new UnauthorizedException('User not found.');
    }

    const passwordMatches = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.usersService.updatePassword(userId, hashedPassword);
    await this.usersService.incrementTokenVersion(userId);

    return {
      message: 'Password changed successfully. All other sessions have been revoked.',
    };
  }

  private buildToken(
    sub: string,
    email: string,
    role: string,
    tokenVersion: number,
  ) {
    const payload = { sub, email, role, tv: tokenVersion };
    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}
