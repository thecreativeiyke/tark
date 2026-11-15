import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  Dispute,
  DisputePayoutStatus,
  DisputeStatus,
  DisputeVerdict,
} from './entities/dispute.entity';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { RespondDisputeDto } from './dto/respond-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { AssignDisputeDto } from './dto/assign-dispute.dto';
import {
  EscrowTransaction,
  EscrowStatus,
  TrancheStatus,
} from '../escrow/entities/escrow-transaction.entity';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { EscrowService } from '../escrow/escrow.service';
import type { DisputePayoutDispatch } from '../escrow/escrow.service';
import { WalletLedger, WalletLedgerType } from '../payments/entities/wallet-ledger.entity';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @InjectRepository(Dispute)
    private disputesRepository: Repository<Dispute>,
    @InjectRepository(EscrowTransaction)
    private escrowRepository: Repository<EscrowTransaction>,
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectDataSource()
    private dataSource: DataSource,
    private escrowService: EscrowService,
    private notificationsService: NotificationsService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // 1. OPEN DISPUTE: Initiated by either client or artisan
  // Freezes the escrow and starts the 48-hour counter-response window
  // ─────────────────────────────────────────────────────────────────────
  async create(dto: CreateDisputeDto, initiatorId: string) {
    return this.dataSource.transaction(async (manager) => {
      // Pessimistic lock on escrow to prevent race conditions with handshake verification,
      // in-flight payout dispatch, or concurrent duplicate dispute creations
      const lockedEscrow = await manager
        .getRepository(EscrowTransaction)
        .createQueryBuilder('escrow')
        .setLock('pessimistic_write')
        .where('escrow.id = :id', { id: dto.escrowId })
        .getOne();

      if (!lockedEscrow) {
        throw new NotFoundException('Escrow transaction not found');
      }

      if (lockedEscrow.clientId !== initiatorId && lockedEscrow.artisanId !== initiatorId) {
        throw new ForbiddenException('You are not a party to this escrow agreement');
      }

      if (lockedEscrow.totalStatus === EscrowStatus.INITIATED) {
        throw new BadRequestException('Cannot raise a dispute on an unfunded escrow');
      }

      if (lockedEscrow.totalStatus === EscrowStatus.SETTLED) {
        throw new BadRequestException('Cannot raise a dispute on a completed and settled escrow');
      }

      if (lockedEscrow.totalStatus === EscrowStatus.DISPUTED) {
        throw new BadRequestException('An active dispute is already open for this escrow transaction');
      }

      // If a payout transfer is currently in flight at the bank gateway, opening a dispute
      // would create an unresolvable collision if the webhook later confirms or fails.
      if (
        lockedEscrow.tranche1Status === TrancheStatus.PAYOUT_PENDING ||
        lockedEscrow.tranche2Status === TrancheStatus.PAYOUT_PENDING
      ) {
        throw new BadRequestException(
          'A payout transfer is currently in-flight with the payment provider. ' +
          'Please allow a few minutes for the transfer to settle or fail before raising a dispute.',
        );
      }

      // Check for existing active dispute under this lock
      const existing = await manager.findOne(Dispute, {
        where: [
          { escrowId: lockedEscrow.id, status: DisputeStatus.OPEN },
          { escrowId: lockedEscrow.id, status: DisputeStatus.AWAITING_REVIEW },
          { escrowId: lockedEscrow.id, status: DisputeStatus.UNDER_INVESTIGATION },
        ],
      });

      if (existing) {
        throw new BadRequestException('An active dispute is already open for this escrow transaction');
      }

      const defendantId = initiatorId === lockedEscrow.clientId ? lockedEscrow.artisanId : lockedEscrow.clientId;
      if (!defendantId) {
        throw new BadRequestException('Cannot determine opposing party on this escrow');
      }

      // Freeze escrow state
      lockedEscrow.totalStatus = EscrowStatus.DISPUTED;
      lockedEscrow.handshakePin = null;
      lockedEscrow.handshakeExpiresAt = null;
      await manager.save(EscrowTransaction, lockedEscrow);

      // Freeze job state
      await manager.update(Job, lockedEscrow.jobId, { status: JobStatus.DISPUTED });

      // 48-hour response deadline for the opposing party
      const responseDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000);

      const dispute = manager.create(Dispute, {
        jobId: lockedEscrow.jobId,
        escrowId: lockedEscrow.id,
        initiatorId,
        defendantId,
        category: dto.category,
        claimStatement: dto.claimStatement,
        evidenceUrls: dto.evidenceUrls || [],
        responseDeadline,
        status: DisputeStatus.OPEN,
        adminDepartment: 'DISPUTE_DESK',
      });

      const savedDispute = await manager.save(Dispute, dispute);
      this.logger.warn(`Dispute opened: #${savedDispute.id} by ${initiatorId} on Escrow #${lockedEscrow.id}`);

      // Dispatch notice to defendant
      Promise.all([
        this.usersRepository.findOne({ where: { id: defendantId } }),
        this.jobsRepository.findOne({ where: { id: lockedEscrow.jobId } }),
      ])
        .then(([defendant, job]) => {
          if (!defendant) return;
          return this.notificationsService.notifyDisputeUpdate({
            userId: defendant.id,
            userName: defendant.fullName,
            jobTitle: job?.title || 'Service Job',
            disputeReason: dto.claimStatement,
            status: 'OPEN - 48h Response Window Active',
            disputeId: savedDispute.id,
          });
        })
        .catch((err) => this.logger.error(`Dispute notice error: ${err.message}`));

      return {
        message: 'Dispute opened successfully. The opposing party has 48 hours to submit their counter-evidence.',
        dispute: savedDispute,
        responseDeadline,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. DEFENDANT COUNTER-CLAIM: Opposing party provides evidence
  // ─────────────────────────────────────────────────────────────────────
  async respond(disputeId: string, dto: RespondDisputeDto, userId: string) {
    const dispute = await this.disputesRepository.findOneBy({ id: disputeId });
    if (!dispute) {
      throw new NotFoundException('Dispute ticket not found');
    }

    if (dispute.defendantId !== userId) {
      throw new ForbiddenException('Only the designated respondent can submit counter-evidence');
    }

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException(`Cannot submit counter-claim for dispute in status: ${dispute.status}`);
    }

    dispute.counterStatement = dto.counterStatement;
    if (dto.counterEvidenceUrls && dto.counterEvidenceUrls.length > 0) {
      dispute.counterEvidenceUrls = dto.counterEvidenceUrls;
    }
    dispute.status = DisputeStatus.AWAITING_REVIEW;

    return this.disputesRepository.save(dispute);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. ADMIN QUEUE: Dynamic routing and triage
  // ─────────────────────────────────────────────────────────────────────
  async getQueue(status?: DisputeStatus, department?: string) {
    const qb = this.disputesRepository.createQueryBuilder('dispute');

    if (status) {
      qb.andWhere('dispute.status = :status', { status });
    }
    if (department) {
      qb.andWhere('dispute.adminDepartment = :department', { department });
    }

    return qb.orderBy('dispute.createdAt', 'ASC').getMany();
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. ADMIN ASSIGNMENT / DEPARTMENT TRANSFER
  // ─────────────────────────────────────────────────────────────────────
  async assign(disputeId: string, dto: AssignDisputeDto) {
    // Row lock + status guard in one transaction: a verdict that commits first can never be
    // reopened by a racing assignment.
    return this.dataSource.transaction(async (manager) => {
      const dispute = await manager.findOne(Dispute, {
        where: { id: disputeId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!dispute) {
        throw new NotFoundException('Dispute ticket not found');
      }

      if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.DISMISSED) {
        throw new BadRequestException(
          `Cannot reassign a dispute that is already ${dispute.status}`,
        );
      }

      dispute.assignedAdminId = dto.adminId;
      if (dto.department) {
        dispute.adminDepartment = dto.department;
      }
      dispute.status = DisputeStatus.UNDER_INVESTIGATION;

      return manager.save(Dispute, dispute);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. VIEW SINGLE DISPUTE: Enforces access control
  // ─────────────────────────────────────────────────────────────────────
  async findOne(disputeId: string, userId: string, role: string) {
    const dispute = await this.disputesRepository.findOneBy({ id: disputeId });
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    const isAdmin = role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
    if (!isAdmin && dispute.initiatorId !== userId && dispute.defendantId !== userId) {
      throw new ForbiddenException('Access denied to this dispute dossier');
    }

    const [escrow, job, initiator, defendant] = await Promise.all([
      this.escrowRepository.findOneBy({ id: dispute.escrowId }),
      this.jobsRepository.findOneBy({ id: dispute.jobId }),
      this.usersRepository.findOne({
        where: { id: dispute.initiatorId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phoneNumber: true,
          role: true,
          isCertifiedByTark: true,
        },
      }),
      this.usersRepository.findOne({
        where: { id: dispute.defendantId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phoneNumber: true,
          role: true,
          isCertifiedByTark: true,
        },
      }),
    ]);

    return {
      dispute,
      escrow,
      job,
      initiator,
      defendant,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. RESOLVE DISPUTE: Authoritative binding verdict
  // - Client refunds are credited instantly into their in-app wallet.
  // - Artisan payouts are two-phase: PAYOUT_PENDING + reference commit with the verdict, the provider
  //   transfer is dispatched after commit, and RELEASED is only recorded once the provider confirms.
  // - Platform service fee is non-refundable.
  // - All database updates execute inside an atomic transaction.
  // ─────────────────────────────────────────────────────────────────────
  async resolve(disputeId: string, dto: ResolveDisputeDto, adminId: string) {
    const dispute = await this.disputesRepository.findOneBy({ id: disputeId });
    if (!dispute) {
      throw new NotFoundException('Dispute ticket not found');
    }

    if (dispute.status === DisputeStatus.RESOLVED) {
      throw new BadRequestException('This dispute has already been resolved and closed');
    }

    const escrow = await this.escrowRepository.findOneBy({ id: dispute.escrowId });
    if (!escrow) {
      throw new NotFoundException('Associated escrow not found');
    }

    if (escrow.totalStatus !== EscrowStatus.DISPUTED) {
      throw new BadRequestException(
        `Cannot resolve a dispute on an escrow that is not in DISPUTED status (Current status: ${escrow.totalStatus})`,
      );
    }

    const client = await this.usersRepository.findOneBy({ id: escrow.clientId });
    const artisan = escrow.artisanId
      ? await this.usersRepository.findOneBy({ id: escrow.artisanId })
      : null;
    const job = await this.jobsRepository.findOneBy({ id: dispute.jobId });

    if (!client) {
      throw new NotFoundException('Client associated with escrow not found');
    }

    // Execute financial execution and database mutations in an atomic transaction
    const result = await this.dataSource.transaction(async (manager) => {
      // Lock escrow row to prevent double-settlement and concurrent modifications
      const lockedEscrow = await manager
        .getRepository(EscrowTransaction)
        .createQueryBuilder('escrow')
        .setLock('pessimistic_write')
        .where('escrow.id = :id', { id: escrow.id })
        .getOne();

      if (!lockedEscrow || lockedEscrow.totalStatus !== EscrowStatus.DISPUTED) {
        throw new BadRequestException('Escrow is no longer in DISPUTED status');
      }

      // A tranche whose payout is still awaiting provider confirmation is NOT yet known to be paid or
      // unpaid. Resolving now could refund money the artisan is about to receive (or the reverse).
      if (
        lockedEscrow.tranche1Status === TrancheStatus.PAYOUT_PENDING ||
        lockedEscrow.tranche2Status === TrancheStatus.PAYOUT_PENDING
      ) {
        throw new BadRequestException(
          'A payout on this escrow is still awaiting provider confirmation. Resolve the dispute once it has settled.',
        );
      }

      // All money maths below is in integer kobo (no floating-point drift), calculated under lock
      const toKobo = (n: number | string) => Math.round(Number(n) * 100);

      // Remaining locked funds available in escrow
      let lockedMinor = 0;
      if (lockedEscrow.tranche1Status !== TrancheStatus.RELEASED) {
        lockedMinor += toKobo(lockedEscrow.tranche1Amount);
      }
      if (lockedEscrow.tranche2Status !== TrancheStatus.RELEASED) {
        lockedMinor += toKobo(lockedEscrow.tranche2Amount);
      }

      // ADR 002: the platform fee is non-refundable under every verdict, so only the
      // remainder after the fee can be distributed to the parties.
      const feeMinor = Math.min(toKobo(lockedEscrow.platformFeeAmount || 0), lockedMinor);
      const distributableMinor = lockedMinor - feeMinor;

      let clientRefundMinor = 0;
      let artisanPayoutMinor = 0;

      switch (dto.verdict) {
        case DisputeVerdict.FULL_REFUND_TO_CLIENT:
          clientRefundMinor = distributableMinor;
          break;

        case DisputeVerdict.FULL_PAYOUT_TO_ARTISAN:
          artisanPayoutMinor = distributableMinor;
          break;

        case DisputeVerdict.SPLIT_SETTLEMENT: {
          const reqClientMinor = toKobo(dto.clientRefundAmount || 0);
          const reqArtisanMinor = toKobo(dto.artisanPayoutAmount || 0);

          if (reqClientMinor + reqArtisanMinor !== distributableMinor) {
            throw new BadRequestException(
              `Split amounts (Client: ₦${reqClientMinor / 100} + Artisan: ₦${reqArtisanMinor / 100} = ₦${(reqClientMinor + reqArtisanMinor) / 100}) ` +
                `must equal the distributable escrow balance of ₦${distributableMinor / 100} ` +
                `(locked ₦${lockedMinor / 100} minus the non-refundable platform fee of ₦${feeMinor / 100})`,
            );
          }
          clientRefundMinor = reqClientMinor;
          artisanPayoutMinor = reqArtisanMinor;
          break;
        }

        case DisputeVerdict.MUTUAL_CANCELLATION:
          clientRefundMinor = distributableMinor;
          break;

        default:
          throw new BadRequestException('Invalid dispute resolution verdict');
      }

      if (artisanPayoutMinor > 0 && !artisan) {
        throw new BadRequestException('Cannot pay out: no artisan is assigned to this escrow');
      }

      if (artisanPayoutMinor > 0 && artisan && !artisan.payoutRecipientCode) {
        throw new BadRequestException(
          `Cannot execute verdict: Artisan has no registered payout recipient code. ` +
          `Please have them provide bank details before releasing funds.`,
        );
      }

      if (clientRefundMinor > 0 && escrow.currency !== 'NGN') {
        throw new BadRequestException(
          `Cannot credit wallet in ${escrow.currency}. In-app wallet refunds are supported in NGN only.`,
        );
      }

      const clientRefund = clientRefundMinor / 100;
      const artisanPayout = artisanPayoutMinor / 100;
      const feeRetained = feeMinor / 100;

      // 1. Credit Client In-App Wallet with pessimistic row lock
      if (clientRefund > 0) {
        const lockedClient = await manager
          .getRepository(User)
          .createQueryBuilder('user')
          .setLock('pessimistic_write')
          .where('user.id = :id', { id: client.id })
          .getOne();

        if (!lockedClient) {
          throw new NotFoundException('Client record not found during wallet settlement');
        }

        lockedClient.walletBalance =
          (Math.round(Number(lockedClient.walletBalance || 0) * 100) + clientRefundMinor) / 100;
        await manager.save(User, lockedClient);

        // Audit trail; the UNIQUE reference also makes a second credit for this dispute impossible
        await manager.save(
          WalletLedger,
          manager.create(WalletLedger, {
            reference: `dispute-refund-${dispute.id}`,
            userId: client.id,
            amount: clientRefund,
            type: WalletLedgerType.CREDIT,
            description: `Dispute refund for Job #${escrow.jobId.slice(0, 8)}`,
          }),
        );
        this.logger.log(`Dispute Refund: ₦${clientRefund} credited to Client (${client.id}) wallet`);
      }

      // 2. Update Escrow status (Preserve already RELEASED tranches so previously paid funds aren't falsely labelled REFUNDED)
      lockedEscrow.totalStatus = EscrowStatus.SETTLED;
      lockedEscrow.feeCollectedMinor = feeMinor;
      if (clientRefund > 0 && artisanPayout === 0) {
        if (lockedEscrow.tranche1Status !== TrancheStatus.RELEASED) {
          lockedEscrow.tranche1Status = TrancheStatus.REFUNDED;
        }
        if (lockedEscrow.tranche2Status !== TrancheStatus.RELEASED) {
          lockedEscrow.tranche2Status = TrancheStatus.REFUNDED;
        }
      } else {
        lockedEscrow.tranche1Status = TrancheStatus.RELEASED;
        lockedEscrow.tranche2Status = TrancheStatus.RELEASED;
      }
      await manager.save(EscrowTransaction, lockedEscrow);

      // 3. Update Job status
      const finalJobStatus =
        dto.verdict === DisputeVerdict.FULL_PAYOUT_TO_ARTISAN
          ? JobStatus.COMPLETED
          : JobStatus.CANCELLED;
      await manager.update(Job, escrow.jobId, { status: finalJobStatus });

      // 4. Update Dispute Record
      dispute.verdict = dto.verdict;
      dispute.clientRefundAmount = clientRefund;
      dispute.artisanPayoutAmount = artisanPayout;
      dispute.resolutionNotes = dto.resolutionNotes;
      dispute.resolvedAt = new Date();
      dispute.status = DisputeStatus.RESOLVED;
      dispute.assignedAdminId = adminId;

      // Phase 1 of the artisan payout: commit PAYOUT_PENDING + the deterministic reference with the
      // verdict, BEFORE the provider is contacted. A crash or timeout after this point leaves a
      // pending record that a webhook or the reconciliation sweep can resolve.
      let payoutDispatch: DisputePayoutDispatch | null = null;
      if (artisanPayoutMinor > 0 && artisan?.payoutRecipientCode) {
        const reference = `tark-dispute-${dispute.id}`;
        dispute.payoutStatus = DisputePayoutStatus.PAYOUT_PENDING;
        dispute.payoutReference = reference;
        dispute.payoutDispatchedAt = null;
        payoutDispatch = {
          disputeId: dispute.id,
          escrowId: lockedEscrow.id,
          amountMinor: artisanPayoutMinor,
          recipientCode: artisan.payoutRecipientCode,
          reference,
          reason: `Tark Dispute Settlement: Job #${escrow.jobId.slice(0, 8)}`,
          currency: escrow.currency,
        };
      } else {
        dispute.payoutStatus = DisputePayoutStatus.NOT_REQUIRED;
      }

      const savedDispute = await manager.save(Dispute, dispute);

      return {
        savedDispute,
        payoutDispatch,
        artisanPayout,
        clientRefund,
        feeRetained,
        disputeId: dispute.id,
      };
    });

    // ─────────────────────────────────────────────────────────────────
    // Phase 2: provider call AFTER the verdict transaction has committed.
    // The result only ever moves the payout to RELEASED on provider confirmation. Ambiguous outcomes
    // (timeout, 5xx, 'pending', 'otp') stay PAYOUT_PENDING for the webhook / reconciliation sweep.
    // ─────────────────────────────────────────────────────────────────
    let payoutStatus = result.payoutDispatch
      ? DisputePayoutStatus.PAYOUT_PENDING
      : DisputePayoutStatus.NOT_REQUIRED;
    if (result.payoutDispatch) {
      try {
        payoutStatus = await this.escrowService.dispatchDisputePayout(result.payoutDispatch);
      } catch (err: any) {
        this.logger.error(
          `Dispute #${result.disputeId} payout dispatch threw (${result.payoutDispatch.reference}): ${err.message}. ` +
            'Verdict is committed and the payout stays PAYOUT_PENDING for reconciliation.',
          err.stack,
        );
      }
    }

    const finalDispute =
      (await this.disputesRepository.findOneBy({ id: result.disputeId })) ?? result.savedDispute;

    // Notify both parties of official verdict
    Promise.all([
      this.usersRepository.findOne({ where: { id: client.id } }),
      artisan ? this.usersRepository.findOne({ where: { id: artisan.id } }) : null,
    ])
      .then(([cUser, aUser]) => {
        if (cUser) {
          this.notificationsService
            .notifyDisputeUpdate({
              userId: cUser.id,
              userName: cUser.fullName,
              jobTitle: job?.title || 'Service Job',
              disputeReason: dispute.claimStatement,
              status: `RESOLVED: ${dto.verdict}`,
              resolutionNotes: dto.resolutionNotes,
              disputeId: dispute.id,
            })
            .catch(() => {});
        }
        if (aUser) {
          this.notificationsService
            .notifyDisputeUpdate({
              userId: aUser.id,
              userName: aUser.fullName,
              jobTitle: job?.title || 'Service Job',
              disputeReason: dispute.claimStatement,
              status: `RESOLVED: ${dto.verdict}`,
              resolutionNotes: dto.resolutionNotes,
              disputeId: dispute.id,
            })
            .catch(() => {});
        }
      })
      .catch((err) => this.logger.error(`Dispute verdict notice error: ${err.message}`));

    let payoutNote = '';
    if (payoutStatus === DisputePayoutStatus.PAYOUT_PENDING) {
      payoutNote = ' The artisan payout is awaiting provider confirmation.';
    } else if (payoutStatus === DisputePayoutStatus.PAYOUT_FAILED) {
      payoutNote = ' The artisan payout failed at the provider; use PATCH /disputes/:id/retry-payout.';
    }

    return {
      message: `Dispute resolved successfully with verdict: ${dto.verdict}.${payoutNote}`,
      dispute: finalDispute,
      disbursement: {
        clientRefundedToWallet: result.clientRefund,
        artisanPayoutAmount: result.artisanPayout,
        artisanPayoutStatus: payoutStatus,
        // Only money the provider has confirmed counts as disbursed.
        artisanDisbursedToBank:
          payoutStatus === DisputePayoutStatus.RELEASED ? result.artisanPayout : 0,
        platformServiceFeeRetained: result.feeRetained > 0,
        platformFeeRetainedAmount: result.feeRetained,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. RETRY ARTISAN PAYOUT: admin re-dispatches a dispute payout that conclusively FAILED.
  // Uses a fresh provider reference and refuses to run while the old transfer might still be live.
  // ─────────────────────────────────────────────────────────────────────
  async retryPayout(disputeId: string) {
    return this.escrowService.retryDisputePayout(disputeId);
  }
}
