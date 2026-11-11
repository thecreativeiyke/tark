import { toMinorUnits, isTranche1Compliant, tranche1PolicyMessage } from './escrow-policy';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  HttpException,
  Logger,
  Inject,
  forwardRef,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, LessThan } from 'typeorm';
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
import { TransferDispatchError } from '../payments/interfaces/payment-gateway.interface';

// Maximum failed PIN attempts before the handshake is reset
const MAX_PIN_ATTEMPTS = 5;
const PIN_TTL_MS = 15 * 60 * 1000;

// Proof-of-work photos must come from Tark's own storage, in this folder.
// (Matches the folder used by MediaService.uploadFile for proof of work.)
const PROOF_PATH_SEGMENT = '/escrow/proof-of-work/';

// A payout is one provider transfer: tranche 1 on its own, or the final settlement
// (any unpaid tranche 1 plus tranche 2, minus the platform fee).
type PayoutKind = 'T1' | 'FINAL';

// Everything needed to call the provider, captured while the escrow row was locked.
interface PayoutDispatch {
  kind: PayoutKind;
  escrowId: string;
  amountMinor: number;
  recipientCode: string;
  reference: string;
  reason: string;
  currency: string;
}

export interface ReconcileSummary {
  checked: number;
  settled: number;
  failed: number;
  stillPending: number;
  reverted: number;
  errors: number;
}

@Injectable()
export class EscrowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EscrowService.name);
  private reconcileTimer?: NodeJS.Timeout;
  private reconciling = false;

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

  // Pending payouts are resolved by webhook, but webhooks can be lost. This sweep asks the
  // provider about anything still pending. It runs on a timer in production (every 5 minutes
  // unless PAYOUT_RECONCILE_INTERVAL_SECONDS says otherwise) and on demand via the admin route.
  onModuleInit() {
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';
    const raw = this.configService.get<string>('PAYOUT_RECONCILE_INTERVAL_SECONDS');
    const seconds = raw !== undefined && raw !== '' ? Number(raw) : isProd ? 300 : 0;
    if (!Number.isFinite(seconds) || seconds <= 0) return;

    this.reconcileTimer = setInterval(() => {
      this.reconcilePendingPayouts().catch((err) =>
        this.logger.error(`Payout reconciliation sweep failed: ${err?.message}`),
      );
    }, seconds * 1000);
    this.reconcileTimer.unref?.();
    this.logger.log(`Payout reconciliation sweep scheduled every ${seconds}s`);
  }

  onModuleDestroy() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

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

  // ─────────────────────────────────────────────────────────────────────
  // PAYOUT STATE MACHINE (true two-phase)
  //
  //   Phase 1  beginPayout    short transaction under the escrow row lock: validate, mark the
  //                           tranche(s) PAYOUT_PENDING, store the transfer reference. COMMITS.
  //   Phase 2  dispatchPayout the provider call, OUTSIDE any transaction and any row lock.
  //   Phase 3  applyTransferOutcome  second transaction: record what the provider said.
  //
  // A tranche is only RELEASED when the provider confirms 'success' (in the response, a webhook,
  // or the reconciliation sweep). 'pending' / 'otp' / 'received' are NOT paid yet.
  // The state committed in phase 1 survives a timeout or crash, so a late webhook or the sweep can
  // always find the escrow by its transfer reference.
  // ─────────────────────────────────────────────────────────────────────

  // Provider references are single-use. After a conclusive failure the next attempt needs a new
  // one: tark-t1-<id>, tark-t1-<id>-r1, tark-t1-<id>-r2, ...
  private nextTransferRef(base: string, existing: string | null): string {
    if (!existing) return base;
    const match = existing.match(/-r(\d+)$/);
    return `${base}-r${match ? Number(match[1]) + 1 : 1}`;
  }

  private classifyTransferStatus(
    status: string | undefined,
    simulated?: boolean,
  ): 'SUCCESS' | 'FAILED' | 'PENDING' {
    if (simulated) return 'SUCCESS'; // sandbox mode only; never produced in production
    switch (String(status ?? '').toLowerCase()) {
      case 'success':
        return 'SUCCESS';
      case 'failed':
      case 'reversed':
      case 'rejected':
      case 'blocked':
      case 'abandoned':
        return 'FAILED';
      default:
        // pending, received, otp, queued, processing, or anything unrecognised: NOT paid yet.
        return 'PENDING';
    }
  }

  private classifyDispatchError(err: any): 'REJECTED' | 'UNKNOWN' {
    if (err instanceof TransferDispatchError) return err.outcome;
    // Refused before any request left the building (unsupported currency, missing config).
    if (err instanceof HttpException) return 'REJECTED';
    return 'UNKNOWN';
  }

  // Phase 1. Must be called inside a transaction that already holds the escrow row lock; the
  // caller's transaction commits the PAYOUT_PENDING state before the provider is contacted.
  private async beginPayout(
    manager: EntityManager,
    escrow: EscrowTransaction,
    kind: PayoutKind,
    label: string,
  ): Promise<PayoutDispatch> {
    const recipientCode = await this.requirePayoutRecipient(manager, escrow);

    if (
      escrow.tranche1Status === TrancheStatus.PAYOUT_PENDING ||
      escrow.tranche2Status === TrancheStatus.PAYOUT_PENDING
    ) {
      throw new BadRequestException(
        'A payout is already being processed for this escrow. Please wait for it to confirm.',
      );
    }

    let amountMinor: number;
    let reference: string;

    if (kind === 'T1') {
      amountMinor = this.toMinor(escrow.tranche1Amount);
      reference = this.nextTransferRef(`tark-t1-${escrow.id}`, escrow.tranche1TransferRef);
      escrow.tranche1Status = TrancheStatus.PAYOUT_PENDING;
      escrow.tranche1TransferRef = reference;
    } else {
      const t2 = escrow.tranche2Status;
      if (t2 !== TrancheStatus.LOCKED && t2 !== TrancheStatus.PAYOUT_FAILED) {
        throw new BadRequestException('The final payout cannot be started from the current escrow state');
      }
      const t1UnpaidMinor =
        escrow.tranche1Status !== TrancheStatus.RELEASED ? this.toMinor(escrow.tranche1Amount) : 0;
      const feeMinor = this.toMinor(escrow.platformFeeAmount || 0);
      const grossFinalMinor = t1UnpaidMinor + this.toMinor(escrow.tranche2Amount);
      amountMinor = Math.max(0, grossFinalMinor - feeMinor);
      if (amountMinor <= 0) {
        throw new BadRequestException('There is nothing left to pay out on this escrow after platform fee');
      }

      reference = this.nextTransferRef(`tark-final-${escrow.id}`, escrow.tranche2TransferRef);
      if (escrow.tranche1Status !== TrancheStatus.RELEASED) {
        escrow.tranche1Status = TrancheStatus.PAYOUT_PENDING;
      }
      escrow.tranche2Status = TrancheStatus.PAYOUT_PENDING;
      escrow.tranche2TransferRef = reference;
      escrow.feeCollectedMinor = Math.min(feeMinor, grossFinalMinor);
      // The PIN is single-use: it is consumed the moment the payout begins.
      escrow.handshakePin = null;
      escrow.handshakeExpiresAt = null;
      escrow.handshakePinAttempts = 0;
    }

    await manager.save(EscrowTransaction, escrow);

    return {
      kind,
      escrowId: escrow.id,
      amountMinor,
      recipientCode,
      reference,
      reason: `Tark Payout: ${label} for Job #${escrow.jobId.slice(0, 8)}`,
      currency: escrow.currency,
    };
  }

  // Phase 2. No transaction and no lock are held while the provider is contacted.
  private async dispatchPayout(d: PayoutDispatch): Promise<EscrowTransaction> {
    let transfer: { status: string; simulated?: boolean };
    try {
      transfer = await this.paymentsService.initiateTransfer(
        d.amountMinor,
        d.recipientCode,
        d.reason,
        d.currency,
        d.reference,
      );
    } catch (err: any) {
      const outcome = this.classifyDispatchError(err);
      this.logger.error(
        `Escrow #${d.escrowId}: transfer ${d.reference} dispatch error (${outcome}): ${err?.message}`,
      );

      if (outcome === 'REJECTED') {
        // The provider says no transfer was created. Confirm it before undoing anything.
        const known = await this.paymentsService
          .verifyTransfer(d.reference, d.currency)
          .catch(() => null);
        if (known?.found) {
          return this.settleFromProviderStatus(d, known.status);
        }
        await this.revertPayout(d.escrowId, d.reference);
        throw new BadRequestException(
          'The payout could not be started. No money was sent and your funds are safe. ' +
            'Please try again shortly or contact support.',
        );
      }

      // UNKNOWN (timeout / 5xx / network): a transfer MAY exist. Do NOT retry and do NOT roll back.
      // The escrow stays PAYOUT_PENDING and a webhook or the reconciliation sweep resolves it.
      return this.findOne(d.escrowId);
    }

    return this.settleFromProviderStatus(d, transfer.status, transfer.simulated);
  }

  private async settleFromProviderStatus(
    d: PayoutDispatch,
    status: string | undefined,
    simulated?: boolean,
  ): Promise<EscrowTransaction> {
    const verdict = this.classifyTransferStatus(status, simulated);

    if (verdict === 'SUCCESS') {
      if (simulated) {
        this.logger.warn(
          `Escrow #${d.escrowId}: payout ${d.reference} was SIMULATED (sandbox mode). No real money moved.`,
        );
      }
      await this.applyTransferOutcome(d.reference, 'SUCCESS', 'dispatch-response');
      return this.findOne(d.escrowId);
    }

    if (verdict === 'FAILED') {
      await this.applyTransferOutcome(d.reference, 'FAILED', 'dispatch-response');
      throw new BadRequestException(
        'The payment provider declined this payout. No money was sent. You can try again.',
      );
    }

    if (String(status ?? '').toLowerCase() === 'otp') {
      this.logger.error(
        `Escrow #${d.escrowId}: transfer ${d.reference} is waiting for OTP approval at Paystack and will NOT be sent ` +
          'until approved. Disable transfer OTP in the Paystack dashboard (Settings > Preferences) for automated payouts. ' +
          'It stays PAYOUT_PENDING and will resolve to failed if it is abandoned.',
      );
    }
    return this.findOne(d.escrowId);
  }

  // Undo a payout that the provider definitively never created.
  // The transfer reference is kept so the next attempt gets a fresh one.
  private async revertPayout(escrowId: string, reference: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const escrow = await this.lockEscrow(manager, escrowId);

      if (
        escrow.tranche2TransferRef === reference &&
        escrow.tranche2Status === TrancheStatus.PAYOUT_PENDING
      ) {
        escrow.tranche2Status = TrancheStatus.LOCKED;
        if (escrow.tranche1Status === TrancheStatus.PAYOUT_PENDING) {
          escrow.tranche1Status = TrancheStatus.LOCKED;
        }
        escrow.feeCollectedMinor = 0;
        // PIN was consumed when the payout began; the artisan starts a new handshake.
        this.resetHandshake(escrow);
      } else if (
        escrow.tranche1TransferRef === reference &&
        escrow.tranche1Status === TrancheStatus.PAYOUT_PENDING
      ) {
        escrow.tranche1Status = TrancheStatus.LOCKED;
      } else {
        return;
      }
      await manager.save(EscrowTransaction, escrow);
    });
  }

  // Phase 3. The single place where a provider outcome becomes escrow state. Used by the dispatch
  // response, the Paystack webhook and the reconciliation sweep, so all three behave identically.
  // Idempotent: replays and out-of-order events change nothing.
  async applyTransferOutcome(
    reference: string,
    outcome: 'SUCCESS' | 'FAILED',
    source: string,
  ): Promise<{ matched: boolean; applied: boolean; message: string }> {
    const result = await this.dataSource.transaction(async (manager) => {
      const escrow = await manager.findOne(EscrowTransaction, {
        where: [{ tranche1TransferRef: reference }, { tranche2TransferRef: reference }],
        lock: { mode: 'pessimistic_write' },
      });

      if (!escrow) {
        return { matched: false, applied: false, message: 'No matching escrow for transfer reference', kind: null as PayoutKind | null, escrow: null as EscrowTransaction | null };
      }

      const kind: PayoutKind = escrow.tranche2TransferRef === reference ? 'FINAL' : 'T1';

      if (outcome === 'SUCCESS') {
        if (kind === 'T1') {
          if (escrow.tranche1Status === TrancheStatus.RELEASED) {
            return { matched: true, applied: false, message: 'Transfer already confirmed (idempotent)', kind, escrow };
          }
          if (escrow.tranche1Status !== TrancheStatus.PAYOUT_PENDING) {
            this.logger.warn(
              `Escrow #${escrow.id}: provider confirmed ${reference} (${source}) while tranche 1 was ${escrow.tranche1Status}. Money moved, so recording it.`,
            );
          }
          escrow.tranche1Status = TrancheStatus.RELEASED;
          if (escrow.totalStatus === EscrowStatus.FUNDS_LOCKED) {
            escrow.totalStatus = EscrowStatus.TRANCHE_1_RELEASED;
          }
        } else {
          if (
            escrow.tranche2Status === TrancheStatus.RELEASED &&
            escrow.totalStatus === EscrowStatus.SETTLED
          ) {
            return { matched: true, applied: false, message: 'Transfer already confirmed (idempotent)', kind, escrow };
          }
          if (escrow.tranche2Status !== TrancheStatus.PAYOUT_PENDING) {
            this.logger.warn(
              `Escrow #${escrow.id}: provider confirmed ${reference} (${source}) while tranche 2 was ${escrow.tranche2Status}. Money moved, so recording it.`,
            );
          }
          escrow.tranche1Status = TrancheStatus.RELEASED;
          escrow.tranche2Status = TrancheStatus.RELEASED;
          escrow.totalStatus = EscrowStatus.SETTLED;
          escrow.handshakePin = null;
          escrow.handshakeExpiresAt = null;
          await manager.update(Job, escrow.jobId, { status: JobStatus.COMPLETED });
        }
        const saved = await manager.save(EscrowTransaction, escrow);
        return { matched: true, applied: true, message: `Transfer ${reference} confirmed and escrow updated`, kind, escrow: saved };
      }

      // outcome === 'FAILED'
      if (kind === 'T1') {
        if (escrow.tranche1Status !== TrancheStatus.PAYOUT_PENDING) {
          this.logger.error(
            `Escrow #${escrow.id}: provider reported ${reference} failed/reversed (${source}) but tranche 1 is ${escrow.tranche1Status}. ` +
              'No state change. If money was actually returned to the Paystack balance, an operator must review.',
          );
          return { matched: true, applied: false, message: 'Ignored: tranche is not awaiting a payout result', kind, escrow };
        }
        escrow.tranche1Status = TrancheStatus.PAYOUT_FAILED;
      } else {
        if (escrow.tranche2Status !== TrancheStatus.PAYOUT_PENDING) {
          this.logger.error(
            `Escrow #${escrow.id}: provider reported ${reference} failed/reversed (${source}) but tranche 2 is ${escrow.tranche2Status}. ` +
              'No state change. If money was actually returned to the Paystack balance, an operator must review.',
          );
          return { matched: true, applied: false, message: 'Ignored: tranche is not awaiting a payout result', kind, escrow };
        }
        escrow.tranche2Status = TrancheStatus.PAYOUT_FAILED;
        if (escrow.tranche1Status === TrancheStatus.PAYOUT_PENDING) {
          escrow.tranche1Status = TrancheStatus.LOCKED;
        }
        escrow.feeCollectedMinor = 0;
        // Back to a clean state: the artisan can start a new handshake and the payout is retried
        // with a fresh provider reference.
        this.resetHandshake(escrow);
      }
      const saved = await manager.save(EscrowTransaction, escrow);
      return { matched: true, applied: true, message: `Transfer ${reference} marked as PAYOUT_FAILED`, kind, escrow: saved };
    });

    if (result.applied && outcome === 'SUCCESS' && result.kind && result.escrow) {
      this.notifyPayoutConfirmed(result.escrow, result.kind);
    }
    return { matched: result.matched, applied: result.applied, message: result.message };
  }

  // Asks the provider about every payout still PAYOUT_PENDING and applies the answer.
  // `notFoundGraceSeconds`: how long a transfer the provider has never heard of is left alone
  // before the payout is rolled back to a retryable state.
  async reconcilePendingPayouts(
    opts: { olderThanSeconds?: number; notFoundGraceSeconds?: number } = {},
  ): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { checked: 0, settled: 0, failed: 0, stillPending: 0, reverted: 0, errors: 0 };
    if (this.reconciling) return summary;
    this.reconciling = true;

    try {
      const olderThan = Math.max(0, opts.olderThanSeconds ?? 60);
      const grace = Math.max(0, opts.notFoundGraceSeconds ?? 900);
      const cutoff = new Date(Date.now() - olderThan * 1000);

      const rows = await this.escrowRepository.find({
        where: [
          { tranche1Status: TrancheStatus.PAYOUT_PENDING, updatedAt: LessThan(cutoff) },
          { tranche2Status: TrancheStatus.PAYOUT_PENDING, updatedAt: LessThan(cutoff) },
        ],
      });

      for (const row of rows) {
        summary.checked++;
        const reference =
          row.tranche2Status === TrancheStatus.PAYOUT_PENDING
            ? row.tranche2TransferRef
            : row.tranche1TransferRef;
        if (!reference) {
          this.logger.error(`Escrow #${row.id} is PAYOUT_PENDING but has no transfer reference. Needs an operator.`);
          summary.errors++;
          continue;
        }

        try {
          const verified = await this.paymentsService.verifyTransfer(reference, row.currency);

          if (!verified.found) {
            const ageSeconds = (Date.now() - new Date(row.updatedAt).getTime()) / 1000;
            if (ageSeconds >= grace) {
              this.logger.warn(`Escrow #${row.id}: provider has no record of ${reference} after ${Math.round(ageSeconds)}s. Rolling back to retryable.`);
              await this.revertPayout(row.id, reference);
              summary.reverted++;
            } else {
              summary.stillPending++;
            }
            continue;
          }

          const verdict = this.classifyTransferStatus(verified.status);
          if (verdict === 'SUCCESS') {
            await this.applyTransferOutcome(reference, 'SUCCESS', 'reconciliation');
            summary.settled++;
          } else if (verdict === 'FAILED') {
            await this.applyTransferOutcome(reference, 'FAILED', 'reconciliation');
            summary.failed++;
          } else {
            summary.stillPending++;
          }
        } catch (err: any) {
          this.logger.error(`Reconciliation of ${reference} failed: ${err?.message}`);
          summary.errors++;
        }
      }

      if (summary.checked > 0) {
        this.logger.log(`Payout reconciliation: ${JSON.stringify(summary)}`);
      }
      return summary;
    } finally {
      this.reconciling = false;
    }
  }

  // Sent once, when the provider has confirmed the money moved.
  private notifyPayoutConfirmed(escrow: EscrowTransaction, kind: PayoutKind) {
    if (!escrow.artisanId) return;
    const artisanId = escrow.artisanId;

    this.dataSource
      .getRepository(Job)
      .findOne({ where: { id: escrow.jobId } })
      .then(async (job) => {
        if (!job) return;
        const artisan = await this.dataSource.getRepository(User).findOne({ where: { id: artisanId } });

        if (kind === 'T1') {
          return this.notificationsService.notifyTranche1Released({
            artisanId,
            artisanName: artisan?.fullName || 'Artisan',
            jobTitle: job.title,
            amount: Number(escrow.tranche1Amount),
            jobId: job.id,
          });
        }

        const grossFinal = Number(escrow.tranche2Amount);
        const fee = Number(escrow.platformFeeAmount || 0);
        const netDisbursed = Math.max(0, grossFinal - fee);
        const totalJobBudget = Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount);
        return this.notificationsService.notifyPayoutSettled({
          artisanId,
          artisanName: artisan?.fullName || 'Artisan',
          jobTitle: job.title,
          disbursedAmount: netDisbursed,
          platformFeeAmount: fee,
          totalJobBudget,
          accountMasked: artisan?.payoutAccountIdentifier
            ? `***${artisan.payoutAccountIdentifier.slice(-4)}`
            : undefined,
          jobId: job.id,
        });
      })
      .catch((err) => this.logger.error(`Failed to dispatch payout alert: ${err.message}`));
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
  // Lock funds inside a caller-owned transaction (wallet funding). Takes the escrow row
  // lock, re-checks the status under it, and records which channel paid.
  async lockFundsInTransaction(
    manager: EntityManager,
    id: string,
    via: 'WALLET' | 'ONLINE' = 'ONLINE',
    fundingReference?: string,
  ): Promise<EscrowTransaction> {
    const escrow = await this.lockEscrow(manager, id);

    if (escrow.totalStatus !== EscrowStatus.INITIATED) {
      throw new BadRequestException('Funds can only be locked from INITIATED status');
    }

    escrow.totalStatus = EscrowStatus.FUNDS_LOCKED;
    escrow.tranche1Status = TrancheStatus.LOCKED;
    escrow.tranche2Status = TrancheStatus.LOCKED;
    escrow.fundedVia = via;
    escrow.fundedReference = fundingReference ?? null;

    await manager.update(Job, escrow.jobId, { status: JobStatus.IN_PROGRESS });
    return manager.save(EscrowTransaction, escrow);
  }

  async lockFunds(id: string, via: 'WALLET' | 'ONLINE' = 'ONLINE', fundingReference?: string) {
    const saved = await this.dataSource.transaction((manager) =>
      this.lockFundsInTransaction(manager, id, via, fundingReference),
    );
    this.notifyFunded(saved);
    return saved;
  }

  // Notify artisan that escrow is funded and ready. Call AFTER the funding transaction commits.
  notifyFunded(saved: EscrowTransaction) {
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
  }

  // ─────────────────────────────────────────────────────────────────────
  // RELEASE TRANCHE 1 — client kicks off work; artisan must have a payout
  // account. Only allowed while funds are locked (not disputed / mid-handshake).
  // A tranche whose last payout conclusively FAILED can be released again.
  // ─────────────────────────────────────────────────────────────────────
  async releaseTranche1(id: string, clientId: string) {
    const dispatch = await this.dataSource.transaction(async (manager) => {
      const escrow = await this.lockEscrow(manager, id);

      if (escrow.clientId !== clientId) {
        throw new ForbiddenException('Only the client can release Tranche 1');
      }

      if (escrow.tranche1Status === TrancheStatus.PAYOUT_PENDING) {
        throw new BadRequestException(
          'A Tranche 1 payout is already being processed. Please wait for it to confirm.',
        );
      }

      if (
        escrow.totalStatus !== EscrowStatus.FUNDS_LOCKED ||
        (escrow.tranche1Status !== TrancheStatus.LOCKED &&
          escrow.tranche1Status !== TrancheStatus.PAYOUT_FAILED)
      ) {
        throw new BadRequestException(
          'Tranche 1 can only be released while funds are locked, with no dispute or handshake in progress',
        );
      }

      return this.beginPayout(manager, escrow, 'T1', 'Tranche 1');
    });

    // Phase 2 + 3 run after the transaction above has committed PAYOUT_PENDING.
    return this.dispatchPayout(dispatch);
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

      if (
        escrow.tranche1Status === TrancheStatus.PAYOUT_PENDING ||
        escrow.tranche2Status === TrancheStatus.PAYOUT_PENDING
      ) {
        throw new BadRequestException(
          'A payout is still being processed for this escrow. Please wait for it to confirm.',
        );
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
  // A correct PIN commits PAYOUT_PENDING first; the provider is called afterwards.
  // ─────────────────────────────────────────────────────────────────────
  async verifyHandshake(id: string, artisanId: string, pin: string) {
    type Outcome = { rejectedMessage: string } | { dispatch: PayoutDispatch };

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

      // PIN is correct: commit PAYOUT_PENDING (consuming the PIN) before the provider is contacted.
      return { dispatch: await this.beginPayout(manager, escrow, 'FINAL', 'Final Settlement') };
    });

    if ('rejectedMessage' in outcome) {
      throw new BadRequestException(outcome.rejectedMessage);
    }

    return this.dispatchPayout(outcome.dispatch);
  }

  // ─────────────────────────────────────────────────────────────────────
  // SETTLE — client manually completes (not exposed as a route today).
  // Includes any unreleased tranche 1 in the payout.
  // ─────────────────────────────────────────────────────────────────────
  async settle(id: string, userId: string) {
    const dispatch = await this.dataSource.transaction(async (manager) => {
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

      return this.beginPayout(manager, escrow, 'FINAL', 'Manual Settlement');
    });

    return this.dispatchPayout(dispatch);
  }

  // NOTE: the old escrow-level dispute() was removed on purpose. Disputes are
  // opened through DisputesService (POST /disputes), which records the case,
  // the 48-hour response window and the admin queue entry. A bare status flip
  // here froze funds with no case for an admin to resolve.
}
