import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import * as crypto from 'crypto';
import { EscrowService } from '../escrow/escrow.service';
import { User } from '../users/entities/user.entity';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly paystackBaseUrl = 'https://api.paystack.co';

  constructor(
    private configService: ConfigService,
    private escrowService: EscrowService,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
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

  async initializePayment(escrowId: string, email: string) {
    const escrow = await this.escrowService.findOne(escrowId);
    const totalAmount = Number(escrow.tranche1Amount) + Number(escrow.tranche2Amount);
    const amountInKobo = Math.round(totalAmount * 100);
    const reference = `tark-${escrow.id}-${Date.now()}`;

    try {
      const response = await axios.post(
        `${this.paystackBaseUrl}/transaction/initialize`,
        {
          email,
          amount: amountInKobo,
          reference,
          metadata: { escrowId: escrow.id },
        },
        { headers: this.getHeaders() },
      );

      await this.escrowService.attachPaystackReference(escrow.id, reference);
      return response.data.data;
    } catch (error: any) {
      this.logger.error('Payment initialization failed', error?.response?.data || error.message);
      throw new BadRequestException('Failed to initialize payment with Paystack');
    }
  }

  async resolveBankAccount(accountNumber: string, bankCode: string) {
    try {
      const response = await axios.get(
        `${this.paystackBaseUrl}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        { headers: this.getHeaders() },
      );
      return response.data.data;
    } catch (error: any) {
      this.logger.error('Bank resolution failed', error?.response?.data || error.message);
      throw new BadRequestException('Could not resolve bank account details');
    }
  }

  async createTransferRecipient(name: string, accountNumber: string, bankCode: string) {
    try {
      const response = await axios.post(
        `${this.paystackBaseUrl}/transferrecipient`,
        {
          type: 'nuban',
          name,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: 'NGN',
        },
        { headers: this.getHeaders() },
      );
      return response.data.data.recipient_code;
    } catch (error: any) {
      this.logger.error('Recipient creation failed', error?.response?.data || error.message);
      throw new BadRequestException('Failed to create transfer recipient on Paystack');
    }
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

    try {
      let customerCode = user.paystackCustomerCode;
      if (!customerCode) {
        const [firstName, ...lastNameParts] = user.fullName.split(' ');
        const customerRes = await axios.post(
          `${this.paystackBaseUrl}/customer`,
          {
            email: user.email,
            first_name: firstName,
            last_name: lastNameParts.join(' ') || 'User',
            phone: user.phoneNumber || undefined,
          },
          { headers: this.getHeaders() },
        );
        customerCode = customerRes.data.data.customer_code;
        user.paystackCustomerCode = customerCode;
        await this.usersRepository.save(user);
      }

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

      return {
        accountNumber: user.virtualAccountNumber,
        bankName: user.virtualBankName,
        customerCode: user.paystackCustomerCode,
      };
    } catch (error: any) {
      this.logger.error('DVA assignment failed', error?.response?.data || error.message);
      throw new BadRequestException('Failed to generate dedicated virtual account');
    }
  }

  async initiateTransfer(amountKobo: number, recipientCode: string, reason: string) {
    try {
      const response = await axios.post(
        `${this.paystackBaseUrl}/transfer`,
        {
          source: 'balance',
          amount: amountKobo,
          recipient: recipientCode,
          reason,
        },
        { headers: this.getHeaders() },
      );
      return response.data.data;
    } catch (error: any) {
      this.logger.error('Transfer payout failed', error?.response?.data || error.message);
      throw new BadRequestException('Automated payout transfer failed');
    }
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret = this.getSecretKey();
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  async handleWebhook(event: any) {
    if (event.event === 'charge.success') {
      const reference = event.data?.reference;
      const customerCode = event.data?.customer?.customer_code;

      const escrow = await this.escrowService.findByReference(reference);
      if (escrow) {
        await this.escrowService.lockFunds(escrow.id);
        return { status: 'success', message: 'Escrow funded via Paystack checkout' };
      }

      if (customerCode) {
        const user = await this.usersRepository.findOneBy({ paystackCustomerCode: customerCode });
        if (user) {
          const amountNaira = Number(event.data.amount) / 100;
          user.walletBalance = Number(user.walletBalance) + amountNaira;
          await this.usersRepository.save(user);
          return { status: 'success', message: `Wallet credited with NGN ${amountNaira}` };
        }
      }
    }

    return { status: 'ignored', message: 'Unhandled event' };
  }
}
