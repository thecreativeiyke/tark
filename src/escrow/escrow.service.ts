import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
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

const ALLOWED_TRANSITIONS: Record<EscrowStatus, EscrowStatus[]> = {
  [EscrowStatus.INITIATED]: [EscrowStatus.FUNDS_LOCKED],
  [EscrowStatus.FUNDS_LOCKED]: [
    EscrowStatus.TRANCHE_1_RELEASED,
    EscrowStatus.DISPUTED,
  ],
  [EscrowStatus.TRANCHE_1_RELEASED]: [
    EscrowStatus.HANDSHAKE_PENDING,
    EscrowStatus.DISPUTED,
  ],
  [EscrowStatus.HANDSHAKE_PENDING]: [
    EscrowStatus.SETTLED,
    EscrowStatus.DISPUTED,
  ],
  [EscrowStatus.SETTLED]: [],
  [EscrowStatus.DISPUTED]: [],
};

@Injectable()
export class EscrowService {
  constructor(
    @InjectRepository(EscrowTransaction)
    private escrowRepository: Repository<EscrowTransaction>,
    private jobsService: JobsService,
  ) {}

  async create(createEscrowDto: CreateEscrowDto, clientId: string) {
    const escrow = this.escrowRepository.create({
      ...createEscrowDto,
      clientId,
    });
    const saved = await this.escrowRepository.save(escrow);

    if (createEscrowDto.artisanId) {
      await this.jobsService.assignArtisan(
        createEscrowDto.jobId,
        createEscrowDto.artisanId,
      );
    }

    return saved;
  }

  async findOne(id: string) {
    const escrow = await this.escrowRepository.findOneBy({ id });
    if (!escrow) {
      throw new NotFoundException(`Escrow transaction ${id} not found`);
    }
    return escrow;
  }

  async findOneForUser(id: string, userId: string) {
    const escrow = await this.findOne(id);
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to view this escrow',
      );
    }
    return this.sanitizeForUser(escrow, userId);
  }

  async findByJob(jobId: string) {
    return this.escrowRepository.findOneBy({ jobId });
  }

  async findByJobForUser(jobId: string, userId: string) {
    const escrow = await this.findByJob(jobId);
    if (!escrow) {
      throw new NotFoundException(
        `Escrow transaction for job ${jobId} not found`,
      );
    }
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to view this escrow',
      );
    }
    return this.sanitizeForUser(escrow, userId);
  }

  findByReference(reference: string) {
    return this.escrowRepository.findOneBy({ paystackReference: reference });
  }

  async attachPaystackReference(id: string, reference: string) {
    const escrow = await this.findOne(id);
    escrow.paystackReference = reference;
    return this.escrowRepository.save(escrow);
  }

  private assertTransition(current: EscrowStatus, target: EscrowStatus) {
    const allowed = ALLOWED_TRANSITIONS[current];
    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `Cannot move escrow from ${current} to ${target}`,
      );
    }
  }

  private sanitizeForUser(
    escrow: EscrowTransaction,
    userId: string,
  ): EscrowTransaction {
    if (escrow.clientId !== userId) {
      const sanitized = { ...escrow };
      sanitized.handshakePin = null;
      return sanitized as EscrowTransaction;
    }
    return escrow;
  }

  async lockFunds(id: string) {
    const escrow = await this.findOne(id);
    this.assertTransition(escrow.totalStatus, EscrowStatus.FUNDS_LOCKED);
    escrow.tranche1Status = TrancheStatus.LOCKED;
    escrow.tranche2Status = TrancheStatus.LOCKED;
    escrow.totalStatus = EscrowStatus.FUNDS_LOCKED;
    const saved = await this.escrowRepository.save(escrow);

    // Job transitions to IN_PROGRESS now that payment is confirmed
    await this.jobsService.updateStatus(escrow.jobId, JobStatus.IN_PROGRESS);

    return saved;
  }

  async releaseTranche1(id: string, userId: string) {
    const escrow = await this.findOne(id);
    if (escrow.clientId !== userId) {
      throw new ForbiddenException(
        'Only the paying client can release Tranche 1',
      );
    }
    this.assertTransition(
      escrow.totalStatus,
      EscrowStatus.TRANCHE_1_RELEASED,
    );
    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.TRANCHE_1_RELEASED;
    return this.escrowRepository.save(escrow);
  }

  async initiateHandshake(id: string, userId: string) {
    const escrow = await this.findOne(id);
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new ForbiddenException(
        'Only the assigned client or artisan can initiate the handshake',
      );
    }
    this.assertTransition(
      escrow.totalStatus,
      EscrowStatus.HANDSHAKE_PENDING,
    );

    const generatedPin = Math.floor(100000 + Math.random() * 900000).toString();

    escrow.handshakePin = generatedPin;
    escrow.handshakeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    escrow.totalStatus = EscrowStatus.HANDSHAKE_PENDING;

    const saved = await this.escrowRepository.save(escrow);
    return this.sanitizeForUser(saved, userId);
  }

  async verifyHandshake(id: string, pin: string, userId: string) {
    const escrow = await this.findOne(id);

    if (escrow.artisanId && escrow.artisanId !== userId) {
      throw new ForbiddenException(
        'Only the assigned artisan can verify this handshake',
      );
    }

    if (escrow.totalStatus !== EscrowStatus.HANDSHAKE_PENDING) {
      throw new BadRequestException(
        `Handshake is not pending. Current status: ${escrow.totalStatus}`,
      );
    }

    if (escrow.handshakeExpiresAt && new Date() > escrow.handshakeExpiresAt) {
      throw new BadRequestException(
        'Handshake PIN has expired. Please initiate a new handshake.',
      );
    }

    if (escrow.handshakePin !== pin) {
      throw new BadRequestException('Invalid handshake PIN');
    }

    this.assertTransition(escrow.totalStatus, EscrowStatus.SETTLED);

    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;

    const saved = await this.escrowRepository.save(escrow);

    // Job is officially completed
    await this.jobsService.updateStatus(escrow.jobId, JobStatus.COMPLETED);

    return saved;
  }

  async settle(id: string, userId: string) {
    const escrow = await this.findOne(id);
    if (escrow.clientId !== userId) {
      throw new ForbiddenException(
        'Only the paying client can confirm settlement directly',
      );
    }
    this.assertTransition(escrow.totalStatus, EscrowStatus.SETTLED);
    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    escrow.handshakePin = null;
    escrow.handshakeExpiresAt = null;

    const saved = await this.escrowRepository.save(escrow);
    await this.jobsService.updateStatus(escrow.jobId, JobStatus.COMPLETED);
    return saved;
  }

  async dispute(id: string, userId: string) {
    const escrow = await this.findOne(id);
    if (escrow.clientId !== userId && escrow.artisanId !== userId) {
      throw new ForbiddenException(
        'Only the client or assigned artisan can dispute this escrow',
      );
    }
    this.assertTransition(escrow.totalStatus, EscrowStatus.DISPUTED);
    escrow.totalStatus = EscrowStatus.DISPUTED;

    const saved = await this.escrowRepository.save(escrow);
    await this.jobsService.updateStatus(escrow.jobId, JobStatus.DISPUTED);
    return saved;
  }
}
