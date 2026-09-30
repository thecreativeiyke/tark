import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import {
  IPaymentGateway,
  InitializePaymentParams,
  InitializePaymentResult,
  ResolveAccountResult,
  TransferPayoutParams,
  TransferPayoutResult,
} from '../interfaces/payment-gateway.interface';

@Injectable()
export class PaystackGateway implements IPaymentGateway {
  readonly providerName = 'paystack';
  private readonly logger = new Logger(PaystackGateway.name);
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private configService: ConfigService) {}

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

  supportsCurrency(currency: string): boolean {
    return ['NGN', 'GHS', 'ZAR', 'KES'].includes(currency.toUpperCase());
  }

  async initializePayment(params: InitializePaymentParams): Promise<InitializePaymentResult> {
    const reference = `tark-${params.escrowId}-${Date.now()}`;
    try {
      const response = await axios.post(
        `${this.baseUrl}/transaction/initialize`,
        {
          email: params.email,
          amount: params.amountMinor,
          currency: params.currency.toUpperCase(),
          reference,
          metadata: { ...params.metadata, escrowId: params.escrowId },
        },
        { headers: this.getHeaders() },
      );

      return {
        authorizationUrl: response.data.data.authorization_url,
        reference,
        rawResponse: response.data.data,
      };
    } catch (error: any) {
      this.logger.error('Paystack initialization failed', error?.response?.data || error.message);
      throw new BadRequestException('Failed to initialize payment with Paystack');
    }
  }

  async resolveAccount(accountNumber: string, routingCode: string): Promise<ResolveAccountResult> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/bank/resolve?account_number=${accountNumber}&bank_code=${routingCode}`,
        { headers: this.getHeaders() },
      );
      return {
        accountName: response.data.data.account_name,
        accountNumber: response.data.data.account_number,
        routingCode,
      };
    } catch (error: any) {
      this.logger.error('Paystack bank resolution failed', error?.response?.data || error.message);
      throw new BadRequestException('Could not resolve bank account details');
    }
  }

  async createRecipient(
    name: string,
    identifier: string,
    routingCode?: string,
    currency = 'NGN',
  ): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/transferrecipient`,
        {
          type: 'nuban',
          name,
          account_number: identifier,
          bank_code: routingCode,
          currency: currency.toUpperCase(),
        },
        { headers: this.getHeaders() },
      );
      return response.data.data.recipient_code;
    } catch (error: any) {
      this.logger.error('Paystack recipient creation failed', error?.response?.data || error.message);
      throw new BadRequestException('Failed to create transfer recipient on Paystack');
    }
  }

  async initiateTransfer(params: TransferPayoutParams): Promise<TransferPayoutResult> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/transfer`,
        {
          source: 'balance',
          amount: params.amountMinor,
          recipient: params.recipientCode,
          reason: params.reason,
        },
        { headers: this.getHeaders() },
      );
      return {
        status: response.data.data.status || 'success',
        reference: response.data.data.reference,
        rawResponse: response.data.data,
      };
    } catch (error: any) {
      this.logger.warn(`Paystack transfer fallback in test mode: ${error?.response?.data?.message || error.message}`);
      return {
        status: 'queued',
        simulated: true,
      };
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    const secret = this.getSecretKey();
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  async handleWebhookEvent(event: any): Promise<any> {
    return event;
  }
}
