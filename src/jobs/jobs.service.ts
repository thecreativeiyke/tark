import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Job, JobStatus } from './entities/job.entity';
import { CreateJobDto } from './dto/create-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { QueryJobDto } from './dto/query-job.dto';
import { QueryMyJobsDto } from './dto/query-my-jobs.dto';
import { CategoriesService } from '../categories/categories.service';
import { User, UserRole } from '../users/entities/user.entity';
import {
  coarseLocation,
  decodeCursor,
  deriveAreaCodeFromLocation,
  encodeCursor,
  escapeLike,
  toBudgetTier,
  truncate,
} from './jobs.utils';

const DISCOVERY_DESCRIPTION_MAX = 200;
const TEASER_TITLE_MAX = 40;
const TEASER_LIMIT = 10;

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
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
      areaCode: deriveAreaCodeFromLocation(createJobDto.location),
      clientId,
      status: JobStatus.OPEN,
    });
    return this.jobsRepository.save(job);
  }

  // ───────────────────────── Keyset pagination ─────────────────────────

  /**
   * Orders by (createdAt DESC, id DESC) and fetches limit + 1 rows to compute hasMore
   * without COUNT(*). The cursor carries createdAt as Postgres text to keep microseconds.
   */
  private async runKeyset(qb: SelectQueryBuilder<Job>, limit: number, cursor?: string) {
    qb.addSelect('CAST(job.createdAt AS text)', 'cursor_ts');

    if (cursor) {
      const c = decodeCursor(cursor);
      qb.andWhere(
        '("job"."createdAt", "job"."id") < (CAST(:curTs AS timestamp), CAST(:curId AS uuid))',
        { curTs: c.ts, curId: c.id },
      );
    }

    qb.orderBy('job.createdAt', 'DESC').addOrderBy('job.id', 'DESC').limit(limit + 1);

    const { entities, raw } = await qb.getRawAndEntities();
    const hasMore = entities.length > limit;
    const items = entities.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ ts: raw[items.length - 1].cursor_ts, id: last.id })
        : null;

    return { items, meta: { limit, hasMore, nextCursor } };
  }

  // ───────────────────────── GET /jobs/me ─────────────────────────

  async findMine(userId: string, query: QueryMyJobsDto = {}) {
    const limit = query.limit ?? 20;

    const qb = this.jobsRepository
      .createQueryBuilder('job')
      .where('job.deletedAt IS NULL')
      .andWhere('(job.clientId = :userId OR job.artisanId = :userId)', { userId });

    const { items, meta } = await this.runKeyset(qb, limit, query.cursor);
    return { data: items.map((job) => this.toPartyView(job, userId)), meta };
  }

  // ───────────────────────── GET /jobs (artisan discovery) ─────────────────────────

  async findDiscoverable(query: QueryJobDto = {}, userId: string) {
    const artisan = await this.usersRepository.findOne({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        isCertifiedByTark: true,
        verifiedCategories: true,
        areaCode: true,
      },
    });
    if (!artisan || artisan.role !== UserRole.ARTISAN || !artisan.isCertifiedByTark) {
      throw new ForbiddenException('Only verified artisans can browse open jobs.');
    }

    const limit = query.limit ?? 20;
    const empty = { data: [], meta: { limit, hasMore: false, nextCursor: null } };

    let categories = artisan.verifiedCategories ?? [];
    if (!categories.length || !artisan.areaCode) return empty;

    if (query.category) {
      const wanted = query.category.trim().toLowerCase();
      if (!categories.includes(wanted)) return empty;
      categories = [wanted];
    }

    const qb = this.jobsRepository
      .createQueryBuilder('job')
      .where('job.deletedAt IS NULL')
      .andWhere('job.status = :status', { status: JobStatus.OPEN })
      .andWhere('job.category IN (:...categories)', { categories })
      .andWhere('job.areaCode = :areaCode', { areaCode: artisan.areaCode });

    // Title only: the description and private address are never searchable.
    const search = query.search?.trim();
    if (search) {
      qb.andWhere(`LOWER(job.title) LIKE LOWER(:search) ESCAPE '\\'`, {
        search: `%${escapeLike(search)}%`,
      });
    }

    const { items, meta } = await this.runKeyset(qb, limit, query.cursor);
    return { data: items.map((job) => this.toDiscoveryView(job)), meta };
  }

  // ───────────────────────── GET /jobs/teaser (public) ─────────────────────────

  async getTeaser() {
    const jobs = await this.jobsRepository
      .createQueryBuilder('job')
      .select([
        'job.id', // required for entity hydration; never emitted
        'job.title',
        'job.category',
        'job.areaCode',
        'job.budget',
        'job.createdAt',
      ])
      .where('job.deletedAt IS NULL')
      .andWhere('job.status = :status', { status: JobStatus.OPEN })
      .orderBy('job.createdAt', 'DESC')
      .limit(TEASER_LIMIT)
      .getMany();

    return jobs.map((job) => ({
      area: job.areaCode ?? null,
      title: truncate(job.title, TEASER_TITLE_MAX),
      category: job.category,
      createdAt: job.createdAt,
      budgetTier: toBudgetTier(job.budget),
    }));
  }

  // ───────────────────────── Projections (strict allowlists) ─────────────────────────

  private toDiscoveryView(job: Job) {
    return {
      id: job.id,
      title: job.title,
      description: truncate(job.description, DISCOVERY_DESCRIPTION_MAX),
      category: job.category,
      areaCode: job.areaCode,
      location: coarseLocation(job.location),
      currency: job.currency,
      budget: job.budget,
      status: job.status,
      createdAt: job.createdAt,
    };
  }

  /** Full view for the job's own client / assigned artisan. Exact address only when allowed. */
  private toPartyView(job: Job, userId: string) {
    const isClient = job.clientId === userId;
    const exactLocation =
      isClient ||
      (job.artisanId === userId &&
        (job.status === JobStatus.IN_PROGRESS || job.status === JobStatus.COMPLETED));

    return {
      id: job.id,
      myRole: isClient ? 'CLIENT' : 'ARTISAN',
      title: job.title,
      description: job.description,
      category: job.category,
      areaCode: job.areaCode,
      currency: job.currency,
      budget: job.budget,
      tranche1Amount: job.tranche1Amount,
      tranche2Amount: job.tranche2Amount,
      status: job.status,
      clientId: job.clientId,
      artisanId: job.artisanId,
      location: exactLocation ? job.location : coarseLocation(job.location),
      latitude: exactLocation ? job.latitude : null,
      longitude: exactLocation ? job.longitude : null,
      mediaUrls: job.mediaUrls ?? [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  /** What a non-party sees on an OPEN job. Exact budget only for KYC-verified artisans. */
  private toPublicView(job: Job, showExactBudget: boolean) {
    return {
      id: job.id,
      title: job.title,
      description: job.description,
      category: job.category,
      areaCode: job.areaCode,
      location: coarseLocation(job.location),
      status: job.status,
      budgetTier: toBudgetTier(job.budget),
      ...(showExactBudget ? { budget: job.budget, currency: job.currency } : {}),
      createdAt: job.createdAt,
    };
  }

  private async isVerifiedArtisan(caller?: { userId?: string; role?: string }) {
    if (!caller?.userId || caller.role !== UserRole.ARTISAN) return false;
    // Re-check against the DB: never trust a role/certification claim from the token alone.
    const user = await this.usersRepository.findOne({
      where: { id: caller.userId },
      select: { id: true, role: true, isCertifiedByTark: true },
    });
    return Boolean(user && user.role === UserRole.ARTISAN && user.isCertifiedByTark);
  }

  async findOne(id: string) {
    const job = await this.jobsRepository.findOneBy({ id });
    if (!job) {
      throw new NotFoundException(`Job with ID ${id} not found`);
    }
    return job;
  }

  async findOneForCaller(id: string, caller?: { userId?: string; role?: string }) {
    const job = await this.jobsRepository.findOneBy({ id });
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const userId = caller?.userId;
    if (userId && (job.clientId === userId || job.artisanId === userId)) {
      return this.toPartyView(job, userId);
    }

    // Non-parties cannot tell a non-open job from a missing one.
    if (job.status !== JobStatus.OPEN) {
      throw new NotFoundException('Job not found');
    }

    return this.toPublicView(job, await this.isVerifiedArtisan(caller));
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
    if (updateJobDto.location !== undefined) {
      job.areaCode = deriveAreaCodeFromLocation(job.location);
    }
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
