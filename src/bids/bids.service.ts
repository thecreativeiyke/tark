import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bid, BidStatus } from './entities/bid.entity';
import { CreateBidDto } from './dto/create-bid.dto';
import { JobsService } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/entities/job.entity';
import { EscrowService } from '../escrow/escrow.service';

@Injectable()
export class BidsService {
  constructor(
    @InjectRepository(Bid)
    private bidsRepository: Repository<Bid>,
    private jobsService: JobsService,
    private escrowService: EscrowService,
  ) {}

  async create(dto: CreateBidDto, artisanId: string, role: string) {
    if (role !== 'artisan') {
      throw new ForbiddenException('Only registered artisans can place bids on jobs');
    }

    const job = await this.jobsService.findOne(dto.jobId);
    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException('Cannot bid on a job that is not OPEN');
    }

    const trancheSum = Number(dto.tranche1Amount) + Number(dto.tranche2Amount);
    if (Math.round(trancheSum) !== Math.round(Number(dto.amount))) {
      throw new BadRequestException('The sum of Tranche 1 and Tranche 2 must equal the total bid amount');
    }

    // Check for existing pending bid from this artisan
    const existing = await this.bidsRepository.findOneBy({
      jobId: dto.jobId,
      artisanId,
      status: BidStatus.PENDING,
    });
    if (existing) {
      throw new BadRequestException('You already have a pending bid on this job. Withdraw or update it instead.');
    }

    const bid = this.bidsRepository.create({
      ...dto,
      artisanId,
      status: BidStatus.PENDING,
    });
    return this.bidsRepository.save(bid);
  }

  async findByJob(jobId: string) {
    return this.bidsRepository.find({
      where: { jobId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string) {
    const bid = await this.bidsRepository.findOneBy({ id });
    if (!bid) {
      throw new NotFoundException(`Bid #${id} not found`);
    }
    return bid;
  }

  async acceptBid(bidId: string, clientId: string) {
    const bid = await this.findOne(bidId);
    if (bid.status !== BidStatus.PENDING) {
      throw new BadRequestException(`Cannot accept a bid with status ${bid.status}`);
    }

    const job = await this.jobsService.findOne(bid.jobId);
    if (job.clientId !== clientId) {
      throw new ForbiddenException('Only the client who created the job can accept bids');
    }

    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException('Job is no longer open for bid acceptance');
    }

    // 1. Mark this bid ACCEPTED
    bid.status = BidStatus.ACCEPTED;
    await this.bidsRepository.save(bid);

    // 2. Reject all other pending bids for this job
    await this.bidsRepository
      .createQueryBuilder()
      .update(Bid)
      .set({ status: BidStatus.REJECTED })
      .where('jobId = :jobId AND id != :bidId AND status = :status', {
        jobId: job.id,
        bidId: bid.id,
        status: BidStatus.PENDING,
      })
      .execute();

    // 3. Bind artisan and agreed financial milestones to the Job
    job.artisanId = bid.artisanId;
    job.budget = bid.amount;
    job.tranche1Amount = bid.tranche1Amount;
    job.tranche2Amount = bid.tranche2Amount;
    await this.jobsService.update(job.id, job, clientId);

    // 4. Automatically generate the initial Escrow Transaction
    const escrow = await this.escrowService.create(
      {
        jobId: job.id,
        artisanId: bid.artisanId,
        tranche1Amount: Number(bid.tranche1Amount),
        tranche2Amount: Number(bid.tranche2Amount),
      },
      clientId,
    );

    return {
      message: 'Bid accepted successfully. Escrow initialized.',
      bid,
      escrow,
    };
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
