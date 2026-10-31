import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { QueryJobDto } from './dto/query-job.dto';

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
  ) {}

  async create(createJobDto: CreateJobDto, clientId: string) {
    const job = this.jobsRepository.create({
      ...createJobDto,
      clientId,
      status: JobStatus.OPEN,
    });
    return this.jobsRepository.save(job);
  }

  async findAll(query: QueryJobDto = {}) {
    const { page = 1, limit = 20, category, status, search } = query;
    const skip = (page - 1) * limit;

    const qb = this.jobsRepository
      .createQueryBuilder('job')
      .where('job.deletedAt IS NULL');

    if (category) {
      qb.andWhere('LOWER(job.category) = LOWER(:category)', { category });
    }

    if (status) {
      qb.andWhere('job.status = :status', { status });
    }

    if (search && search.trim().length > 0) {
      qb.andWhere(
        '(LOWER(job.title) LIKE LOWER(:search) OR LOWER(job.description) LIKE LOWER(:search) OR LOWER(job.location) LIKE LOWER(:search))',
        { search: `%${search.trim()}%` },
      );
    }

    qb.orderBy('job.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const job = await this.jobsRepository.findOneBy({ id });
    if (!job) {
      throw new NotFoundException(`Job with ID ${id} not found`);
    }
    return job;
  }

  async update(id: string, updateJobDto: UpdateJobDto, userId: string) {
    const job = await this.findOne(id);
    if (job.clientId !== userId) {
      throw new ForbiddenException('You can only update your own jobs');
    }
    Object.assign(job, updateJobDto);
    return this.jobsRepository.save(job);
  }

  // System-level status transition called by Escrow / Payment hooks
  async updateStatus(id: string, status: JobStatus) {
    const job = await this.findOne(id);
    job.status = status;
    return this.jobsRepository.save(job);
  }

  async remove(id: string, userId: string) {
    const job = await this.findOne(id);
    if (job.clientId !== userId) {
      throw new ForbiddenException('You can only delete your own jobs');
    }
    return this.jobsRepository.softDelete(id);
  }
}
