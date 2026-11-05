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
    const existing = await this.usersRepository.findOneBy({
      email: registerDto.email,
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const hashedPassword = await bcrypt.hash(registerDto.password, 10);
    const user = this.usersRepository.create({
      email: registerDto.email,
      password: hashedPassword,
      fullName: registerDto.fullName,
      // Never copy a role from the request beyond the two public roles.
      role:
        registerDto.role === UserRole.ARTISAN ? UserRole.ARTISAN : UserRole.CLIENT,
    });
    return this.usersRepository.save(user);
  }

  findByEmail(email: string) {
    return this.usersRepository.findOneBy({ email });
  }

  findOne(id: string) {
    return this.usersRepository.findOneBy({ id });
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
    const qb = this.usersRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.fullName',
        'user.email',
        'user.phoneNumber',
        'user.role',
        'user.isVerified',
        'user.skills',
        'user.latitude',
        'user.longitude',
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
      .andWhere('user.latitude IS NOT NULL')
      .andWhere('user.longitude IS NOT NULL')
      .setParameters({ lat, lng, radiusKm });

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

    return rawAndEntities.entities.map((user, index) => ({
      ...user,
      distanceKm: parseFloat(
        Number(rawAndEntities.raw[index].distance).toFixed(2),
      ),
    }));
  }
}
