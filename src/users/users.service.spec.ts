import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { User, UserRole } from './entities/user.entity';
import { toDistanceBand } from './distance-band.util';

// Exact public artisan keys: email, phone, coordinates, exact distance, etc. must never appear.
const NEARBY_KEYS = ['createdAt', 'distanceBand', 'fullName', 'id', 'isCertifiedByTark', 'role', 'skills'];

const makeUser = (id: string): any => ({
  id,
  fullName: `Artisan ${id}`,
  role: UserRole.ARTISAN,
  skills: ['plumbing'],
  isCertifiedByTark: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  // Fields that must never be projected out:
  email: `${id}@example.com`,
  phoneNumber: '+2348000000000',
  latitude: 7.3775,
  longitude: 3.947,
  walletBalance: 1234,
  verifiedCategories: ['plumbing'],
  areaCode: 'ibadan',
});

const makeQb = (entities: any[], distances: number[]) => {
  const qb: any = {};
  for (const m of ['select', 'addSelect', 'where', 'andWhere', 'setParameters', 'orderBy']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawAndEntities = jest.fn().mockResolvedValue({
    entities,
    raw: distances.map((distance) => ({ distance })),
  });
  return qb;
};

describe('toDistanceBand', () => {
  it.each([
    [0, '< 2 km'],
    [1.999, '< 2 km'],
    [2, '2–5 km'],
    [4.999, '2–5 km'],
    [5, '5–10 km'],
    [9.999, '5–10 km'],
    [10, '10+ km'],
    [50, '10+ km'],
    [NaN, '10+ km'],
    [Infinity, '10+ km'],
  ])('%p km -> %s', (km, band) => {
    expect(toDistanceBand(km as number)).toBe(band);
  });
});

describe('UsersService.findNearbyArtisans', () => {
  let service: UsersService;
  let usersRepo: any;

  beforeEach(async () => {
    usersRepo = { createQueryBuilder: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: usersRepo }],
    }).compile();
    service = module.get(UsersService);
  });

  it('returns exactly the public allowlist with a band instead of a distance', async () => {
    usersRepo.createQueryBuilder.mockReturnValue(makeQb([makeUser('a')], [1.94]));
    const res = await service.findNearbyArtisans(7.38, 3.95, 15);

    expect(Object.keys(res[0]).sort()).toEqual(NEARBY_KEYS);
    expect(res[0].distanceBand).toBe('< 2 km');
    expect(res[0]).not.toHaveProperty('distanceKm');

    const json = JSON.stringify(res);
    for (const leaked of ['example.com', '+2348', '7.3775', '3.947', '1234', '1.94', 'areaCode', 'verifiedCategories']) {
      expect(json).not.toContain(leaked);
    }
  });

  it('maps distances onto the coarse bands', async () => {
    usersRepo.createQueryBuilder.mockReturnValue(
      makeQb(
        [makeUser('a'), makeUser('b'), makeUser('c'), makeUser('d'), makeUser('e')],
        [1.94, 2.0, 4.96, 7.3, 12.2],
      ),
    );
    const res = await service.findNearbyArtisans(7.38, 3.95, 50);
    expect(res.map((r) => r.distanceBand)).toEqual(['< 2 km', '2–5 km', '2–5 km', '5–10 km', '10+ km']);
  });

  it('does not order by exact distance (SQL or JS): order is band, then id', async () => {
    // 'b' is closer than 'a' but both share a band; the closer one must NOT come first.
    const qb = makeQb([makeUser('b'), makeUser('a')], [2.0, 4.96]);
    usersRepo.createQueryBuilder.mockReturnValue(qb);
    const res = await service.findNearbyArtisans(7.38, 3.95, 15);

    expect(qb.orderBy).not.toHaveBeenCalled();
    expect(res.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('still restricts to certified artisans with coordinates', async () => {
    const qb = makeQb([], []);
    usersRepo.createQueryBuilder.mockReturnValue(qb);
    await service.findNearbyArtisans(7.38, 3.95, 15);
    expect(qb.where).toHaveBeenCalledWith('user.role = :role', { role: UserRole.ARTISAN });
    expect(qb.andWhere).toHaveBeenCalledWith('user.isCertifiedByTark = :certified', { certified: true });
  });

  describe('category filter', () => {
    it('matches admin-verified categories, never the self-editable skills array', async () => {
      const qb = makeQb([], []);
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findNearbyArtisans(7.38, 3.95, 15, 'plumbing');

      expect(qb.andWhere).toHaveBeenCalledWith(
        ':category = ANY(user.verifiedCategories)',
        { category: 'plumbing' },
      );
      const clauses = qb.andWhere.mock.calls.map((c: any[]) => String(c[0]));
      expect(clauses.some((c: string) => c.includes('user.skills'))).toBe(false);
    });

    it('normalizes the category (trim + lowercase) before matching', async () => {
      const qb = makeQb([], []);
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findNearbyArtisans(7.38, 3.95, 15, '  Plumbing ');

      expect(qb.andWhere).toHaveBeenCalledWith(
        ':category = ANY(user.verifiedCategories)',
        { category: 'plumbing' },
      );
    });

    it('adds no category clause when no category is given', async () => {
      const qb = makeQb([], []);
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findNearbyArtisans(7.38, 3.95, 15);

      const clauses = qb.andWhere.mock.calls.map((c: any[]) => String(c[0]));
      expect(clauses.some((c: string) => c.includes('verifiedCategories'))).toBe(false);
      expect(clauses.some((c: string) => c.includes('user.skills'))).toBe(false);
    });

    it('ignores a blank category instead of filtering on an empty string', async () => {
      const qb = makeQb([], []);
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findNearbyArtisans(7.38, 3.95, 15, '   ');

      const clauses = qb.andWhere.mock.calls.map((c: any[]) => String(c[0]));
      expect(clauses.some((c: string) => c.includes('verifiedCategories'))).toBe(false);
    });
  });
});
