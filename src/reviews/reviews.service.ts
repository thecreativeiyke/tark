import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Review, ReviewStatus } from './entities/review.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { ModerateReviewDto } from './dto/moderate-review.dto';
import { QueryArtisanReviewsDto } from './dto/query-artisan-reviews.dto';
import { decodeCursor, encodeCursor } from '../jobs/jobs.utils';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(Review)
    private reviewsRepository: Repository<Review>,
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // SUBMIT REVIEW: Client rates the artisan upon job completion.
  // Held in PENDING_REVIEW status until an administrator audits it.
  // ─────────────────────────────────────────────────────────────────────
  async create(createDto: CreateReviewDto, clientId: string) {
    const job = await this.jobsRepository.findOneBy({ id: createDto.jobId });
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (job.clientId !== clientId) {
      throw new ForbiddenException('Only the client who posted this job can submit a review');
    }

    if (job.status !== JobStatus.COMPLETED) {
      throw new BadRequestException('Reviews can only be submitted for COMPLETED jobs');
    }

    if (!job.artisanId) {
      throw new BadRequestException('No artisan was assigned to this job');
    }

    const existing = await this.reviewsRepository.findOneBy({ jobId: job.id });
    if (existing) {
      throw new BadRequestException('A review has already been submitted for this job');
    }

    const review = this.reviewsRepository.create({
      jobId: job.id,
      clientId,
      artisanId: job.artisanId,
      rating: createDto.rating,
      comment: createDto.comment,
      proofMediaUrls: createDto.proofMediaUrls || [],
      status: ReviewStatus.PENDING_REVIEW,
    });

    const saved = await this.reviewsRepository.save(review);

    return {
      message:
        'Thank you! Your review has been submitted to the Tark administrative moderation desk. It will be made public once approved.',
      reviewId: saved.id,
      status: saved.status,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // PUBLIC ARTISAN REVIEWS: Anyone can see verified, approved reviews.
  // Strict allowlist projection + keyset pagination (createdAt DESC, id DESC).
  // ─────────────────────────────────────────────────────────────────────
  async getPublicArtisanReviews(artisanId: string, query: QueryArtisanReviewsDto = {}) {
    const limit = query.limit ?? 20;

    const qb = this.reviewsRepository
      .createQueryBuilder('review')
      .addSelect('CAST(review.createdAt AS text)', 'cursor_ts')
      .where('review.artisanId = :artisanId', { artisanId })
      .andWhere('review.status = :status', { status: ReviewStatus.APPROVED });

    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      qb.andWhere(
        '("review"."createdAt", "review"."id") < (CAST(:curTs AS timestamp), CAST(:curId AS uuid))',
        { curTs: c.ts, curId: c.id },
      );
    }

    qb.orderBy('review.createdAt', 'DESC').addOrderBy('review.id', 'DESC').limit(limit + 1);

    const { entities, raw } = await qb.getRawAndEntities();
    const hasMore = entities.length > limit;
    const items = entities.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ ts: raw[items.length - 1].cursor_ts, id: last.id })
        : null;

    return {
      data: items.map((review) => this.toPublicReview(review)),
      meta: { limit, hasMore, nextCursor },
    };
  }

  /** Never spread the entity: adminNotes, moderatedBy, clientId, jobId etc. must not leak. */
  private toPublicReview(review: Review) {
    return {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      proofMediaUrls: review.proofMediaUrls ?? [],
      createdAt: review.createdAt,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // ADMIN: Get queue of pending reviews awaiting administrative check
  // ─────────────────────────────────────────────────────────────────────
  async getPendingReviews() {
    return this.reviewsRepository.find({
      where: { status: ReviewStatus.PENDING_REVIEW },
      order: { createdAt: 'ASC' },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // ADMIN: Moderate (Approve / Reject) with notes
  // ─────────────────────────────────────────────────────────────────────
  async moderateReview(
    reviewId: string,
    dto: ModerateReviewDto,
    adminId: string,
  ) {
    const review = await this.reviewsRepository.findOneBy({ id: reviewId });
    if (!review) {
      throw new NotFoundException('Review not found');
    }

    review.status = dto.status;
    review.adminNotes = dto.adminNotes || null;
    review.moderatedBy = adminId;
    review.moderatedAt = new Date();

    const savedReview = await this.reviewsRepository.save(review);

    // If approved, update the artisan's average rating and total count
    if (dto.status === ReviewStatus.APPROVED) {
      await this.recalculateArtisanMetrics(review.artisanId);
    }

    return {
      message: `Review #${review.id} has been ${dto.status.toLowerCase()} by admin.`,
      review: savedReview,
    };
  }

  // Recalculates cumulative average score and count on the artisan's profile
  private async recalculateArtisanMetrics(artisanId: string) {
    const result = await this.reviewsRepository
      .createQueryBuilder('review')
      .select('AVG(review.rating)', 'avgRating')
      .addSelect('COUNT(review.id)', 'totalReviews')
      .where('review.artisanId = :artisanId', { artisanId })
      .andWhere('review.status = :status', { status: ReviewStatus.APPROVED })
      .getRawOne();

    const avg = result?.avgRating ? parseFloat(Number(result.avgRating).toFixed(2)) : 0.0;
    const count = result?.totalReviews ? parseInt(result.totalReviews, 10) : 0;

    const artisan = await this.usersRepository.findOneBy({ id: artisanId });
    if (artisan) {
      artisan.averageRating = avg;
      artisan.totalReviewsCount = count;
      await this.usersRepository.save(artisan);
    }
  }
}
