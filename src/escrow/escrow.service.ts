import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import {
  EscrowTransaction,
  EscrowStatus,
  TrancheStatus,
} from './entities/escrow-transaction.entity';
import { CreateEscrowDto } from './dto/create-escrow.dto';
import { JobsService } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';

// Maximum failed PIN attempts before the handshake is reset
const MAX_PIN_ATTEMPTS = 5;

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    @InjectRepository(EscrowTransaction)
    private escrowRepository: Repository<EscrowTransaction>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectDataSource()
    private dataSource: DataSource,
    private jobsService: JobsService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // CREATE — one escrow per job, amounts must match the accepted bid
  // ─────────────────────────────────────────────────────────────────────
  async create(createEscrowDto: CreateEscrowDto, clientId: string) {
    const job = await this.jobsService.findOne(createEscrowDto.jobId);

    // Only the client who owns the job can create its escrow
    if (job.clientId !== clientId) {
      throw new BadRequestException('Only the job owner can create an escrow for this job');
    }

    // Enforce one escrow per job — no double-dipping
    const existing = await this.escrowRepository.findOneBy({ jobId: createEscrowDto.jobId });
    if (existing) {
      throw new BadRequestException('An escrow already exists for this job');
    }

    const escrow = this.escrowRepository.create({
      ...createEscrowDto,
      clientId,
      artisanId: createEscrowDto.artisanId || job.artisanId,
      totalStatus: EscrowStatus.INITIATED,
      tranche1Status: TrancheStatus.PENDING,
      tranche2Status: TrancheStatus.PENDING,
    });

    return this.escrowRepository.save(escrow);
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
      throw new BadRequestException('You do not have access to this escrow');
    }
    // Artisan must never see the PIN — they collect it verbally from the client
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
      throw new BadRequestException('You do not have access to this escrow');
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
  // LOCK FUNDS — called only by the payment webhook, never a public route
  // ─────────────────────────────────────────────────────────────────────
  async lockFunds(id: string) {
    const escrow = await this.findOne(id);

    if (escrow.totalStatus !== EscrowStatus.INITIATED) {
      throw new BadRequestException('Funds can only be locked from INITIATED status');
    }

    escrow.totalStatus = EscrowStatus.FUNDS_LOCKED;
    escrow.tranche1Status = TrancheStatus.LOCKED;
    escrow.tranche2Status = TrancheStatus.LOCKED;

    await this.jobsService.updateStatus(escrow.jobId, JobStatus.IN_PROGRESS);
    return this.escrowRepository.save(escrow);
  }

  // ─────────────────────────────────────────────────────────────────────
  // RELEASE TRANCHE 1 — client kicks off work; artisan must have a payout account
  // ─────────────────────────────────────────────────────────────────────
  async releaseTranche1(id: string, clientId: string) {
    const escrow = await this.findOne(id);

    if (escrow.clientId !== clientId) {
      throw new BadRequestException('Only the client can release Tranche 1');
    }

    if (escrow.tranche1Status !== TrancheStatus.LOCKED) {
      throw new BadRequestException('Tranche 1 is not in a locked state');
    }

    if (!escrow.artisanId) {
      throw new BadRequestException('No artisan is assigned to this escrow');
    }

    const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
    if (!artisan?.payoutRecipientCode) {
      throw new BadRequestException(
        'The artisan has not set up their payout account yet. ' +
        'Ask them to add their bank details before releasing funds.',
      );
    }

    const amountKobo = Math.round(Number(escrow.tranche1Amount) * 100);
    const transferResult = await this.paymentsService.initiateTransfer(
      amountKobo,
      artisan.payoutRecipientCode,
      `Tark Payout: Tranche 1 for Job #${escrow.jobId.slice(0, 8)}`,
      escrow.currency,
    );

    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.TRANCHE_1_RELEASED;
    // Save the transfer reference so we can reconcile later
    escrow.tranche1TransferRef = transferResult.reference ?? null;

    return this.escrowRepository.save(escrow);
  }

  // ─────────────────────────────────────────────────────────────────────
  // INITIATE HANDSHAKE — artisan signals job is done, PIN goes to client
  // Mandatory proof-of-work: at least 1 verified media URL required
  // ─────────────────────────────────────────────────────────────────────
  async initiateHandshake(id: string, artisanId: string, proofOfWorkUrls?: string[]) {
    const escrow = await this.findOne(id);

    if (!escrow.artisanId) {
      throw new BadRequestException('No artisan assigned to this escrow');
    }
    if (escrow.artisanId !== artisanId) {
      throw new BadRequestException('Only the assigned artisan can initiate the handshake');
    }
    if (
      escrow.totalStatus !== EscrowStatus.FUNDS_LOCKED &&
      escrow.totalStatus !== EscrowStatus.TRANCHE_1_RELEASED
    ) {
      throw new BadRequestException('Cannot initiate handshake at this stage');
    }

    if (!proofOfWorkUrls || proofOfWorkUrls.length === 0) {
      throw new BadRequestException(
        'Mandatory proof-of-work required: Please upload at least one clear photograph of the completed work before initiating the handshake.',
      );
    }

    // Cryptographically secure 6-digit PIN — not guessable
    const pin = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    escrow.handshakePin = pin;
    escrow.handshakeExpiresAt = expiresAt;
    escrow.handshakePinAttempts = 0; // reset attempts on fresh PIN
    escrow.totalStatus = EscrowStatus.HANDSHAKE_PENDING;
    escrow.proofOfWorkUrls = proofOfWorkUrls;

    await this.escrowRepository.save(escrow);

    // We log that a handshake was initiated but NEVER log the PIN value itself
    this.logger.log(`Handshake initiated for Escrow #${escrow.id}. PIN expires at ${expiresAt.toISOString()}`);

    return {
      message: 'Handshake initiated. The 6-digit PIN has been sent to the client.',
      expiresAt,
      // PIN is returned here so the caller (controller) can forward it to the client
      // via SMS / push notification. It must not be stored in logs.
      pin,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // VERIFY HANDSHAKE — artisan enters PIN, triggers final payout
  // ─────────────────────────────────────────────────────────────────────
  async verifyHandshake(id: string, artisanId: string, pin: string) {
    const escrow = await this.findOne(id);

    if (!escrow.artisanId || escrow.artisanId !== artisanId) {
      throw new BadRequestException('Only the assigned artisan can verify the handshake PIN');
    }

    if (escrow.totalStatus !== EscrowStatus.HANDSHAKE_PENDING) {
      throw new BadRequestException('No pending handshake for this escrow');
    }

    if (!escrow.handshakePin || !escrow.handshakeExpiresAt) {
      throw new BadRequestException('Handshake PIN not found');
    }

    // Check attempts BEFORE checking the PIN — so a correct guess after too many fails still rejects
    if (escrow.handshakePinAttempts >= MAX_PIN_ATTEMPTS) {
      // Reset so the artisan can initiate a fresh handshake
      escrow.handshakePin = null;
      escrow.handshakeExpiresAt = null;
      escrow.handshakePinAttempts = 0;
      escrow.totalStatus = escrow.tranche1Status === TrancheStatus.RELEASED
        ? EscrowStatus.TRANCHE_1_RELEASED
        : EscrowStatus.FUNDS_LOCKED;
      await this.escrowRepository.save(escrow);
      throw new BadRequestException(
        `Too many incorrect attempts. The PIN has been invalidated. ` +
        `Please initiate a new handshake.`,
      );
    }

    // Check expiry
    if (new Date() > escrow.handshakeExpiresAt) {
      escrow.handshakePin = null;
      escrow.handshakeExpiresAt = null;
      escrow.handshakePinAttempts = 0;
      escrow.totalStatus = escrow.tranche1Status === TrancheStatus.RELEASED
        ? EscrowStatus.TRANCHE_1_RELEASED
        : EscrowStatus.FUNDS_LOCKED;
      await this.escrowRepository.save(escrow);
      throw new BadRequestException('Handshake PIN has expired. Please initiate a new one.');
    }

    // Wrong PIN — increment attempts and save immediately
    if (escrow.handshakePin !== pin) {
      escrow.handshakePinAttempts += 1;
      await this.escrowRepository.save(escrow);
      const remaining = MAX_PIN_ATTEMPTS - escrow.handshakePinAttempts;
      throw new BadRequestException(
        `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      );
    }

    // ── PIN is correct ─────────────────────────────────────────────────
    // Artisan must have a payout account
    const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
    if (!artisan?.payoutRecipientCode) {
      throw new BadRequestException(
        'PIN accepted but the artisan has no payout account configured. ' +
        'Ask them to add their bank details.',
      );
    }

    // Pay out whatever hasn't been released yet:
    // If T1 was never released, it's included now. T2 always goes at settlement.
    const t1Unpaid = escrow.tranche1Status !== TrancheStatus.RELEASED ? Number(escrow.tranche1Amount) : 0;
    const payoutTotal = t1Unpaid + Number(escrow.tranche2Amount);
    const amountKobo = Math.round(payoutTotal * 100);

    const transferResult = await this.paymentsService.initiateTransfer(
      amountKobo,
      artisan.payoutRecipientCode,
      `Tark Payout: Final Settlement for Job #${escrow.jobId.slice(0, 8)}`,
      escrow.currency,
    );

    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;
    escrow.handshakePinAttempts = 0;
    // Save the settlement transfer reference
    escrow.tranche2TransferRef = transferResult.reference ?? null;

    await this.jobsService.updateStatus(escrow.jobId, JobStatus.COMPLETED);
    return this.escrowRepository.save(escrow);
  }

  // ─────────────────────────────────────────────────────────────────────
  // SETTLE — client manually completes (admin-triggered or edge-case)
  // Correctly handles T1 whether it was released or not
  // ─────────────────────────────────────────────────────────────────────
  async settle(id: string, userId: string) {
    const escrow = await this.findOne(id);

    if (escrow.clientId !== userId) {
      throw new BadRequestException('Only the client can manually trigger settlement');
    }

    if (
      escrow.totalStatus !== EscrowStatus.HANDSHAKE_PENDING &&
      escrow.totalStatus !== EscrowStatus.TRANCHE_1_RELEASED
    ) {
      throw new BadRequestException('Escrow cannot be settled at this stage');
    }

    if (!escrow.artisanId) {
      throw new BadRequestException('No artisan assigned to this escrow');
    }

    const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
    if (!artisan?.payoutRecipientCode) {
      throw new BadRequestException('The artisan has not configured a payout account');
    }

    // Include any un-released T1 in the settlement payout
    const t1Unpaid = escrow.tranche1Status !== TrancheStatus.RELEASED ? Number(escrow.tranche1Amount) : 0;
    const payoutTotal = t1Unpaid + Number(escrow.tranche2Amount);
    const amountKobo = Math.round(payoutTotal * 100);

    const transferResult = await this.paymentsService.initiateTransfer(
      amountKobo,
      artisan.payoutRecipientCode,
      `Tark Payout: Manual Settlement for Job #${escrow.jobId.slice(0, 8)}`,
      escrow.currency,
    );

    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;
    escrow.handshakePinAttempts = 0;
    escrow.tranche2TransferRef = transferResult.reference ?? null;

    await this.jobsService.updateStatus(escrow.jobId, JobStatus.COMPLETED);
    return this.escrowRepository.save(escrow);
  }

  // ─────────────────────────────────────────────────────────────────────
  // DISPUTE — freezes funds, escalates to admin queue
  // ─────────────────────────────────────────────────────────────────────
  async dispute(id: string, userId: string) {
    const escrow = await this.findOne(id);

    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new BadRequestException('Only the client or artisan on this escrow can raise a dispute');
    }

    if (escrow.totalStatus === EscrowStatus.SETTLED) {
      throw new BadRequestException('Cannot dispute an already settled escrow');
    }

    if (escrow.totalStatus === EscrowStatus.INITIATED) {
      throw new BadRequestException('Cannot dispute an unfunded escrow');
    }

    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;
    escrow.handshakePinAttempts = 0;
    escrow.totalStatus = EscrowStatus.DISPUTED;

    await this.jobsService.updateStatus(escrow.jobId, JobStatus.DISPUTED);
    return this.escrowRepository.save(escrow);
  }
}
