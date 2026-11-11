import {
  Injectable,
  BadRequestException,
  BadGatewayException,
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
  TransferDispatchError,
  VerifyTransferResult,
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

  // Sandbox simulation is OFF by default and can never be enabled in production.
  // Locally, set PAYMENTS_SANDBOX_FALLBACK=true to let flows continue when the
  // provider is unreachable or a test key is a placeholder.
  private sandboxFallbackAllowed(): boolean {
    return (
      this.configService.get<string>('NODE_ENV') !== 'production' &&
      this.configService.get<string>('PAYMENTS_SANDBOX_FALLBACK') === 'true'
    );
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
      if (!this.sandboxFallbackAllowed()) {
        // Never hand a customer a dead "sandbox" checkout link in production.
        this.logger.error(`Paystack initialization failed: ${error?.response?.data?.message || error?.message}`);
        throw new BadGatewayException('Could not start the payment right now. Please try again shortly.');
      }
      this.logger.warn('Paystack live initialization unavailable (' + (error?.code || error?.message) + '). Activating Sandbox checkout.');
      return {
        authorizationUrl: `https://checkout.paystack.com/sandbox-${reference}`,
        reference,
        rawResponse: { simulated: true, error: error?.message },
      };
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
      const detail = error?.response?.data?.message || error.message;
      if (!this.sandboxFallbackAllowed()) {
        this.logger.error(`Paystack bank resolution failed: ${detail}`);
        throw new BadRequestException(
          'Could not verify this bank account. Check the account number and bank, then try again.',
        );
      }
      this.logger.warn(`Paystack bank resolution fallback in sandbox mode: ${detail}`);
      return {
        accountName: `VERIFIED ARTISAN ACCOUNT (${accountNumber.slice(-4)})`,
        accountNumber,
        routingCode,
      };
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
      const detail = error?.response?.data?.message || error.message;
      if (!this.sandboxFallbackAllowed()) {
        this.logger.error(`Paystack recipient creation failed: ${detail}`);
        throw new BadRequestException(
          'Could not register this payout account with the payment provider. Please try again.',
        );
      }
      this.logger.warn(`Paystack recipient creation fallback in sandbox mode: ${detail}`);
      return `RCP_sandbox_${Date.now()}`;
    }
  }

  async initiateTransfer(params: TransferPayoutParams): Promise<TransferPayoutResult> {
    let response: { data: any };
    try {
      response = await axios.post(
        `${this.baseUrl}/transfer`,
        {
          source: 'balance',
          amount: params.amountMinor,
          recipient: params.recipientCode,
          reason: params.reason,
          ...(params.reference ? { reference: params.reference } : {}),
        },
        { headers: this.getHeaders(), timeout: 20000 },
      );
    } catch (error: any) {
      const httpStatus: number | undefined = error?.response?.status;
      const detail = error?.response?.data?.message || error.message;
      if (!this.sandboxFallbackAllowed()) {
        // Never pretend money moved. A 4xx (except 408/429) is a definitive refusal, so no
        // transfer exists. Anything else (timeout, 5xx, network) is ambiguous: the transfer
        // may exist, and the caller must verify before ever retrying.
        this.logger.error(`Paystack transfer failed (${httpStatus ?? 'no response'}): ${detail}`);
        const definitive =
          httpStatus !== undefined &&
          httpStatus >= 400 &&
          httpStatus < 500 &&
          httpStatus !== 408 &&
          httpStatus !== 429;
        throw new TransferDispatchError(
          `Payout failed with the payment provider: ${detail}`,
          definitive ? 'REJECTED' : 'UNKNOWN',
        );
      }
      this.logger.warn(`Paystack transfer fallback in sandbox mode: ${detail}`);
      return {
        status: 'queued',
        simulated: true,
      };
    }

    const data = response.data?.data ?? {};
    // The provider status is returned as-is (success | pending | received | otp | failed |
    // reversed). Interpreting it is the payout service's job, because 'pending' is not paid
    // yet and 'otp' means the transfer exists but has NOT been sent.
    return {
      status: data.status || 'pending',
      reference: data.reference ?? params.reference,
      rawResponse: data,
    };
  }

  async verifyTransfer(reference: string): Promise<VerifyTransferResult> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/transfer/verify/${encodeURIComponent(reference)}`,
        { headers: this.getHeaders(), timeout: 20000 },
      );
      const data = response.data?.data ?? {};
      return {
        found: true,
        status: data.status,
        reference: data.reference ?? reference,
        amountMinor: Number(data.amount),
      };
    } catch (error: any) {
      const httpStatus = error?.response?.status;
      const message = String(error?.response?.data?.message || '');
      if (httpStatus === 404 || (httpStatus === 400 && /not found/i.test(message))) {
        return { found: false };
      }
      throw error;
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
