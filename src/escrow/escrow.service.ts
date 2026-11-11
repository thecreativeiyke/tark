import { toMinorUnits, isTranche1Compliant, tranche1PolicyMessage } from './escrow-policy';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import {
  EscrowTransaction,
  EscrowStatus,
  TrancheStatus,
} from './entities/escrow-transaction.entity';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { JobsService } from '../jobs/jobs.service';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';

// Maximum failed PIN attempts before the handshake is reset
const MAX_PIN_ATTEMPTS = 5;
const PIN_TTL_MS = 15 * 60 * 1000;

// Proof-of-work photos must come from Tark's own storage, in this folder.
// (Matches the folder used by MediaService.uploadFile for proof of work.)
const PROOF_PATH_SEGMENT = '/escrow/proof-of-work/';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    @InjectRepository(EscrowTransaction)
    private escrowRepository: Repository<EscrowTransaction>,
    @InjectDataSource()
    private dataSource: DataSource,
    private configService: ConfigService,
    private jobsService: JobsService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────────────

  // Loads the escrow row with a write lock for the rest of the transaction.
  // A second request for the same escrow waits here until the first commits,
  // then sees the updated status. This is what stops double payouts.
  private async lockEscrow(manager: EntityManager, id: string): Promise<EscrowTransaction> {
    const escrow = await manager.findOne(EscrowTransaction, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!escrow) {
      throw new NotFoundException('Escrow transaction not found');
    }
    return escrow;
  }

  private toMinor(amount: number | string): number {
    return Math.round(Number(amount) * 100);
  }

  private pinsMatch(stored: string, provided: string): boolean {
    const a = Buffer.from(stored);
    const b = Buffer.from(String(provided ?? ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private resetHandshake(escrow: EscrowTransaction, opts = { penalize: false }) {
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;
    escrow.handshakePinAttempts = 0;

    if (opts.penalize) {
      escrow.handshakeCycles = (escrow.handshakeCycles || 0) + 1;
      // Exponential lockout cooldown: 15min * 2^(cycles - 1), capped at 24 hours (1440 mins)
      const mins = Math.min(15 * Math.pow(2, escrow.handshakeCycles - 1), 24 * 60);
      escrow.handshakeLockedUntil = new Date(Date.now() + mins * 60 * 1000);
      if (escrow.handshakeCycles >= 3) {
        this.logger.warn(
          `Escrow #${escrow.id} has reached ${escrow.handshakeCycles} lockout cycles. Human ops review recommended.`,
        );
      }
    }

    escrow.totalStatus =
      escrow.tranche1Status === TrancheStatus.RELEASED
        ? EscrowStatus.TRANCHE_1_RELEASED
        : EscrowStatus.FUNDS_LOCKED;
  }

  private async requirePayoutRecipient(
    manager: EntityManager,
    escrow: EscrowTransaction,
  ): Promise<string> {
    if (!escrow.artisanId) {
      throw new BadRequestException('No artisan is assigned to this escrow');
    }
    const artisan = await manager.findOneBy(User, { id: escrow.artisanId });
    if (!artisan?.payoutRecipientCode) {
      throw new BadRequestException(
        'The artisan has not set up their payout account yet. ' +
          'Ask them to add their bank details before funds can be released.',
      );
    }
    return artisan.payoutRecipientCode;
  }

  private noteIfSimulated(transfer: { simulated?: boolean }, escrowId: string) {
    if (transfer.simulated) {
      this.logger.warn(
        `Escrow #${escrowId}: payout was SIMULATED (sandbox mode). No real money moved.`,
      );
    }
  }

  // Proof-of-work must be photos uploaded through Tark's own storage.
  // NOTE: uploads are not yet tied to a specific job, so this cannot stop an
  // artisan reusing a photo from a previous job. That needs job-scoped uploads.
  private validateProofUrls(urls: string[]) {
    const cdn = this.configService.get<string>('STORAGE_CUSTOM_CDN_URL');
    let cdnHost: string;
    try {
      cdnHost = new URL(cdn ?? '').host;
    } catch {
      throw new InternalServerErrorException('Proof-of-work storage is not configured');
    }

    for (const raw of urls) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new BadRequestException('Each proof-of-work entry must be a valid URL');
      }
      if (
        parsed.protocol !== 'https:' ||
        parsed.host !== cdnHost ||
        !parsed.pathname.includes(PROOF_PATH_SEGMENT)
      ) {
        throw new BadRequestException(
          'Proof-of-work must be photos uploaded through Tark. Please upload the photos in the app and try again.',
        );
      }
    }
  }

  // Pays out everything not yet released (unpaid tranche 1 + tranche 2) and
  // marks the escrow SETTLED. Must be called inside a transaction that already
  // holds the escrow row lock.
  private async payoutAndSettle(
    manager: EntityManager,
    escrow: EscrowTransaction,
    label: string,
  ): Promise<EscrowTransaction> {
    const recipientCode = await this.requirePayoutRecipient(manager, escrow);

    const t1UnpaidMinor =
      escrow.tranche1Status !== TrancheStatus.RELEASED
        ? this.toMinor(escrow.tranche1Amount)
        : 0;
    const feeMinor = this.toMinor(escrow.platformFeeAmount || 0);
    const grossFinalMinor = t1UnpaidMinor + this.toMinor(escrow.tranche2Amount);
    const amountMinor = Math.max(0, grossFinalMinor - feeMinor);
    if (amountMinor <= 0) {
      throw new BadRequestException('There is nothing left to pay out on this escrow after platform fee');
    }

    const transfer = await this.paymentsService.initiateTransfer(
      amountMinor,
      recipientCode,
      `Tark Payout: ${label} for Job #${escrow.jobId.slice(0, 8)}`,
      escrow.currency,
      // Same reference for every final payout attempt on this escrow, so the
      // provider rejects a duplicate even if our own bookkeeping failed.
      `tark-final-${escrow.id}`,
    );
    this.noteIfSimulated(transfer, escrow.id);

    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;
    escrow.handshakePinAttempts = 0;
    escrow.tranche2TransferRef = transfer.reference ?? null;

    await manager.update(Job, escrow.jobId, { status: JobStatus.COMPLETED });
    return manager.save(EscrowTransaction, escrow);
  }

  // ─────────────────────────────────────────────────────────────────────
  // CREATE — everything that moves money is taken from the accepted bid
  // stored on the job, never trusted from the request body.
  // ─────────────────────────────────────────────────────────────────────
  // `manager` is passed by callers already inside a transaction (e.g. accepting a bid) so the job and
  // escrow are read/written on the SAME connection. Without it, a separate connection cannot see the
  // transaction's uncommitted job update (artisan + tranche amounts) and the checks below always fail.
  async create(createEscrowDto: CreateEscrowDto, clientId: string, manager?: EntityManager) {
    const escrowRepo = manager ? manager.getRepository(EscrowTransaction) : this.escrowRepository;
    const job = manager
      ? await manager.findOneBy(Job, { id: createEscrowDto.jobId })
      : await this.jobsService.findOne(createEscrowDto.jobId);
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (job.clientId !== clientId) {
      throw new ForbiddenException('Only the job owner can create an escrow for this job');
    }

    if (!job.artisanId || job.tranche1Amount == null || job.tranche2Amount == null) {
      throw new BadRequestException(
        'An escrow can only be created after a bid has been accepted for this job',
      );
    }

    if (createEscrowDto.artisanId && createEscrowDto.artisanId !== job.artisanId) {
      throw new BadRequestException('The artisan does not match the accepted bid');
    }

    if (
      this.toMinor(createEscrowDto.tranche1Amount) !== this.toMinor(job.tranche1Amount) ||
      this.toMinor(createEscrowDto.tranche2Amount) !== this.toMinor(job.tranche2Amount)
    ) {
      throw new BadRequestException('The tranche amounts do not match the accepted bid');
    }

    const existing = await escrowRepo.findOneBy({ jobId: job.id });
    if (existing) {
      throw new BadRequestException('An escrow already exists for this job');
    }

    const totalBudgetMinor = toMinorUnits(Number(job.tranche1Amount) + Number(job.tranche2Amount));
    const t1Minor = toMinorUnits(job.tranche1Amount);
    if (!isTranche1Compliant(t1Minor, totalBudgetMinor)) {
      throw new BadRequestException(`Cannot create escrow: ${tranche1PolicyMessage()}`);
    }

    const totalBudget = Number(job.tranche1Amount) + Number(job.tranche2Amount);
    // 5% Tark Protocol Fee (calculated on total job budget, retained by platform upon settlement)
    const platformFee = Math.round(totalBudget * 0.05 * 100) / 100;

    const escrow = escrowRepo.create({
      jobId: job.id,
      clientId,
      artisanId: job.artisanId,
      currency: job.currency || 'NGN',
      tranche1Amount: Number(job.tranche1Amount),
      tranche2Amount: Number(job.tranche2Amount),
      platformFeeAmount: platformFee,
      totalStatus: EscrowStatus.INITIATED,
      tranche1Status: TrancheStatus.PENDING,
      tranche2Status: TrancheStatus.PENDING,
    });

    try {
      return await escrowRepo.save(escrow);
    } catch (err: any) {
      // Unique index on jobId: two simultaneous requests, second one loses.
      if ((err?.code ?? err?.driverError?.code) === '23505') {
        throw new BadRequestException('An escrow already exists for this job');
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // FIND — user-scoped versions mask the PIN from the artisan
  // ─────────────────────────────────────────────────────────────────────
  async findOne(id: string) {
    const escrow = await this.escrowRepository.findOneBy({ id });
    if (!escrow) {
      throw new NotFoundException('Escrow transaction not found');
    }
    return escrow;
  }

  async findOneForUser(id: string, userId: string) {
    const escrow = await this.findOne(id);
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new ForbiddenException('You do not have access to this escrow');
    }
    // Only the client may see the PIN. The artisan collects it from the client.
    if (escrow.artisanId === userId && escrow.totalStatus === EscrowStatus.HANDSHAKE_PENDING) {
      return { ...escrow, handshakePin: null };
    }
    return escrow;
  }

  async findByJobId(jobId: string) {
    return this.escrowRepository.findOneBy({ jobId });
  }

  async findByJobForUser(jobId: string, userId: string) {
    const escrow = await this.findByJobId(jobId);
    if (!escrow) return null;
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new ForbiddenException('You do not have access to this escrow');
    }
    if (escrow.artisanId === userId && escrow.totalStatus === EscrowStatus.HANDSHAKE_PENDING) {
      return { ...escrow, handshakePin: null };
    }
    return escrow;
  }

  async findByReference(paystackReference: string) {
    return this.escrowRepository.findOneBy({ paystackReference });
  }

  async attachPaystackReference(id: string, reference: string) {
    const escrow = await this.findOne(id);
    escrow.paystackReference = reference;
    return this.escrowRepository.save(escrow);
  }

  // ─────────────────────────────────────────────────────────────────────
  // LOCK FUNDS — called only by the payment webhook / wallet funding,
  // never a public route.
  // ─────────────────────────────────────────────────────────────────────
  async lockFunds(id: string) {
    const saved = await this.dataSource.transaction(async (manager) => {
      const escrow = await this.lockEscrow(manager, id);

      if (escrow.totalStatus !== EscrowStatus.INITIATED) {
        throw new BadRequestException('Funds can only be locked from INITIATED status');
      }

      escrow.totalStatus = EscrowStatus.FUNDS_LOCKED;
      escrow.tranche1Status = TrancheStatus.LOCKED;
      escrow.tranche2Status = TrancheStatus.LOCKED;

      await manager.update(Job, escrow.jobId, { status: JobStatus.IN_PROGRESS });
      return manager.save(EscrowTransaction, escrow);
    });

    // Notify artisan that escrow is funded and ready
    this.dataSource
      .getRepository(Job)
      .findOne({ where: { id: saved.jobId } })
      .then(async (job) => {
        if (!job || !saved.artisanId) return;
        const [client, artisan] = await Promise.all([
          this.dataSource.getRepository(User).findOne({ where: { id: saved.clientId } }),
          this.dataSource.getRepository(User).findOne({ where: { id: saved.artisanId } }),
        ]);
        const totalEscrowBudget = Number(saved.tranche1Amount) + Number(saved.tranche2Amount);
        return this.notificationsService.notifySafeLockFunded({
          artisanId: saved.artisanId,
          artisanName: artisan?.fullName || 'Artisan',
          clientName: client?.fullName || 'Client',
          jobTitle: job.title,
          totalBudget: totalEscrowBudget,
          tranche1Amount: Number(saved.tranche1Amount),
          jobId: job.id,
          escrowId: saved.id,
        });
      })
      .catch((err) => this.logger.error(`Failed to dispatch Safe-Lock funded alert: ${err.message}`));

    return saved;
  }

  // ─────────────────────────────────────────────────────────────────────
  // RELEASE TRANCHE 1 — client kicks off work; artisan must have a payout
  // account. Only allowed while funds are locked (not disputed / mid-handshake).
  // ─────────────────────────────────────────────────────────────────────
  async releaseTranche1(id: string, clientId: string) {
    const saved = await this.dataSource.transaction(async (manager) => {
      const escrow = await this.lockEscrow(manager, id);

      if (escrow.clientId !== clientId) {
        throw new ForbiddenException('Only the client can release Tranche 1');
      }

      if (
        escrow.totalStatus !== EscrowStatus.FUNDS_LOCKED ||
        escrow.tranche1Status !== TrancheStatus.LOCKED
      ) {
        throw new BadRequestException(
          'Tranche 1 can only be released while funds are locked, with no dispute or handshake in progress',
        );
      }

      const recipientCode = await this.requirePayoutRecipient(manager, escrow);

      const transfer = await this.paymentsService.initiateTransfer(
        this.toMinor(escrow.tranche1Amount),
        recipientCode,
        `Tark Payout: Tranche 1 for Job #${escrow.jobId.slice(0, 8)}`,
        escrow.currency,
        `tark-t1-${escrow.id}`,
      );
      this.noteIfSimulated(transfer, escrow.id);

      escrow.tranche1Status = TrancheStatus.RELEASED;
      escrow.totalStatus = EscrowStatus.TRANCHE_1_RELEASED;
      escrow.tranche1TransferRef = transfer.reference ?? null;

      return manager.save(EscrowTransaction, escrow);
    });

    // Notify artisan of mobilization disbursement
    this.dataSource
      .getRepository(Job)
      .findOne({ where: { id: saved.jobId } })
      .then(async (job) => {
        if (!job || !saved.artisanId) return;
        const artisan = await this.dataSource.getRepository(User).findOne({ where: { id: saved.artisanId } });
        return this.notificationsService.notifyTranche1Released({
          artisanId: saved.artisanId,
          artisanName: artisan?.fullName || 'Artisan',
          jobTitle: job.title,
          amount: Number(saved.tranche1Amount),
          jobId: job.id,
        });
      })
      .catch((err) => this.logger.error(`Failed to dispatch Tranche 1 alert: ${err.message}`));

    return saved;
  }

  // ─────────────────────────────────────────────────────────────────────
  // INITIATE HANDSHAKE — artisan signals the job is done.
  // The PIN is NEVER returned to the artisan. The client reads it in the app
  // (GET /escrow/:id) and tells the artisan in person.
  // ─────────────────────────────────────────────────────────────────────
  async initiateHandshake(id: string, artisanId: string, proofOfWorkUrls?: string[]) {
    const expiresAt = new Date(Date.now() + PIN_TTL_MS);
    let capturedEscrow: EscrowTransaction | null = null;

    await this.dataSource.transaction(async (manager) => {
      const escrow = await this.lockEscrow(manager, id);

      if (!escrow.artisanId) {
        throw new BadRequestException('No artisan assigned to this escrow');
      }
      if (escrow.artisanId !== artisanId) {
        throw new ForbiddenException('Only the assigned artisan can initiate the handshake');
      }
      // If a handshake was pending but expired, reset it without penalty so artisan can re-initiate
      if (
        escrow.totalStatus === EscrowStatus.HANDSHAKE_PENDING &&
        escrow.handshakeExpiresAt &&
        new Date() > new Date(escrow.handshakeExpiresAt)
      ) {
        this.resetHandshake(escrow, { penalize: false });
      }

      if (
        escrow.totalStatus !== EscrowStatus.FUNDS_LOCKED &&
        escrow.totalStatus !== EscrowStatus.TRANCHE_1_RELEASED
      ) {
        throw new BadRequestException('Cannot initiate handshake at this stage');
      }

      if (escrow.handshakeLockedUntil && new Date() < new Date(escrow.handshakeLockedUntil)) {
        throw new BadRequestException(
          `Handshake is temporarily locked out due to multiple failed PIN attempts. Locked until: ${new Date(escrow.handshakeLockedUntil).toISOString()}`,
        );
      }

      if (!proofOfWorkUrls || proofOfWorkUrls.length === 0) {
        throw new BadRequestException(
          'Mandatory proof-of-work required: Please upload at least one clear photograph of the completed work before initiating the handshake.',
        );
      }
      this.validateProofUrls(proofOfWorkUrls);

      escrow.handshakePin = crypto.randomInt(100000, 1000000).toString();
      escrow.handshakeExpiresAt = expiresAt;
      escrow.handshakePinAttempts = 0;
      escrow.totalStatus = EscrowStatus.HANDSHAKE_PENDING;
      escrow.proofOfWorkUrls = proofOfWorkUrls;

      capturedEscrow = await manager.save(EscrowTransaction, escrow);
    });

    // Dispatch Handshake PIN alert to Client (via Email, In-App, Push & SMS)
    if (capturedEscrow) {
      const savedEscrow: EscrowTransaction = capturedEscrow;
      this.dataSource
        .getRepository(Job)
        .findOne({ where: { id: savedEscrow.jobId } })
        .then(async (job) => {
          if (!job) return;
          const [client, artisan] = await Promise.all([
            this.dataSource.getRepository(User).findOne({ where: { id: savedEscrow.clientId } }),
            this.dataSource.getRepository(User).findOne({ where: { id: savedEscrow.artisanId } }),
          ]);
          return this.notificationsService.notifyHandshakeReady({
            clientId: savedEscrow.clientId,
            clientName: client?.fullName || 'Client',
            artisanName: artisan?.fullName || 'Artisan',
            jobTitle: job.title,
            handshakePin: savedEscrow.handshakePin!,
            jobId: job.id,
          });
        })
        .catch((err) => this.logger.error(`Failed to dispatch Handshake alert: ${err.message}`));
    }

    // Never log the PIN itself.
    this.logger.log(
      `Handshake initiated for Escrow #${id}. Code expires at ${expiresAt.toISOString()}`,
    );

    return {
      message:
        'Handshake started. Ask the client for the 6-digit completion code shown in their Tark app. It expires in 15 minutes.',
      expiresAt,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // VERIFY HANDSHAKE — artisan enters the client's PIN, triggering payout.
  // Failed attempts are committed (not rolled back) so the limiter holds even
  // under parallel guessing: the row lock serialises every attempt.
  // ─────────────────────────────────────────────────────────────────────
  async verifyHandshake(id: string, artisanId: string, pin: string) {
    type Outcome = { rejectedMessage: string } | { escrow: EscrowTransaction };

    const outcome = await this.dataSource.transaction(async (manager): Promise<Outcome> => {
      const escrow = await this.lockEscrow(manager, id);

      if (!escrow.artisanId || escrow.artisanId !== artisanId) {
        throw new ForbiddenException('Only the assigned artisan can verify the handshake PIN');
      }
      if (escrow.totalStatus !== EscrowStatus.HANDSHAKE_PENDING) {
        throw new BadRequestException('No pending handshake for this escrow');
      }
      if (!escrow.handshakePin || !escrow.handshakeExpiresAt) {
        throw new BadRequestException('Handshake PIN not found');
      }

      // Attempts are checked BEFORE the PIN, so a correct guess after too many
      // failures is still rejected.
      if (escrow.handshakePinAttempts >= MAX_PIN_ATTEMPTS) {
        this.resetHandshake(escrow, { penalize: true });
        await manager.save(EscrowTransaction, escrow);
        return {
          rejectedMessage:
            `Too many incorrect attempts. Handshake is locked until ${escrow.handshakeLockedUntil?.toISOString()}.`,
        };
      }

      if (new Date() > escrow.handshakeExpiresAt) {
        this.resetHandshake(escrow, { penalize: false });
        await manager.save(EscrowTransaction, escrow);
        return { rejectedMessage: 'Handshake PIN has expired. Please initiate a new one.' };
      }

      if (!this.pinsMatch(escrow.handshakePin, pin)) {
        escrow.handshakePinAttempts += 1;
        if (escrow.handshakePinAttempts >= MAX_PIN_ATTEMPTS) {
          this.resetHandshake(escrow, { penalize: true });
          await manager.save(EscrowTransaction, escrow);
          return {
            rejectedMessage:
              `Too many incorrect attempts. Handshake is locked until ${escrow.handshakeLockedUntil?.toISOString()}.`,
          };
        }
        await manager.save(EscrowTransaction, escrow);
        const remaining = MAX_PIN_ATTEMPTS - escrow.handshakePinAttempts;
        return {
          rejectedMessage: `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        };
      }

      // PIN is correct. If the payout fails, the exception rolls everything back
      // and the escrow stays HANDSHAKE_PENDING.
      const settled = await this.payoutAndSettle(manager, escrow, 'Final Settlement');
      return { escrow: settled };
    });

    if ('rejectedMessage' in outcome) {
      throw new BadRequestException(outcome.rejectedMessage);
    }

    // Payout settled successfully: Notify artisan of final settlement & payout
    const settledEscrow = outcome.escrow;
    this.dataSource
      .getRepository(Job)
      .findOne({ where: { id: settledEscrow.jobId } })
      .then(async (job) => {
        if (!job || !settledEscrow.artisanId) return;
        const artisan = await this.dataSource
          .getRepository(User)
          .findOne({ where: { id: settledEscrow.artisanId } });
        const grossFinal = Number(settledEscrow.tranche2Amount);
        const fee = Number(settledEscrow.platformFeeAmount || 0);
        const netDisbursed = Math.max(0, grossFinal - fee);
        const totalJobBudget = Number(settledEscrow.tranche1Amount) + Number(settledEscrow.tranche2Amount);
        return this.notificationsService.notifyPayoutSettled({
          artisanId: settledEscrow.artisanId,
          artisanName: artisan?.fullName || 'Artisan',
          jobTitle: job.title,
          disbursedAmount: netDisbursed,
          platformFeeAmount: fee,
          totalJobBudget: totalJobBudget,
          accountMasked: artisan?.payoutAccountIdentifier
            ? `***${artisan.payoutAccountIdentifier.slice(-4)}`
            : undefined,
          jobId: job.id,
        });
      })
      .catch((err) => this.logger.error(`Failed to dispatch payout alert: ${err.message}`));

    return outcome.escrow;
  }

  // ─────────────────────────────────────────────────────────────────────
  // SETTLE — client manually completes (not exposed as a route today).
  // Includes any unreleased tranche 1 in the payout.
  // ─────────────────────────────────────────────────────────────────────
  async settle(id: string, userId: string) {
    return this.dataSource.transaction(async (manager) => {
      const escrow = await this.lockEscrow(manager, id);

      if (escrow.clientId !== userId) {
        throw new ForbiddenException('Only the client can manually trigger settlement');
      }

      if (
        escrow.totalStatus !== EscrowStatus.HANDSHAKE_PENDING &&
        escrow.totalStatus !== EscrowStatus.TRANCHE_1_RELEASED
      ) {
        throw new BadRequestException('Escrow cannot be settled at this stage');
      }

      return this.payoutAndSettle(manager, escrow, 'Manual Settlement');
    });
  }

  // NOTE: the old escrow-level dispute() was removed on purpose. Disputes are
  // opened through DisputesService (POST /disputes), which records the case,
  // the 48-hour response window and the admin queue entry. A bare status flip
  // here froze funds with no case for an admin to resolve.
}
