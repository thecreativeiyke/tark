import { toMinorUnits, isTranche1Compliant, tranche1PolicyMessage } from '../escrow/escrow-policy';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Bid, BidStatus } from './entities/bid.entity';
import { CreateBidDto } from './dto/create-bid.dto';
import { JobsService } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/entities/job.entity';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';

@Injectable()
export class BidsService {
  constructor(
    @InjectRepository(Bid)
    private bidsRepository: Repository<Bid>,
    @InjectDataSource()
    private dataSource: DataSource,
    private jobsService: JobsService,
    private escrowService: EscrowService,
    private notificationsService: NotificationsService,
  ) {}

  async create(dto: CreateBidDto, artisanId: string, role: string) {
    if (role !== 'artisan') {
      throw new ForbiddenException('Only registered artisans can place bids');
    }

    // Observation-mode gate: only Tark Certified artisans can place bids.
    // Set KYC_REQUIRED_TO_BID=false in .env to disable it (e.g. for a pilot or while KYC is unfinished).
    // Default (unset) keeps the gate ON.
    if (process.env.KYC_REQUIRED_TO_BID !== 'false') {
      const artisanUser = await this.dataSource
        .getRepository(User)
        .findOne({ where: { id: artisanId } });
      if (!artisanUser || !artisanUser.isCertifiedByTark) {
        throw new ForbiddenException(
          'Tark Certification Required: You are currently in observation mode. You must complete your KYC verification at /kyc/submit to unlock bidding.',
        );
      }
    }

    const job = await this.jobsService.findOne(dto.jobId);

    // An artisan cannot bid on their own posted job
    if (job.clientId === artisanId) {
      throw new ForbiddenException('You cannot bid on your own job posting');
    }

    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException('Cannot bid on a job that is not OPEN');
    }

    // Exact minor kobo arithmetic (integer precision, zero floating-point slop)
    const totalKobo = toMinorUnits(dto.amount);
    const t1Kobo = toMinorUnits(dto.tranche1Amount);
    const t2Kobo = toMinorUnits(dto.tranche2Amount);

    if (t1Kobo + t2Kobo !== totalKobo) {
      throw new BadRequestException('Tranche 1 + Tranche 2 must sum exactly to the total bid amount');
    }

    if (!isTranche1Compliant(t1Kobo, totalKobo)) {
      throw new BadRequestException(tranche1PolicyMessage());
    }

    // One pending bid per artisan per job
    const existing = await this.bidsRepository.findOneBy({
      jobId: dto.jobId,
      artisanId,
      status: BidStatus.PENDING,
    });
    if (existing) {
      throw new BadRequestException(
        'You already have a pending bid on this job. Withdraw it first if you want to rebid.',
      );
    }

    const bid = this.bidsRepository.create({
      ...dto,
      artisanId,
      status: BidStatus.PENDING,
    });
    const savedBid = await this.bidsRepository.save(bid);

    // Multi-Channel Dispatch to Client (async, non-blocking)
    this.dataSource
      .getRepository(User)
      .findOne({ where: { id: artisanId } })
      .then((artisan) => {
        return this.notificationsService.notifyBidReceived({
          clientId: job.clientId,
          clientName: 'Tark Client',
          artisanName: artisan?.fullName || 'Artisan',
          jobTitle: job.title,
          bidAmount: Number(dto.amount),
          jobId: job.id,
        });
      })
      .catch((err) => console.error('Failed to dispatch bid notification:', err));

    return savedBid;
  }

  async findByJob(jobId: string) {
    return this.bidsRepository.find({
      where: { jobId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Scoped bid access:
   * - Job owner (client) and Platform Admins can see all bids on the job.
   * - Artisans can only see their own bid on the job.
   */
  async findByJobForUser(jobId: string, userId: string, role: string) {
    const job = await this.jobsService.findOne(jobId);
    if (!job) {
      throw new NotFoundException(`Job #${jobId} not found`);
    }

    if (role === 'ADMIN' || role === 'SUPER_ADMIN' || job.clientId === userId) {
      return this.bidsRepository.find({
        where: { jobId },
        order: { createdAt: 'DESC' },
      });
    }

    return this.bidsRepository.find({
      where: { jobId, artisanId: userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Bid> {
    const bid = await this.bidsRepository.findOneBy({ id });
    if (!bid) {
      throw new NotFoundException(`Bid #${id} not found`);
    }
    return bid;
  }

  async findOneForUser(id: string, userId: string, role: string): Promise<Bid> {
    const bid = await this.findOne(id);
    const job = await this.jobsService.findOne(bid.jobId);

    if (
      role === 'ADMIN' ||
      role === 'SUPER_ADMIN' ||
      bid.artisanId === userId ||
      job?.clientId === userId
    ) {
      return bid;
    }

    throw new ForbiddenException('You do not have permission to view this bid');
  }

  // ─────────────────────────────────────────────────────────────────────
  // ACCEPT BID — runs inside a transaction so all-or-nothing:
  // mark accepted, reject others, update job, create escrow.
  // If any step fails the entire thing rolls back cleanly.
  // ─────────────────────────────────────────────────────────────────────
  async acceptBid(bidId: string, clientId: string) {
    const bid = await this.findOne(bidId);

    if (bid.status !== BidStatus.PENDING) {
      throw new BadRequestException(`Cannot accept a bid with status: ${bid.status}`);
    }

    const acceptTotalKobo = toMinorUnits(bid.amount);
    const acceptT1Kobo = toMinorUnits(bid.tranche1Amount);
    const acceptT2Kobo = toMinorUnits(bid.tranche2Amount);
    if (acceptT1Kobo + acceptT2Kobo !== acceptTotalKobo || !isTranche1Compliant(acceptT1Kobo, acceptTotalKobo)) {
      throw new BadRequestException(
        `This bid cannot be accepted because its tranche split violates the Safe-Lock policy. ${tranche1PolicyMessage()}`,
      );
    }

    const job = await this.jobsService.findOne(bid.jobId);

    if (job.clientId !== clientId) {
      throw new ForbiddenException('Only the job owner can accept bids');
    }

    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException('This job is no longer open for bid acceptance');
    }

    // Run all writes atomically
    return this.dataSource.transaction(async (manager) => {
      // 1. Accept this bid
      bid.status = BidStatus.ACCEPTED;
      await manager.save(Bid, bid);

      // 2. Reject every other pending bid for this job
      await manager
        .createQueryBuilder()
        .update(Bid)
        .set({ status: BidStatus.REJECTED })
        .where('jobId = :jobId AND id != :bidId AND status = :status', {
          jobId: job.id,
          bidId: bid.id,
          status: BidStatus.PENDING,
        })
        .execute();

      // 3. Bind artisan and finalized amounts to the job
      job.artisanId = bid.artisanId;
      job.budget = bid.amount;
      job.tranche1Amount = bid.tranche1Amount;
      job.tranche2Amount = bid.tranche2Amount;
      await manager.save(job);

      // 4. Create the escrow — passing transaction manager to guarantee atomic visibility
      const escrow = await this.escrowService.create(
        {
          jobId: job.id,
          artisanId: bid.artisanId,
          tranche1Amount: Number(bid.tranche1Amount),
          tranche2Amount: Number(bid.tranche2Amount),
        },
        clientId,
        manager,
      );

      return {
        message: 'Bid accepted. Escrow created and ready for funding.',
        bid,
        escrow,
      };
    });
  }

  async withdraw(bidId: string, artisanId: string) {
    const bid = await this.findOne(bidId);
    if (bid.artisanId !== artisanId) {
      throw new ForbiddenException('You can only withdraw your own bids');
    }
    if (bid.status !== BidStatus.PENDING) {
      throw new BadRequestException('Only pending bids can be withdrawn');
    }
    bid.status = BidStatus.WITHDRAWN;
    return this.bidsRepository.save(bid);
  }
}
