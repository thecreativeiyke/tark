import {
  Injectable,
  BadRequestException,
  BadGatewayException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import axios from 'axios';
import { EscrowService } from '../escrow/escrow.service';
import { EscrowStatus, EscrowTransaction } from '../escrow/entities/escrow-transaction.entity';
import { User } from '../users/entities/user.entity';
import { Job } from '../jobs/entities/job.entity';
import { WalletLedger, WalletLedgerType } from './entities/wallet-ledger.entity';
import { PaymentGatewayResolver } from './gateways/payment-gateway.resolver';

export interface BankFilterQuery {
  country?: string;
  currency?: string;
  type?: string;
  search?: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly paystackBaseUrl = 'https://api.paystack.co';

  constructor(
    private configService: ConfigService,
    private gatewayResolver: PaymentGatewayResolver,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Job)
    private jobsRepository: Repository<Job>,
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  private getSecretKey(): string {
    const key = this.configService.get<string>('PAYSTACK_SECRET_KEY');
    if (!key) {
      throw new InternalServerErrorException('PAYSTACK_SECRET_KEY not set');
    }
    return key;
  }

  private getHeaders() {
    return {
      Authorization: `Bearer ${this.getSecretKey()}`,
      'Content-Type': 'application/json',
    };
  }

  // Sandbox simulation is OFF by default and can never be enabled in production.
  private sandboxFallbackAllowed(): boolean {
    return (
      this.configService.get<string>('NODE_ENV') !== 'production' &&
      this.configService.get<string>('PAYMENTS_SANDBOX_FALLBACK') === 'true'
    );
  }

  // Real-time Third-Party Bank API Directory
  async getSupportedBanks(filters: BankFilterQuery = {}) {
    const { country = 'nigeria', currency = 'NGN', type = 'nuban', search } = filters;

    try {
      const response = await axios.get(
        `${this.paystackBaseUrl}/bank`,
        {
          headers: this.getHeaders(),
          params: {
            country: country.toLowerCase(),
            currency: currency.toUpperCase(),
            type,
            perPage: 100,
          },
        },
      );

      const digitalSlugs = [
        'opay',
        'palmpay',
        'kuda-bank',
        'moniepoint-microfinance-bank',
        'fairmoney',
        'carbon',
        'rubies-bank',
        'vfd-microfinance-bank',
        'sparkle-microfinance-bank',
      ];

      let banks = response.data.data.map((b: any) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        code: b.code,
        active: b.active,
        isDigital: digitalSlugs.some((slug) => b.slug.includes(slug)),
        category: digitalSlugs.some((slug) => b.slug.includes(slug))
          ? 'Digital / Fintech Bank'
          : 'Commercial Bank',
      }));

      if (search && search.trim().length > 0) {
        const query = search.trim().toLowerCase();
        banks = banks.filter(
          (b: any) =>
            b.name.toLowerCase().includes(query) ||
            b.slug.toLowerCase().includes(query) ||
            b.code.includes(query),
        );
      }

      return {
        total: banks.length,
        country: country.toLowerCase(),
        currency: currency.toUpperCase(),
        banks,
      };
    } catch (error: any) {
      this.logger.error('Failed to fetch real-time bank directory', error?.response?.data || error.message);
      throw new BadRequestException('Could not retrieve live banks list from provider');
    }
  }

  async initializePayment(escrowId: string, email: string, requesterId?: string) {
    const escrow = await this.escrowService.findOne(escrowId);

    // When called directly by a user, only the escrow's own client may start a payment.
    // (generatePayForMe has already verified ownership and passes no requesterId.)
    if (requesterId && escrow.clientId !== requesterId) {
      throw new ForbiddenException('Only the client who created this escrow can pay for it');
    }
    if (escrow.totalStatus !== EscrowStatus.INITIATED) {
      throw new BadRequestException(`Escrow is already in status: ${escrow.totalStatus}`);
    }
    const totalAmount = Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount);
    const amountMinor = Math.round(totalAmount * 100);
    const currency = escrow.currency || 'NGN';

    const gateway = this.gatewayResolver.resolveByCurrency(currency);
    const result = await gateway.initializePayment({
      escrowId: escrow.id,
      email,
      amountMinor,
      currency,
    });

    await this.escrowService.attachPaystackReference(escrow.id, result.reference);
    return {
      authorization_url: result.authorizationUrl,
      reference: result.reference,
      provider: gateway.providerName,
    };
  }

  async generatePayForMe(escrowId: string, clientId: string) {
    const escrow = await this.escrowService.findOne(escrowId);
    if (escrow.clientId !== clientId) {
      throw new BadRequestException('Only the client who initiated this escrow can generate a Pay For Me link');
    }

    const client = await this.usersRepository.findOneBy({ id: clientId });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const job = await this.jobsRepository.findOneBy({ id: escrow.jobId });
    if (!job) {
      throw new NotFoundException('Job associated with escrow not found');
    }

    let artisanName: string | null = null;
    if (escrow.artisanId) {
      const artisan = await this.usersRepository.findOneBy({ id: escrow.artisanId });
      artisanName = artisan ? artisan.fullName : null;
    }

    const totalAmount = Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount);
    const currency = escrow.currency || 'NGN';
    const formattedAmount = `${currency}${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    const paymentData = await this.initializePayment(escrow.id, client.email);
    const checkoutUrl = paymentData.authorization_url;

    const dva = client.virtualAccountNumber
      ? {
          bankName: client.virtualBankName || 'Paystack-Titan',
          accountNumber: client.virtualAccountNumber,
          accountName: `Tark - ${client.fullName}`,
        }
      : null;

    const messageLines = [
      `Payment Request from ${client.fullName} via Tark`,
      `--------------------------------------------------`,
      `Service: ${job.title}`,
      `Category: ${job.category}`,
      `Location: ${job.location}`,
      artisanName ? `Assigned Artisan: ${artisanName}` : null,
      `Total Budget: ${formattedAmount}`,
      `Breakdown: Tranche 1 (${currency}${Number(escrow.tranche1Amount).toLocaleString()}) | Tranche 2 (${currency}${Number(escrow.tranche2Amount).toLocaleString()})`,
      ``,
      `🛡️ Escrow Guarantee: Funds remain securely held in Tark Escrow and are only released in milestones as verified work is completed.`,
      ``,
      `💳 Option 1 - Pay Online (Card / USSD / Bank App):`,
      checkoutUrl,
    ];

    if (dva) {
      messageLines.push(
        ``,
        `🏦 Option 2 - Direct Bank Transfer (Instant Escrow Credit):`,
        `Bank: ${dva.bankName}`,
        `Account Number: ${dva.accountNumber}`,
        `Account Name: ${dva.accountName}`,
      );
    }

    messageLines.push(
      ``,
      `Thank you for helping fund this service!`,
    );

    const fullMessage = messageLines.filter((l) => l !== null).join('\n');
    const emailSubject = `Payment Request: ${job.title} (${formattedAmount}) for ${client.fullName}`;

    return {
      metadata: {
        escrowId: escrow.id,
        jobId: job.id,
        jobTitle: job.title,
        jobLocation: job.location,
        clientName: client.fullName,
        artisanName,
        currency,
        totalAmount,
        tranche1Amount: Number(escrow.tranche1Amount),
        tranche2Amount: Number(escrow.tranche2Amount),
      },
      paymentRails: {
        onlineCheckoutUrl: checkoutUrl,
        virtualAccount: dva,
      },
      shareChannels: {
        webShare: {
          title: `Fund Service on Tark: ${job.title}`,
          text: `Hi, please assist ${client.fullName} in funding "${job.title}" (${formattedAmount}) securely on Tark.`,
          url: checkoutUrl,
        },
        clipboardText: fullMessage,
        whatsappUrl: `https://wa.me/?text=${encodeURIComponent(fullMessage)}`,
        telegramUrl: `https://t.me/share/url?url=${encodeURIComponent(checkoutUrl)}&text=${encodeURIComponent(
          `Hi, please help fund "${job.title}" (${formattedAmount}) for${client.fullName} on Tark Escrow.`,
        )}`,
        smsUrl: `sms:?body=${encodeURIComponent(
          `Hi, please help fund "${job.title}" (${formattedAmount}) for ${client.fullName} on Tark:${checkoutUrl}`,
        )}`,
        email: {
          subject: emailSubject,
          body: fullMessage,
          mailtoUrl: `mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(fullMessage)}`,
        },
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // WALLET FUNDING — uses a row-level lock to prevent double-spend.
  // Two simultaneous requests cannot both pass the balance check.
  // ─────────────────────────────────────────────────────────────────────
  async fundEscrowWithWallet(escrowId: string, userId: string) {
    // Everything happens in ONE transaction: lock the escrow row first, re-check its
    // status under the lock, then debit the wallet, write the ledger row and lock the
    // escrow funds. Either all of it commits or none of it does, and two concurrent
    // requests (or a request racing the Paystack webhook) cannot both pay.
    // Lock order is always escrow -> user, matching the dispute resolver.
    const result = await this.dataSource.transaction(async (manager) => {
      const escrow = await manager.findOne(EscrowTransaction, {
        where: { id: escrowId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!escrow) {
        throw new NotFoundException('Escrow transaction not found');
      }
      if (escrow.clientId !== userId) {
        throw new BadRequestException('Only the client who created this escrow can fund it');
      }
      if (escrow.totalStatus !== EscrowStatus.INITIATED) {
        throw new BadRequestException(`Escrow is already in status: ${escrow.totalStatus}`);
      }
      if ((escrow.currency || 'NGN').toUpperCase() !== 'NGN') {
        throw new BadRequestException('Wallet funding supports NGN escrows only');
      }

      // Integer kobo arithmetic, no floating-point drift
      const totalMinor = Math.round((Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount)) * 100);
      const totalAmount = totalMinor / 100;

      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' }, // SELECT FOR UPDATE
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      const currentMinor = Math.round(Number(user.walletBalance || 0) * 100);
      if (currentMinor < totalMinor) {
        throw new BadRequestException(
          `Insufficient wallet balance. Required: NGN ${totalAmount.toFixed(2)}, Available: NGN ${(currentMinor / 100).toFixed(2)}`,
        );
      }

      user.walletBalance = (currentMinor - totalMinor) / 100;
      await manager.save(User, user);

      // Deterministic reference: the UNIQUE constraint on wallet_ledgers.reference is a
      // second line of defence against a double debit for the same escrow.
      const debitLedger = manager.create(WalletLedger, {
        reference: `wdebit-${escrow.id}`,
        userId: user.id,
        amount: totalAmount,
        type: WalletLedgerType.DEBIT,
        description: `Escrow funding for Job #${escrow.jobId.slice(0, 8)}`,
      });
      await manager.save(WalletLedger, debitLedger);

      const lockedEscrow = await this.escrowService.lockFundsInTransaction(manager, escrow.id, 'WALLET');

      return { totalAmount, remainingBalance: user.walletBalance, lockedEscrow };
    });

    // Notify only after the transaction has committed
    this.escrowService.notifyFunded(result.lockedEscrow);

    return {
      message: 'Escrow funded successfully from wallet',
      deductedAmount: result.totalAmount,
      remainingBalance: result.remainingBalance,
      escrow: result.lockedEscrow,
    };
  }

  async resolveBankAccount(accountNumber: string, bankCode: string, currency = 'NGN') {
    const gateway = this.gatewayResolver.resolveByCurrency(currency);
    if (!gateway.resolveAccount) {
      throw new BadRequestException(`Gateway ${gateway.providerName} does not support account resolution`);
    }
    return gateway.resolveAccount(accountNumber, bankCode);
  }

  async saveArtisanBank(
    userId: string,
    accountNumber: string,
    bankCode: string,
    currency = 'NGN',
  ) {
    const user = await this.usersRepository.findOneBy({ id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const gateway = this.gatewayResolver.resolveByCurrency(currency);

    let resolvedName = user.fullName;
    if (gateway.resolveAccount) {
      try {
        const resolved = await gateway.resolveAccount(accountNumber, bankCode);
        resolvedName = resolved.accountName;
      } catch (err: any) {
        if (!this.sandboxFallbackAllowed()) {
          throw new BadRequestException(
            'Could not verify this bank account. Check the account number and bank, then try again.',
          );
        }
        this.logger.warn(`Bank resolution bypassed in sandbox mode: ${err.message}`);
      }
    }

    let recipientCode: string;
    try {
      recipientCode = await gateway.createRecipient(resolvedName, accountNumber, bankCode, currency);
    } catch (err: any) {
      if (!this.sandboxFallbackAllowed()) {
        throw new BadRequestException(
          'Could not register this payout account with the payment provider. Please try again.',
        );
      }
      this.logger.warn(`Recipient creation simulated in sandbox mode: ${err.message}`);
      recipientCode = `RCP_${Date.now()}`;
    }

    user.payoutAccountIdentifier = accountNumber;
    user.payoutBankOrNetwork = bankCode;
    user.payoutRecipientCode = recipientCode;
    user.payoutProvider = gateway.providerName;

    const savedUser = await this.usersRepository.save(user);
    const { password: _, ...sanitized } = savedUser;

    return {
      message: 'Artisan payout details saved successfully',
      accountName: resolvedName,
      recipientCode,
      provider: gateway.providerName,
      user: sanitized,
    };
  }

  async assignDedicatedVirtualAccount(userId: string) {
    const user = await this.usersRepository.findOneBy({ id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.virtualAccountNumber) {
      return {
        accountNumber: user.virtualAccountNumber,
        bankName: user.virtualBankName,
        customerCode: user.paystackCustomerCode,
      };
    }

    let customerCode = user.paystackCustomerCode;
    if (!customerCode) {
      try {
        const [firstName, ...lastNameParts] = user.fullName.split(' ');
        const customerRes = await axios.post(
          `${this.paystackBaseUrl}/customer`,
          {
            email: user.email,
            first_name: firstName || 'Tark',
            last_name: lastNameParts.join(' ') || 'Customer',
            phone: user.phoneNumber || undefined,
          },
          { headers: this.getHeaders() },
        );
        customerCode = customerRes.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await this.usersRepository.save(user);
      } catch (err: any) {
        this.logger.error('Failed to create customer on provider', err?.response?.data || err.message);
        // Never persist a made-up customer code outside sandbox mode.
        if (!this.sandboxFallbackAllowed()) {
          throw new BadGatewayException(
            'Could not set up your funding account right now. Please try again shortly.',
          );
        }
        customerCode = `CUS_${Date.now()}`;
        user.paystackCustomerCode = customerCode;
        await this.usersRepository.save(user);
      }
    }

    try {
      const dvaRes = await axios.post(
        `${this.paystackBaseUrl}/dedicated_account`,
        {
          customer: customerCode,
          preferred_bank: 'wema-bank',
        },
        { headers: this.getHeaders() },
      );

      const dvaData = dvaRes.data.data;
      user.virtualAccountNumber = dvaData.account_number;
      user.virtualBankName = dvaData.bank.name;
      await this.usersRepository.save(user);
    } catch (error: any) {
      // A fake account number could receive REAL money from a real bank customer.
      // Only ever simulate one in non-production sandbox mode.
      if (!this.sandboxFallbackAllowed()) {
        this.logger.error(`DVA provisioning failed: ${error?.response?.data?.message || error.message}`);
        throw new BadGatewayException(
          'Could not create your dedicated funding account right now. Please try again shortly.',
        );
      }
      this.logger.warn(`DVA live provision unavailable. Activating Sandbox DVA.`);
      user.virtualAccountNumber = `96${Math.floor(10000000 + Math.random() * 90000000)}`;
      user.virtualBankName = 'Paystack-Titan (Sandbox)';
      await this.usersRepository.save(user);
    }

    return {
      accountNumber: user.virtualAccountNumber,
      bankName: user.virtualBankName,
      customerCode: user.paystackCustomerCode,
    };
  }

  async initiateTransfer(
    amountMinor: number,
    recipientCode: string,
    reason: string,
    currency = 'NGN',
    reference?: string,
  ) {
    const gateway = this.gatewayResolver.resolveByCurrency(currency);
    return gateway.initiateTransfer({
      amountMinor,
      currency,
      recipientCode,
      reason,
      reference,
    });
  }

  // Looks a transfer up at the provider by our reference. Used to resolve payouts left PAYOUT_PENDING.
  async verifyTransfer(reference: string, currency = 'NGN') {
    const gateway = this.gatewayResolver.resolveByCurrency(currency);
    if (!gateway.verifyTransfer) {
      throw new BadRequestException(`Gateway ${gateway.providerName} does not support transfer verification`);
    }
    return gateway.verifyTransfer(reference);
  }

  // An online payment arrived for an escrow that is already funded. If it is an identical
  // replay of the payment that funded the escrow, acknowledge it idempotently. If it is a different
  // reference (second online checkout or payment after wallet funding), credit the money to the client's wallet.
  private async handleAlreadyFundedEscrow(
    escrow: EscrowTransaction,
    reference: string,
    amountMinor: number,
    currency?: string,
  ) {
    // Identical replay of the payment that funded the escrow: acknowledge idempotently.
    // Compare against fundedReference (the reference that actually paid), NOT paystackReference,
    // which Pay-For-Me / re-initialisation overwrites with the latest checkout. Escrows funded
    // before fundedReference existed have it null, so they fall back to the old comparison.
    const fundingRef = escrow.fundedReference ?? escrow.paystackReference;
    if (escrow.fundedVia === 'ONLINE' && fundingRef === reference) {
      return { status: 'success', message: 'Escrow already funded (idempotent)' };
    }

    if ((currency || 'NGN').toUpperCase() === 'NGN') {
      const credited = await this.creditWalletOnce(
        escrow.clientId,
        `overpay-${reference}`,
        amountMinor,
        `Paystack payment ${reference} received after escrow was already funded (${escrow.fundedVia || 'previously'})`,
      );
      return {
        status: 'success',
        message: credited
          ? 'Escrow already funded; additional payment credited to client wallet'
          : 'Duplicate payment already credited (idempotent)',
      };
    }

    return { status: 'ignored', message: 'Escrow already funded in non-NGN currency' };
  }

  // Credits a user's wallet exactly once per ledgerRef (UNIQUE constraint + existence check).
  // Returns true when it credited, false when it had already been credited.
  private async creditWalletOnce(
    userId: string,
    ledgerRef: string,
    amountMinor: number,
    description: string,
  ): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const existing = await queryRunner.manager.findOne(WalletLedger, {
        where: { reference: ledgerRef },
      });
      if (existing) {
        await queryRunner.rollbackTransaction();
        return false;
      }

      const user = await queryRunner.manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) {
        await queryRunner.rollbackTransaction();
        this.logger.error(`Cannot credit ${ledgerRef}: user ${userId} not found`);
        return false;
      }

      const amountMajor = amountMinor / 100;
      await queryRunner.manager.save(
        WalletLedger,
        queryRunner.manager.create(WalletLedger, {
          reference: ledgerRef,
          userId: user.id,
          amount: amountMajor,
          type: WalletLedgerType.CREDIT,
          description,
        }),
      );
      user.walletBalance = (Math.round(Number(user.walletBalance || 0) * 100) + amountMinor) / 100;
      await queryRunner.manager.save(User, user);

      await queryRunner.commitTransaction();
      return true;
    } catch (err: any) {
      await queryRunner.rollbackTransaction();
      if (err.code === '23505') {
        return false;
      }
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, provider = 'paystack'): boolean {
    const gateway = this.gatewayResolver.resolveByProvider(provider);
    return gateway.verifyWebhook(rawBody, signature);
  }

  async handleWebhook(event: any) {
    if (event.event === 'charge.success') {
      const d = event.data ?? {};
      const reference = typeof d.reference === 'string' ? d.reference.trim() : '';
      if (!reference) {
        return { status: 'ignored', message: 'Missing transaction reference' };
      }

      const amountMinor = Number(d.amount);
      if (d.status !== 'success' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        return { status: 'ignored', message: 'Invalid charge payload' };
      }

      // 1. Escrow direct checkout path
      let escrow = await this.escrowService.findByReference(reference);
      if (!escrow) {
        // Fallback: extract escrowId from tark-<uuid>-timestamp reference pattern or metadata
        const match = reference.match(/^tark-([0-9a-fA-F-]{36})-/);
        const escrowIdFromRef = match ? match[1] : d.metadata?.escrowId;
        if (escrowIdFromRef) {
          try {
            escrow = await this.escrowService.findOne(escrowIdFromRef);
          } catch {
            // Escrow not found, proceed to wallet deposit path
          }
        }
      }

      if (escrow) {
        // Anything past INITIATED means the escrow is already funded (locked, tranche 1
        // released, handshake, disputed or settled). If it was funded from the wallet,
        // this online payment is a duplicate and must be credited back, not swallowed.
        if (escrow.totalStatus !== EscrowStatus.INITIATED) {
          return this.handleAlreadyFundedEscrow(escrow, reference, amountMinor, d.currency);
        }

        if (d.currency && escrow.currency && d.currency.toUpperCase() !== escrow.currency.toUpperCase()) {
          this.logger.error(
            `Escrow currency mismatch for ref ${reference}. Expected ${escrow.currency}, received ${d.currency}.`,
          );
          return { status: 'ignored', message: 'Currency mismatch' };
        }

        const expectedMinor = Math.round((Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount)) * 100);
        if (amountMinor !== expectedMinor) {
          this.logger.error(
            `Escrow funding amount mismatch for ref ${reference}. Expected ${expectedMinor} kobo, received ${amountMinor} kobo. Crediting client wallet.`,
          );
          // Real money arrived but cannot fund this escrow: put it in the client's wallet
          // (idempotent on the reference) instead of dropping it.
          if ((d.currency || 'NGN').toUpperCase() === 'NGN') {
            const credited = await this.creditWalletOnce(
              escrow.clientId,
              `unmatched-${reference}`,
              amountMinor,
              `Paystack payment ${reference} did not match the escrow total`,
            );
            return {
              status: 'success',
              message: credited
                ? 'Charge amount did not match escrow total; credited to client wallet'
                : 'Unmatched charge already credited (idempotent)',
            };
          }
          return { status: 'ignored', message: 'Charge amount does not match escrow total' };
        }

        try {
          await this.escrowService.lockFunds(escrow.id, 'ONLINE', reference);
        } catch (err: any) {
          // Lost a race (wallet funding or a parallel webhook delivery) between our status
          // read and the locked update: re-read and treat it as already funded.
          if (err instanceof BadRequestException) {
            const fresh = await this.escrowService.findOne(escrow.id);
            if (fresh.totalStatus !== EscrowStatus.INITIATED) {
              return this.handleAlreadyFundedEscrow(fresh, reference, amountMinor, d.currency);
            }
          }
          throw err;
        }
        return { status: 'success', message: 'Escrow funded via online checkout' };
      }

      // 2. User wallet top-up path
      const customerCode = typeof d.customer?.customer_code === 'string' ? d.customer.customer_code.trim() : '';
      if (customerCode) {
        if (d.currency !== 'NGN') {
          return { status: 'ignored', message: 'Unsupported wallet currency' };
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
          const existing = await queryRunner.manager.findOne(WalletLedger, {
            where: { reference },
          });
          if (existing) {
            await queryRunner.rollbackTransaction();
            return { status: 'success', message: 'Wallet deposit already credited (idempotent)' };
          }

          const user = await queryRunner.manager.findOne(User, {
            where: { paystackCustomerCode: customerCode },
            lock: { mode: 'pessimistic_write' },
          });

          if (!user) {
            await queryRunner.rollbackTransaction();
            this.logger.error(`Webhook received for unknown paystackCustomerCode: ${customerCode}, ref: ${reference}`);
            return { status: 'ignored', message: 'User not found for customer code' };
          }

          const amountMajor = amountMinor / 100;

          const ledger = queryRunner.manager.create(WalletLedger, {
            reference,
            userId: user.id,
            amount: amountMajor,
            type: WalletLedgerType.CREDIT,
            description: `Paystack deposit ref: ${reference}`,
          });
          await queryRunner.manager.save(WalletLedger, ledger);

          user.walletBalance = Number(user.walletBalance) + amountMajor;
          await queryRunner.manager.save(User, user);

          await queryRunner.commitTransaction();
          return { status: 'success', message: `Wallet credited with NGN ${amountMajor}` };
        } catch (err: any) {
          await queryRunner.rollbackTransaction();
          if (err.code === '23505') {
            return { status: 'success', message: 'Wallet deposit already credited (idempotent)' };
          }
          this.logger.error(`Failed to credit wallet for ref ${reference}: ${err.message}`, err.stack);
          throw err;
        } finally {
          await queryRunner.release();
        }
      }
    }

    if (
      event?.event === 'transfer.success' ||
      event?.event === 'transfer.failed' ||
      event?.event === 'transfer.reversed'
    ) {
      const d = event.data ?? {};
      const reference = typeof d.reference === 'string' ? d.reference.trim() : '';
      if (!reference) {
        return { status: 'ignored', message: 'Missing transfer reference' };
      }

      const outcome = event.event === 'transfer.success' ? 'SUCCESS' : 'FAILED';
      this.logger.log(`Paystack ${event.event} received for reference: ${reference}`);

      // One code path for every payout outcome (dispatch response, webhook, reconciliation sweep).
      // References that are not escrow tranche payouts (e.g. dispute payouts) are simply not matched.
      const result = await this.escrowService.applyTransferOutcome(reference, outcome, 'webhook');
      if (!result.matched) {
        this.logger.warn(`No escrow found matching transfer reference: ${reference}`);
        return { status: 'ignored', message: result.message };
      }
      return { status: result.applied ? 'success' : 'ignored', message: result.message };
    }

    return { status: 'ignored', message: 'Unhandled event' };
  }
}
