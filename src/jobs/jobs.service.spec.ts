import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { Job, JobStatus } from './entities/job.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { CategoriesService } from '../categories/categories.service';
import { decodeCursor } from './jobs.utils';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID_2 = '22222222-2222-4222-8222-222222222222';
const JOB_ID_3 = '33333333-3333-4333-8333-333333333333';

// ── Exact allowed keys per projection: any new/leaked field fails these tests. ──
const DISCOVERY_KEYS = [
  'areaCode', 'budget', 'category', 'createdAt', 'currency', 'description',
  'id', 'location', 'status', 'title',
];
const PARTY_KEYS = [
  'areaCode', 'artisanId', 'budget', 'category', 'clientId', 'createdAt', 'currency',
  'description', 'id', 'latitude', 'location', 'longitude', 'mediaUrls', 'myRole',
  'status', 'title', 'tranche1Amount', 'tranche2Amount', 'updatedAt',
];
const PUBLIC_KEYS = [
  'areaCode', 'budgetTier', 'category', 'createdAt', 'description', 'id',
  'location', 'status', 'title',
];
const PUBLIC_KEYS_VERIFIED_ARTISAN = [...PUBLIC_KEYS, 'budget', 'currency'];
const TEASER_KEYS = ['area', 'budgetTier', 'category', 'createdAt', 'title'];

const makeJob = (over: Partial<Record<keyof Job, any>> = {}): any => ({
  id: JOB_ID,
  title: 'Fix a leaking pipe under the kitchen sink at my house',
  description: 'x'.repeat(500),
  category: 'plumbing',
  currency: 'NGN',
  budget: 120000,
  tranche1Amount: 60000,
  tranche2Amount: 60000,
  location: '12 Allen Avenue, Bodija, Ibadan',
  areaCode: 'ibadan',
  latitude: 7.4,
  longitude: 3.9,
  status: JobStatus.OPEN,
  clientId: 'client-1',
  artisanId: null,
  mediaUrls: ['https://cdn.example/a.jpg'],
  createdAt: new Date('2026-11-15T10:00:00Z'),
  updatedAt: new Date('2026-11-15T11:00:00Z'),
  deletedAt: null,
  ...over,
});

const makeQb = (entities: any[] = [], raw: any[] = []) => {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawAndEntities = jest.fn().mockResolvedValue({ entities, raw });
  qb.getMany = jest.fn().mockResolvedValue(entities);
  return qb;
};

const sorted = (o: object) => Object.keys(o).sort();

describe('JobsService', () => {
  let service: JobsService;
  let jobsRepo: any;
  let usersRepo: any;
  let categoriesService: any;

  const verifiedArtisan = {
    id: 'artisan-1',
    role: UserRole.ARTISAN,
    isCertifiedByTark: true,
    verifiedCategories: ['plumbing', 'electrical'],
    areaCode: 'ibadan',
  };

  beforeEach(async () => {
    jobsRepo = {
      createQueryBuilder: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve(x)),
    };
    usersRepo = { findOne: jest.fn() };
    categoriesService = { resolveCategory: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: getRepositoryToken(Job), useValue: jobsRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: CategoriesService, useValue: categoriesService },
      ],
    }).compile();

    service = module.get(JobsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('derives areaCode from location and canonicalizes the category', async () => {
      categoriesService.resolveCategory.mockResolvedValue({ slug: 'plumbing' });
      await service.create(
        { title: 't', description: 'd', category: 'Plumbing', budget: 1, location: '1 A St, Bodija, Ibadan' } as any,
        'client-1',
      );
      expect(jobsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'plumbing',
          areaCode: 'ibadan',
          clientId: 'client-1',
          status: JobStatus.OPEN,
        }),
      );
    });

    it('rejects an unknown category', async () => {
      categoriesService.resolveCategory.mockResolvedValue(null);
      await expect(service.create({ category: 'nope' } as any, 'c')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findDiscoverable (GET /jobs)', () => {
    it('rejects a non-artisan', async () => {
      usersRepo.findOne.mockResolvedValue({ ...verifiedArtisan, role: UserRole.CLIENT });
      await expect(service.findDiscoverable({}, 'u')).rejects.toBeInstanceOf(ForbiddenException);
      expect(jobsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rejects an artisan who is not KYC-certified', async () => {
      usersRepo.findOne.mockResolvedValue({ ...verifiedArtisan, isCertifiedByTark: false });
      await expect(service.findDiscoverable({}, 'u')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an unknown user', async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.findDiscoverable({}, 'u')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns an empty page without querying jobs when the artisan has no verified scope', async () => {
      usersRepo.findOne.mockResolvedValue({ ...verifiedArtisan, verifiedCategories: [] });
      const res = await service.findDiscoverable({ limit: 5 }, 'u');
      expect(res).toEqual({ data: [], meta: { limit: 5, hasMore: false, nextCursor: null } });
      expect(jobsRepo.createQueryBuilder).not.toHaveBeenCalled();

      usersRepo.findOne.mockResolvedValue({ ...verifiedArtisan, areaCode: null });
      expect((await service.findDiscoverable({}, 'u')).data).toEqual([]);
      expect(jobsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('cannot widen scope: a category outside the verified set returns nothing', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      const res = await service.findDiscoverable({ category: 'tailoring' }, 'u');
      expect(res.data).toEqual([]);
      expect(jobsRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('forces status OPEN and scopes to verified categories + area; user status is ignored', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      const qb = makeQb();
      jobsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findDiscoverable({ status: 'COMPLETED' } as any, 'u');

      expect(qb.andWhere).toHaveBeenCalledWith('job.status = :status', { status: JobStatus.OPEN });
      expect(qb.andWhere).toHaveBeenCalledWith('job.category IN (:...categories)', {
        categories: ['plumbing', 'electrical'],
      });
      expect(qb.andWhere).toHaveBeenCalledWith('job.areaCode = :areaCode', { areaCode: 'ibadan' });
      expect(JSON.stringify(qb.andWhere.mock.calls)).not.toContain('COMPLETED');
    });

    it('narrows to a single in-scope category', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      const qb = makeQb();
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findDiscoverable({ category: ' Electrical ' }, 'u');
      expect(qb.andWhere).toHaveBeenCalledWith('job.category IN (:...categories)', {
        categories: ['electrical'],
      });
    });

    it('searches title only and escapes LIKE wildcards', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      const qb = makeQb();
      jobsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findDiscoverable({ search: '50%_off\\' }, 'u');

      const call = qb.andWhere.mock.calls.find(([sql]: any[]) => String(sql).includes('LIKE'));
      expect(call[0]).toContain('job.title');
      expect(call[0]).not.toContain('description');
      expect(call[0]).not.toContain('location');
      expect(call[0]).toContain('ESCAPE');
      expect(call[1].search).toBe('%50\\%\\_off\\\\%');
    });

    it('returns exactly the discovery allowlist and truncates description', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      const qb = makeQb([makeJob()], [{ cursor_ts: '2026-11-15 10:00:00.123456' }]);
      jobsRepo.createQueryBuilder.mockReturnValue(qb);

      const { data } = await service.findDiscoverable({}, 'u');

      expect(sorted(data[0])).toEqual(DISCOVERY_KEYS);
      expect(data[0].description.length).toBeLessThanOrEqual(201);
      expect(data[0].budget).toBe(120000);
      expect(data[0].location).toBe('Bodija, Ibadan');
      const json = JSON.stringify(data);
      for (const leaked of ['client-1', 'tranche', 'mediaUrls', 'latitude', 'longitude', 'deletedAt', 'updatedAt', '12 Allen']) {
        expect(json).not.toContain(leaked);
      }
    });

    it('uses limit + 1 for hasMore and emits an opaque cursor for the last returned row', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      const entities = [makeJob({ id: JOB_ID }), makeJob({ id: JOB_ID_2 }), makeJob({ id: JOB_ID_3 })];
      const raw = [
        { cursor_ts: '2026-11-15 10:03:00.000003' },
        { cursor_ts: '2026-11-15 10:02:00.000002' },
        { cursor_ts: '2026-11-15 10:01:00.000001' },
      ];
      const qb = makeQb(entities, raw);
      jobsRepo.createQueryBuilder.mockReturnValue(qb);

      const { data, meta } = await service.findDiscoverable({ limit: 2 }, 'u');

      expect(qb.limit).toHaveBeenCalledWith(3);
      expect(data).toHaveLength(2);
      expect(meta.hasMore).toBe(true);
      expect(decodeCursor(meta.nextCursor as string)).toEqual({ ts: raw[1].cursor_ts, id: JOB_ID_2 });
    });

    it('hasMore is false and nextCursor null on the last page', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      jobsRepo.createQueryBuilder.mockReturnValue(makeQb([makeJob()], [{ cursor_ts: '2026-11-15 10:00:00' }]));
      const { meta } = await service.findDiscoverable({ limit: 2 }, 'u');
      expect(meta).toEqual({ limit: 2, hasMore: false, nextCursor: null });
    });

    it('rejects a malformed cursor', async () => {
      usersRepo.findOne.mockResolvedValue(verifiedArtisan);
      jobsRepo.createQueryBuilder.mockReturnValue(makeQb());
      await expect(service.findDiscoverable({ cursor: 'garbage' }, 'u')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findMine (GET /jobs/me)', () => {
    it('scopes strictly to client OR artisan = caller', async () => {
      const qb = makeQb();
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findMine('user-9', {});
      expect(qb.andWhere).toHaveBeenCalledWith('(job.clientId = :userId OR job.artisanId = :userId)', {
        userId: 'user-9',
      });
    });

    it('projects the party view with an exact key allowlist', async () => {
      const qb = makeQb([makeJob()], [{ cursor_ts: '2026-11-15 10:00:00' }]);
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      const { data } = await service.findMine('client-1', {});
      expect(sorted(data[0])).toEqual(PARTY_KEYS);
      expect(data[0].myRole).toBe('CLIENT');
      expect(data[0].location).toBe('12 Allen Avenue, Bodija, Ibadan');
    });

    it('hides exact address and coordinates from the artisan until escrow is funded', async () => {
      const open = makeJob({ artisanId: 'artisan-1', status: JobStatus.OPEN });
      jobsRepo.createQueryBuilder.mockReturnValue(makeQb([open], [{ cursor_ts: '2026-11-15 10:00:00' }]));
      const [view] = (await service.findMine('artisan-1', {})).data;
      expect(view.myRole).toBe('ARTISAN');
      expect(view.location).toBe('Bodija, Ibadan');
      expect(view.latitude).toBeNull();
      expect(view.longitude).toBeNull();

      const active = makeJob({ artisanId: 'artisan-1', status: JobStatus.IN_PROGRESS });
      jobsRepo.createQueryBuilder.mockReturnValue(makeQb([active], [{ cursor_ts: '2026-11-15 10:00:00' }]));
      const [funded] = (await service.findMine('artisan-1', {})).data;
      expect(funded.location).toBe('12 Allen Avenue, Bodija, Ibadan');
      expect(funded.latitude).toBe(7.4);
    });

    it('paginates with limit + 1', async () => {
      const qb = makeQb([makeJob({ id: JOB_ID }), makeJob({ id: JOB_ID_2 })], [
        { cursor_ts: '2026-11-15 10:02:00' },
        { cursor_ts: '2026-11-15 10:01:00' },
      ]);
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      const { data, meta } = await service.findMine('client-1', { limit: 1 });
      expect(qb.limit).toHaveBeenCalledWith(2);
      expect(data).toHaveLength(1);
      expect(meta.hasMore).toBe(true);
    });
  });

  describe('getTeaser (GET /jobs/teaser)', () => {
    it('selects only teaser columns, OPEN only, max 10', async () => {
      const qb = makeQb([]);
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.getTeaser();
      expect(qb.select).toHaveBeenCalledWith([
        'job.id', 'job.title', 'job.category', 'job.areaCode', 'job.budget', 'job.createdAt',
      ]);
      expect(qb.andWhere).toHaveBeenCalledWith('job.status = :status', { status: JobStatus.OPEN });
      expect(qb.limit).toHaveBeenCalledWith(10);
    });

    it('returns exactly the teaser allowlist (no ids, amounts, currency or people)', async () => {
      jobsRepo.createQueryBuilder.mockReturnValue(makeQb([makeJob()]));
      const res = await service.getTeaser();
      expect(sorted(res[0])).toEqual(TEASER_KEYS);
      expect(res[0].title.length).toBeLessThanOrEqual(41);
      expect(res[0].budgetTier).toBe('STANDARD');
      const json = JSON.stringify(res);
      for (const leaked of [JOB_ID, 'client-1', '120000', 'NGN', '7.4']) {
        expect(json).not.toContain(leaked);
      }
    });

    it('maps budgets to tiers, with CUSTOM_QUOTE for 0/null', async () => {
      jobsRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          makeJob({ budget: 10000 }),
          makeJob({ budget: 49999 }),
          makeJob({ budget: 50000 }),
          makeJob({ budget: 499999 }),
          makeJob({ budget: 500000 }),
          makeJob({ budget: 0 }),
          makeJob({ budget: null }),
        ]),
      );
      const tiers = (await service.getTeaser()).map((j) => j.budgetTier);
      expect(tiers).toEqual(['MICRO', 'MICRO', 'STANDARD', 'STANDARD', 'MAJOR', 'CUSTOM_QUOTE', 'CUSTOM_QUOTE']);
    });
  });

  describe('findOneForCaller (GET /jobs/:id)', () => {
    it('404s when the job does not exist', async () => {
      jobsRepo.findOneBy.mockResolvedValue(null);
      await expect(service.findOneForCaller(JOB_ID, undefined)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([JobStatus.IN_PROGRESS, JobStatus.COMPLETED, JobStatus.DISPUTED, JobStatus.CANCELLED])(
      '404s anonymous and non-party callers for a %s job (indistinguishable from missing)',
      async (status) => {
        jobsRepo.findOneBy.mockResolvedValue(makeJob({ status, artisanId: 'artisan-1' }));
        await expect(service.findOneForCaller(JOB_ID, undefined)).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.findOneForCaller(JOB_ID, { userId: 'stranger', role: UserRole.ADMIN }),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('gives anonymous callers the public allowlist on an OPEN job (tier only, no budget)', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob());
      const view: any = await service.findOneForCaller(JOB_ID, undefined);
      expect(sorted(view)).toEqual(PUBLIC_KEYS);
      expect(view.budgetTier).toBe('STANDARD');
      expect(view.location).toBe('Bodija, Ibadan');
      const json = JSON.stringify(view);
      for (const leaked of ['client-1', 'tranche', 'mediaUrls', 'latitude', 'longitude', '12 Allen']) {
        expect(json).not.toContain(leaked);
      }
      expect(usersRepo.findOne).not.toHaveBeenCalled();
    });

    it('shows the exact budget only to a DB-verified artisan', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob());
      usersRepo.findOne.mockResolvedValue({ id: 'artisan-1', role: UserRole.ARTISAN, isCertifiedByTark: true });
      const view: any = await service.findOneForCaller(JOB_ID, { userId: 'artisan-1', role: UserRole.ARTISAN });
      expect(sorted(view)).toEqual([...PUBLIC_KEYS_VERIFIED_ARTISAN].sort());
      expect(view.budget).toBe(120000);
      expect(sorted(view)).not.toContain('tranche1Amount');
    });

    it('does not trust a token role claim: uncertified artisan gets no budget', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob());
      usersRepo.findOne.mockResolvedValue({ id: 'artisan-1', role: UserRole.ARTISAN, isCertifiedByTark: false });
      const view: any = await service.findOneForCaller(JOB_ID, { userId: 'artisan-1', role: UserRole.ARTISAN });
      expect(sorted(view)).toEqual(PUBLIC_KEYS);
    });

    it('clients and other non-artisans never get the exact budget as non-parties', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob());
      const view: any = await service.findOneForCaller(JOB_ID, { userId: 'other-client', role: UserRole.CLIENT });
      expect(sorted(view)).toEqual(PUBLIC_KEYS);
      expect(usersRepo.findOne).not.toHaveBeenCalled();
    });

    it('gives the client the full party view, even when the job is not OPEN', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob({ status: JobStatus.COMPLETED, artisanId: 'artisan-1' }));
      const view: any = await service.findOneForCaller(JOB_ID, { userId: 'client-1', role: UserRole.CLIENT });
      expect(sorted(view)).toEqual(PARTY_KEYS);
      expect(view.myRole).toBe('CLIENT');
    });

    it('gives the assigned artisan the party view with exact location only once funded', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob({ status: JobStatus.IN_PROGRESS, artisanId: 'artisan-1' }));
      const funded: any = await service.findOneForCaller(JOB_ID, { userId: 'artisan-1', role: UserRole.ARTISAN });
      expect(sorted(funded)).toEqual(PARTY_KEYS);
      expect(funded.location).toBe('12 Allen Avenue, Bodija, Ibadan');

      jobsRepo.findOneBy.mockResolvedValue(makeJob({ status: JobStatus.DISPUTED, artisanId: 'artisan-1' }));
      const disputed: any = await service.findOneForCaller(JOB_ID, { userId: 'artisan-1', role: UserRole.ARTISAN });
      expect(disputed.location).toBe('Bodija, Ibadan');
      expect(disputed.latitude).toBeNull();
    });
  });

  describe('update', () => {
    it('re-derives areaCode when location changes', async () => {
      jobsRepo.findOneBy.mockResolvedValue(makeJob());
      const saved: any = await service.update(JOB_ID, { location: '5 B Rd, Mokola, Lagos' } as any, 'client-1');
      expect(saved.areaCode).toBe('lagos');
    });
  });
});
