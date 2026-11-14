import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from './entities/user.entity';
import { RegisterDto } from '../auth/dto/register.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(registerDto: RegisterDto) {
    const normalizedEmail = registerDto.email.trim().toLowerCase();
    const existing = await this.usersRepository
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email: normalizedEmail })
      .getOne();
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const hashedPassword = await bcrypt.hash(registerDto.password, 10);
    const user = this.usersRepository.create({
      email: normalizedEmail,
      password: hashedPassword,
      fullName: registerDto.fullName,
      // Never copy a role from the request beyond the two public roles.
      role:
        registerDto.role === UserRole.ARTISAN ? UserRole.ARTISAN : UserRole.CLIENT,
    });
    return this.usersRepository.save(user);
  }

  findByEmail(email: string) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .addSelect('user.passwordResetTokenHash')
      .addSelect('user.passwordResetExpiresAt')
      .where('LOWER(user.email) = :email', { email: normalizedEmail })
      .getOne();
  }

  findOne(id: string) {
    return this.usersRepository.findOneBy({ id });
  }

  /** Find user by their stored (hashed) reset token — must select hidden fields */
  findByPasswordResetTokenHash(hash: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordResetTokenHash')
      .addSelect('user.passwordResetExpiresAt')
      .where('user.passwordResetTokenHash = :hash', { hash })
      .getOne();
  }

  async setPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.usersRepository.update(userId, {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
    });
  }

  async clearPasswordResetToken(userId: string): Promise<void> {
    await this.usersRepository.update(userId, {
      passwordResetTokenHash: null as unknown as string,
      passwordResetExpiresAt: null as unknown as Date,
    });
  }

  async updatePassword(userId: string, hashedPassword: string): Promise<void> {
    await this.usersRepository.update(userId, { password: hashedPassword });
  }

  async incrementTokenVersion(userId: string): Promise<void> {
    await this.usersRepository.increment({ id: userId }, 'tokenVersion', 1);
  }

  /**
   * Load a user with their password hash selected (needed for changePassword).
   * Returns null if not found.
   */
  findOneWithPassword(id: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.id = :id', { id })
      .getOne();
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.findOne(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    Object.assign(user, dto);
    const saved = await this.usersRepository.save(user);

    // Strip password from returned payload
    const { password: _, ...sanitized } = saved;
    return sanitized;
  }

  async findNearbyArtisans(
    lat: number,
    lng: number,
    radiusKm = 15,
    category?: string,
  ) {
    // Clamp radius between 1km and 50km to prevent full-country scraping
    const effectiveRadius = Math.min(Math.max(Number(radiusKm) || 15, 1), 50);

    const qb = this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.fullName',
        'user.role',
        'user.skills',
        'user.isCertifiedByTark',
        'user.createdAt',
      ])
      .addSelect(
        `(6371 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians(:lat)) * cos(radians(user.latitude)) *
            cos(radians(user.longitude) - radians(:lng)) +
            sin(radians(:lat)) * sin(radians(user.latitude))
          ))
        ))`,
        'distance',
      )
      .where('user.role = :role', { role: UserRole.ARTISAN })
      .andWhere('user.isCertifiedByTark = :certified', { certified: true })
      .andWhere('user.latitude IS NOT NULL')
      .andWhere('user.longitude IS NOT NULL')
      .setParameters({ lat, lng, radiusKm: effectiveRadius });

    if (category) {
      qb.andWhere(':category = ANY(user.skills)', { category });
    }

    qb.andWhere(
      `(6371 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos(radians(:lat)) * cos(radians(user.latitude)) *
          cos(radians(user.longitude) - radians(:lng)) +
          sin(radians(:lat)) * sin(radians(user.latitude))
        ))
      )) <= :radiusKm`,
    ).orderBy('distance', 'ASC');

    const rawAndEntities = await qb.getRawAndEntities();

    // Return sanitized artisan profile with coarse rounded distance
    return rawAndEntities.entities.map((user, index) => ({
      id: user.id,
      fullName: user.fullName,
      role: user.role,
      skills: user.skills,
      isCertifiedByTark: user.isCertifiedByTark,
      createdAt: user.createdAt,
      distanceKm: Math.round(Number(rawAndEntities.raw[index].distance) * 10) / 10,
    }));
  }
}
