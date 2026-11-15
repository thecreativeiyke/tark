import { Test, TestingModule } from '@nestjs/testing';
import { ParseUUIDPipe, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

const guardsOf = (method: string): any[] =>
  Reflect.getMetadata(GUARDS_METADATA, (JobsController.prototype as any)[method]) ?? [];

describe('JobsController', () => {
  let controller: JobsController;
  let service: any;

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findDiscoverable: jest.fn().mockResolvedValue('discover'),
      findMine: jest.fn().mockResolvedValue('mine'),
      getTeaser: jest.fn().mockResolvedValue('teaser'),
      findOneForCaller: jest.fn().mockResolvedValue('one'),
    };

    const allow = { canActivate: () => true };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [{ provide: JobsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard).useValue(allow)
      .overrideGuard(OptionalJwtAuthGuard).useValue(allow)
      .overrideGuard(RolesGuard).useValue(allow)
      .compile();

    controller = module.get(JobsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('route declaration order', () => {
    it("declares 'me' and 'teaser' before ':id' so they are not swallowed as ids", () => {
      const proto: any = JobsController.prototype;
      const paths = Object.getOwnPropertyNames(proto)
        .filter((n) => n !== 'constructor')
        .map((n) => Reflect.getMetadata(PATH_METADATA, proto[n]));
      expect(paths.indexOf('me')).toBeGreaterThan(-1);
      expect(paths.indexOf('teaser')).toBeGreaterThan(-1);
      expect(paths.indexOf('me')).toBeLessThan(paths.indexOf(':id'));
      expect(paths.indexOf('teaser')).toBeLessThan(paths.indexOf(':id'));
    });
  });

  describe('guards', () => {
    it('GET /jobs requires JWT and the ARTISAN role guard', () => {
      const guards = guardsOf('findAll');
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(RolesGuard);
      expect(guards).not.toContain(OptionalJwtAuthGuard);
    });

    it('GET /jobs/me requires JWT', () => {
      expect(guardsOf('findMine')).toContain(JwtAuthGuard);
    });

    it('GET /jobs/teaser is public (no guards)', () => {
      expect(guardsOf('getTeaser')).toEqual([]);
    });

    it('GET /jobs/:id uses the optional JWT guard only', () => {
      expect(guardsOf('findOne')).toEqual([OptionalJwtAuthGuard]);
    });

    it('GET /jobs/:id validates the id with ParseUUIDPipe', () => {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, JobsController, 'findOne');
      const idArg: any = Object.values(args).find((a: any) => a.data === 'id');
      expect(idArg.pipes.some((p: any) => p instanceof ParseUUIDPipe)).toBe(true);
    });
  });

  describe('GET /jobs', () => {
    it('delegates with the authenticated userId', async () => {
      await controller.findAll({ limit: 5 } as any, { user: { userId: 'u1', role: 'artisan' } } as any);
      expect(service.findDiscoverable).toHaveBeenCalledWith({ limit: 5 }, 'u1');
    });

    it('throws Unauthorized when userId is missing', () => {
      expect(() => controller.findAll({} as any, { user: {} } as any)).toThrow(UnauthorizedException);
      expect(() => controller.findAll({} as any, {} as any)).toThrow(UnauthorizedException);
      expect(service.findDiscoverable).not.toHaveBeenCalled();
    });
  });

  describe('GET /jobs/me', () => {
    it('delegates with the authenticated userId', async () => {
      await controller.findMine({ limit: 3 } as any, { user: { userId: 'u1' } } as any);
      expect(service.findMine).toHaveBeenCalledWith('u1', { limit: 3 });
    });

    it('throws Unauthorized before touching the service when userId is missing', () => {
      expect(() => controller.findMine({} as any, { user: undefined } as any)).toThrow(UnauthorizedException);
      expect(() => controller.findMine({} as any, { user: { userId: '' } } as any)).toThrow(UnauthorizedException);
      expect(service.findMine).not.toHaveBeenCalled();
    });
  });

  describe('GET /jobs/teaser', () => {
    it('delegates to the service', async () => {
      await expect(controller.getTeaser()).resolves.toBe('teaser');
    });
  });

  describe('GET /jobs/:id', () => {
    it('passes the caller (or undefined) to the service', async () => {
      await controller.findOne('id-1', { user: { userId: 'u1', role: 'artisan' } });
      expect(service.findOneForCaller).toHaveBeenCalledWith('id-1', { userId: 'u1', role: 'artisan' });
      await controller.findOne('id-2', {});
      expect(service.findOneForCaller).toHaveBeenCalledWith('id-2', undefined);
    });
  });
});
