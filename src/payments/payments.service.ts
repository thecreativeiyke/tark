import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { EscrowService } from '../escrow/escrow.service';
import { EscrowStatus } from '../escrow/entities/escrow-transaction.entity';
import { User } from '../users/entities/user.entity';
import { Job } from '../jobs/entities/job.entity';
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

  async initializePayment(escrowId: string, email: string) {
    const escrow = await this.escrowService.findOne(escrowId);
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

  async fundEscrowWithWallet(escrowId: string, userId: string) {
    const escrow = await this.escrowService.findOne(escrowId);

    if (escrow.clientId !== userId) {
      throw new BadRequestException('Only the client who created this escrow can fund it');
    }

    if (escrow.totalStatus !== EscrowStatus.INITIATED) {
      throw new BadRequestException(`Escrow is already ${escrow.totalStatus}`);
    }

    const totalAmount = Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount);
    const user = await this.usersRepository.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const currentBalance = Number(user.walletBalance || 0);
    if (currentBalance < totalAmount) {
      throw new BadRequestException(
        `Insufficient wallet balance. Required: NGN ${totalAmount}, Available: NGN ${currentBalance}`,
      );
    }

    user.walletBalance = parseFloat((currentBalance - totalAmount).toFixed(2));
    await this.usersRepository.save(user);

    const lockedEscrow = await this.escrowService.lockFunds(escrow.id);

    return {
      message: 'Escrow funded successfully from wallet',
      deductedAmount: totalAmount,
      remainingBalance: user.walletBalance,
      escrow: lockedEscrow,
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
        this.logger.warn(`Bank resolution bypassed or failed in test mode: ${err.message}`);
      }
    }

    let recipientCode = `RCP_${Date.now()}`;
    try {
      recipientCode = await gateway.createRecipient(resolvedName, accountNumber, bankCode, currency);
    } catch (err: any) {
      this.logger.warn(`Recipient creation simulated: ${err.message}`);
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
  ) {
    const gateway = this.gatewayResolver.resolveByCurrency(currency);
    return gateway.initiateTransfer({
      amountMinor,
      currency,
      recipientCode,
      reason,
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, provider = 'paystack'): boolean {
    const gateway = this.gatewayResolver.resolveByProvider(provider);
    return gateway.verifyWebhook(rawBody, signature);
  }

  async handleWebhook(event: any) {
    if (event.event === 'charge.success') {
      const reference = event.data?.reference;
      const customerCode = event.data?.customer?.customer_code;

      const escrow = await this.escrowService.findByReference(reference);
      if (escrow) {
        if (escrow.totalStatus === EscrowStatus.FUNDS_LOCKED || escrow.totalStatus === EscrowStatus.HANDSHAKE_PENDING || escrow.totalStatus === EscrowStatus.SETTLED) {
          return { status: 'success', message: 'Escrow already funded (idempotent)' };
        }
        await this.escrowService.lockFunds(escrow.id);
        return { status: 'success', message: 'Escrow funded via online checkout' };
      }

      if (customerCode) {
        const user = await this.usersRepository.findOneBy({ paystackCustomerCode: customerCode });
        if (user) {
          const amountMajor = Number(event.data.amount) / 100;
          user.walletBalance = Number(user.walletBalance) + amountMajor;
          await this.usersRepository.save(user);
          return { status: 'success', message: `Wallet credited with NGN ${amountMajor}` };
        }
      }
    }

    return { status: 'ignored', message: 'Unhandled event' };
  }
}
