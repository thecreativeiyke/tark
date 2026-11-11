import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { QueryJobDto } from './dto/query-job.dto';
import { CategoriesService } from '../categories/categories.service';

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
    private categoriesService: CategoriesService,
  ) {}

  async create(createJobDto: CreateJobDto, clientId: string) {
    const category = await this.categoriesService.resolveCategory(createJobDto.category);
    if (!category) {
      throw new BadRequestException(
        `Invalid category "${createJobDto.category}". Please select a recognized artisan trade.`,
      );
    }

    const job = this.jobsRepository.create({
      ...createJobDto,
      category: category.slug, // Normalized canonical slug
      clientId,
      status: JobStatus.OPEN,
    });
    return this.jobsRepository.save(job);
  }

  async findAll(query: QueryJobDto = {}, caller?: { userId?: string; role?: string }) {
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
      data: items.map((job) => this.coarsenJob(job, caller)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Masks exact client street address, coordinates, and contact details from
   * unauthenticated callers, non-party users, and artisans before escrow is funded.
   * Full address is only revealed to:
   * 1. Job owner (client)
   * 2. Platform Admins
   * 3. Assigned artisan once escrow is funded (JobStatus.IN_PROGRESS or COMPLETED)
   */
  coarsenJob(job: Job, caller?: { userId?: string; role?: string }) {
    const isOwner = Boolean(caller?.userId && caller.userId === job.clientId);
    const isAdmin = caller?.role === 'ADMIN' || caller?.role === 'SUPER_ADMIN';
    const isAssignedAndActive = Boolean(
      caller?.userId &&
      caller.userId === job.artisanId &&
      (job.status === JobStatus.IN_PROGRESS || job.status === JobStatus.COMPLETED),
    );

    if (isOwner || isAdmin || isAssignedAndActive) {
      return job;
    }

    let coarseLocation = job.location;
    if (coarseLocation && coarseLocation.includes(',')) {
      const parts = coarseLocation.split(',').map((p) => p.trim());
      coarseLocation = parts.slice(-2).join(', ');
    }

    return {
      ...job,
      location: coarseLocation,
      latitude: null,
      longitude: null,
      isLocationCoarsened: true,
    };
  }

  async findOne(id: string) {
    const job = await this.jobsRepository.findOneBy({ id });
    if (!job) {
      throw new NotFoundException(`Job with ID ${id} not found`);
    }
    return job;
  }

  async findOneForCaller(id: string, caller?: { userId?: string; role?: string }) {
    const job = await this.findOne(id);
    return this.coarsenJob(job, caller);
  }

  async update(id: string, updateJobDto: UpdateJobDto, userId: string) {
    const job = await this.findOne(id);
    if (job.clientId !== userId) {
      throw new ForbiddenException('You can only update your own jobs');
    }
    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException(
        `Cannot modify a job once a bid has been accepted or work is underway (Current status: ${job.status})`,
      );
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
    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException(
        `Cannot delete a job with active contracts or locked Safe-Lock funds (Current status: ${job.status})`,
      );
    }
    return this.jobsRepository.softDelete(id);
  }
}
