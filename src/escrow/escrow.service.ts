import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EscrowTransaction,
  EscrowStatus,
  TrancheStatus,
} from './entities/escrow-transaction.entity';
import { CreateEscrowDto } from './dto/create-escrow.dto';

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
  ) {}

  create(createEscrowDto: CreateEscrowDto, clientId: string) {
    const escrow = this.escrowRepository.create({
      ...createEscrowDto,
      clientId,
    });
    return this.escrowRepository.save(escrow);
  }

  async findOne(id: string) {
    const escrow = await this.escrowRepository.findOneBy({ id });
    if (!escrow) {
      throw new NotFoundException(`Escrow transaction ${id} not found`);
    }
    return escrow;
  }

  findByJob(jobId: string) {
    return this.escrowRepository.findOneBy({ jobId });
  }

  private assertTransition(current: EscrowStatus, target: EscrowStatus) {
    const allowed = ALLOWED_TRANSITIONS[current];
    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `Cannot move escrow from ${current} to ${target}`,
      );
    }
  }

  async lockFunds(id: string) {
    const escrow = await this.findOne(id);
    this.assertTransition(escrow.totalStatus, EscrowStatus.FUNDS_LOCKED);
    escrow.tranche1Status = TrancheStatus.LOCKED;
    escrow.tranche2Status = TrancheStatus.LOCKED;
    escrow.totalStatus = EscrowStatus.FUNDS_LOCKED;
    return this.escrowRepository.save(escrow);
  }

  async releaseTranche1(id: string) {
    const escrow = await this.findOne(id);
    this.assertTransition(
      escrow.totalStatus,
      EscrowStatus.TRANCHE_1_RELEASED,
    );
    escrow.tranche1Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.TRANCHE_1_RELEASED;
    return this.escrowRepository.save(escrow);
  }

  async initiateHandshake(id: string) {
    const escrow = await this.findOne(id);
    this.assertTransition(
      escrow.totalStatus,
      EscrowStatus.HANDSHAKE_PENDING,
    );
    escrow.totalStatus = EscrowStatus.HANDSHAKE_PENDING;
    return this.escrowRepository.save(escrow);
  }

  async settle(id: string) {
    const escrow = await this.findOne(id);
    this.assertTransition(escrow.totalStatus, EscrowStatus.SETTLED);
    escrow.tranche2Status = TrancheStatus.RELEASED;
    escrow.totalStatus = EscrowStatus.SETTLED;
    return this.escrowRepository.save(escrow);
  }

  async dispute(id: string) {
    const escrow = await this.findOne(id);
    this.assertTransition(escrow.totalStatus, EscrowStatus.DISPUTED);
    escrow.totalStatus = EscrowStatus.DISPUTED;
    return this.escrowRepository.save(escrow);
  }
}
