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

  async findAll() {
    return this.jobsRepository.find({
      order: { createdAt: 'DESC' },
    });
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
