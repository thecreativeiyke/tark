import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { RegisterDto } from '../auth/dto/register.dto';

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
      ...registerDto,
      password: hashedPassword,
    });
    return this.usersRepository.save(user);
  }

  findByEmail(email: string) {
    return this.usersRepository.findOneBy({ email });
  }

  findOne(id: string) {
    return this.usersRepository.findOneBy({ id });
  }
}
