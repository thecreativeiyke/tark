import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { Review, ReviewStatus } from './entities/review.entity';
import { QueryArtisanReviewsDto } from './dto/query-artisan-reviews.dto';
import { Job } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';
import { decodeCursor } from '../jobs/jobs.utils';

const ARTISAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';

// Exact public review keys: anything else (adminNotes, moderatedBy, clientId, jobId, ...) fails CI.
const PUBLIC_REVIEW_KEYS = ['comment', 'createdAt', 'id', 'proofMediaUrls', 'rating'];

const makeReview = (over: Partial<Record<keyof Review, any>> = {}): any => ({
  id: R1,
  jobId: 'job-secret-1',
  clientId: 'client-secret-1',
  artisanId: ARTISAN_ID,
  rating: 5,
  comment: 'Great work',
  proofMediaUrls: ['https://cdn.example/p.jpg'],
  status: ReviewStatus.APPROVED,
  adminNotes: 'internal: client is a known complainer',
  moderatedBy: 'admin-secret-1',
  moderatedAt: new Date('2026-11-14T10:00:00Z'),
  createdAt: new Date('2026-11-14T09:00:00Z'),
  updatedAt: new Date('2026-11-14T10:00:00Z'),
  ...over,
});

const makeQb = (entities: any[] = [], raw: any[] = []) => {
  const qb: any = {};
  for (const m of ['addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawAndEntities = jest.fn().mockResolvedValue({ entities, raw });
  return qb;
};

describe('ReviewsService.getPublicArtisanReviews', () => {
  let service: ReviewsService;
  let reviewsRepo: any;

  beforeEach(async () => {
    reviewsRepo = { createQueryBuilder: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getRepositoryToken(Review), useValue: reviewsRepo },
        { provide: getRepositoryToken(Job), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
      ],
    }).compile();
    service = module.get(ReviewsService);
  });

  it('only queries APPROVED reviews for the given artisan', async () => {
    const qb = makeQb();
    reviewsRepo.createQueryBuilder.mockReturnValue(qb);
    await service.getPublicArtisanReviews(ARTISAN_ID);
    expect(qb.where).toHaveBeenCalledWith('review.artisanId = :artisanId', { artisanId: ARTISAN_ID });
    expect(qb.andWhere).toHaveBeenCalledWith('review.status = :status', { status: ReviewStatus.APPROVED });
  });

  it('returns exactly the public allowlist and strips internal fields', async () => {
    reviewsRepo.createQueryBuilder.mockReturnValue(makeQb([makeReview()], [{ cursor_ts: '2026-11-14 09:00:00' }]));
    const { data } = await service.getPublicArtisanReviews(ARTISAN_ID);

    expect(Object.keys(data[0]).sort()).toEqual(PUBLIC_REVIEW_KEYS);
    const json = JSON.stringify(data);
    for (const leaked of [
      'adminNotes', 'internal:', 'moderatedBy', 'admin-secret-1', 'moderatedAt',
      'clientId', 'client-secret-1', 'jobId', 'job-secret-1', 'status', 'updatedAt', 'artisanId',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it('paginates with limit + 1 and an opaque cursor on the last returned row', async () => {
    const qb = makeQb(
      [makeReview({ id: R1 }), makeReview({ id: R2 }), makeReview({ id: R3 })],
      [
        { cursor_ts: '2026-11-14 09:03:00.000003' },
        { cursor_ts: '2026-11-14 09:02:00.000002' },
        { cursor_ts: '2026-11-14 09:01:00.000001' },
      ],
    );
    reviewsRepo.createQueryBuilder.mockReturnValue(qb);

    const { data, meta } = await service.getPublicArtisanReviews(ARTISAN_ID, { limit: 2 });

    expect(qb.limit).toHaveBeenCalledWith(3);
    expect(data).toHaveLength(2);
    expect(meta.hasMore).toBe(true);
    expect(decodeCursor(meta.nextCursor as string)).toEqual({ ts: '2026-11-14 09:02:00.000002', id: R2 });
  });

  it('defaults to 20 per page and reports the last page', async () => {
    const qb = makeQb([makeReview()], [{ cursor_ts: '2026-11-14 09:00:00' }]);
    reviewsRepo.createQueryBuilder.mockReturnValue(qb);
    const { meta } = await service.getPublicArtisanReviews(ARTISAN_ID);
    expect(qb.limit).toHaveBeenCalledWith(21);
    expect(meta).toEqual({ limit: 20, hasMore: false, nextCursor: null });
  });

  it('rejects a malformed cursor', async () => {
    reviewsRepo.createQueryBuilder.mockReturnValue(makeQb());
    await expect(
      service.getPublicArtisanReviews(ARTISAN_ID, { cursor: 'garbage' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReviewsController GET /reviews/artisan/:artisanId', () => {
  it('validates artisanId with ParseUUIDPipe', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ReviewsController, 'getArtisanReviews');
    const idArg: any = Object.values(args).find((a: any) => a.data === 'artisanId');
    expect(idArg.pipes.some((p: any) => p instanceof ParseUUIDPipe)).toBe(true);
  });
});

describe('QueryArtisanReviewsDto', () => {
  const errorsFor = (plain: object) => validate(plainToInstance(QueryArtisanReviewsDto, plain));

  it('accepts the cap and defaults', async () => {
    expect(await errorsFor({})).toHaveLength(0);
    expect(await errorsFor({ limit: '50' })).toHaveLength(0);
  });

  it('rejects limit above the cap of 50, or below 1', async () => {
    expect((await errorsFor({ limit: '51' })).length).toBeGreaterThan(0);
    expect((await errorsFor({ limit: '0' })).length).toBeGreaterThan(0);
  });
});
