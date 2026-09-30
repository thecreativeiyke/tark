import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    @InjectRepository(EscrowTransaction)
    private escrowRepository: Repository<EscrowTransaction>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private jobsService: JobsService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
  ) {}

  async create(createEscrowDto: CreateEscrowDto, clientId: string) {
    const job = await this.jobsService.findOne(createEscrowDto.jobId);
    if (!job) {
      throw new NotFoundException('Job not found');
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
      throw new BadRequestException('Unauthorized access to escrow transaction');
    }
    // Security: Mask handshake PIN from artisan so client must verbally or digitally provide it
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
    if (!escrow) {
      return null;
    }
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new BadRequestException('Unauthorized access to escrow transaction');
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

  async releaseTranche1(id: string, clientId: string) {
    const escrow = await this.findOne(id);

    if (escrow.clientId !== clientId) {
      throw new BadRequestException('Only the client can release Tranche 1');
    }

    if (escrow.tranche1Status !== TrancheStatus.LOCKED) {
      throw new BadRequestException('Tranche 1 is not locked or has already been released');
    }

    // Execute automated payout if artisan has registered payout details
    if (escrow.artisanId) {
      const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
      if (artisan?.payoutRecipientCode) {
        const amountKobo = Math.round(Number(escrow.tranche1Amount) * 100);
        await this.paymentsService.initiateTransfer(
          amountKobo,
          artisan.payoutRecipientCode,
          `Tark Payout: Tranche 1 for Job #${escrow.jobId.slice(0, 8)}`,
        );
      }
    }

    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.TRANCHE_1_RELEASED;

    return this.escrowRepository.save(escrow);
  }

  async initiateHandshake(id: string, artisanId: string, proofOfWorkUrls?: string[]) {
    const escrow = await this.findOne(id);

    if (!escrow.artisanId) {
      throw new BadRequestException('Cannot initiate handshake: No artisan is assigned to this escrow');
    }
    if (escrow.artisanId !== artisanId) {
      throw new BadRequestException('Only the assigned artisan can initiate handshake');
    }

    if (
      escrow.totalStatus !== EscrowStatus.FUNDS_LOCKED &&
      escrow.totalStatus !== EscrowStatus.TRANCHE_1_RELEASED
    ) {
      throw new BadRequestException('Cannot initiate completion handshake at this stage');
    }

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    escrow.handshakePin = pin;
    escrow.handshakeExpiresAt = expiresAt;
    escrow.totalStatus = EscrowStatus.HANDSHAKE_PENDING;
    if (proofOfWorkUrls && proofOfWorkUrls.length > 0) {
      escrow.proofOfWorkUrls = proofOfWorkUrls;
    }

    await this.escrowRepository.save(escrow);
    this.logger.log(`Handshake PIN [${pin}] generated for Escrow #${escrow.id}.`);

    return {
      message: 'Handshake initiated. Client has received the 6-digit confirmation PIN.',
      expiresAt,
    };
  }

  async verifyHandshake(id: string, artisanId: string, pin: string) {
    const escrow = await this.findOne(id);

    if (escrow.artisanId && escrow.artisanId !== artisanId) {
      throw new BadRequestException('Only the assigned artisan can verify the handshake PIN');
    }

    if (escrow.totalStatus !== EscrowStatus.HANDSHAKE_PENDING) {
      throw new BadRequestException('No pending handshake verification for this escrow');
    }

    if (!escrow.handshakePin || !escrow.handshakeExpiresAt) {
      throw new BadRequestException('Handshake PIN not found');
    }

    if (!escrow.artisanId || escrow.artisanId !== artisanId) {
      throw new BadRequestException('Only the assigned artisan can verify the handshake PIN');
    }

    if (new Date() > escrow.handshakeExpiresAt) {
      escrow.handshakePin = null;
      escrow.handshakeExpiresAt = null;
      escrow.totalStatus = escrow.tranche1Status === TrancheStatus.RELEASED
        ? EscrowStatus.TRANCHE_1_RELEASED
        : EscrowStatus.FUNDS_LOCKED;
      await this.escrowRepository.save(escrow);
      throw new BadRequestException('Handshake PIN has expired. Please initiate a new one.');
    }

    if (escrow.handshakePin !== pin) {
      throw new BadRequestException('Invalid Handshake PIN');
    }

    // Automated payout for Tranche 2
    if (escrow.artisanId) {
      const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
      if (artisan?.payoutRecipientCode) {
        const amountKobo = Math.round(Number(escrow.tranche2Amount) * 100);
        await this.paymentsService.initiateTransfer(
          amountKobo,
          artisan.payoutRecipientCode,
          `Tark Payout: Tranche 2 for Job #${escrow.jobId.slice(0, 8)}`,
        );
      }
    }

    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;

    await this.jobsService.updateStatus(escrow.jobId, JobStatus.COMPLETED);
    return this.escrowRepository.save(escrow);
  }

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

    if (escrow.artisanId) {
      const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
      if (artisan?.payoutRecipientCode) {
        const amountKobo = Math.round(Number(escrow.tranche2Amount) * 100);
        await this.paymentsService.initiateTransfer(
          amountKobo,
          artisan.payoutRecipientCode,
          `Tark Payout: Settlement for Job #${escrow.jobId.slice(0, 8)}`,
        );
      }
    }

    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;

    await this.jobsService.updateStatus(escrow.jobId, JobStatus.COMPLETED);
    return this.escrowRepository.save(escrow);
  }

  async dispute(id: string, userId: string) {
    const escrow = await this.findOne(id);

    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new BadRequestException('Only the client or artisan can raise a dispute');
    }

    escrow.totalStatus = EscrowStatus.DISPUTED;
    await this.jobsService.updateStatus(escrow.jobId, JobStatus.DISPUTED);
    return this.escrowRepository.save(escrow);
  }
}
