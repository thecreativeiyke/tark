import { Injectable, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IPaymentGateway,
  InitializePaymentParams,
  InitializePaymentResult,
  ResolveAccountResult,
  TransferPayoutParams,
  TransferPayoutResult,
} from '../interfaces/payment-gateway.interface';

@Injectable()
export class StripeGateway implements IPaymentGateway {
  readonly providerName = 'stripe';
  private readonly logger = new Logger(StripeGateway.name);

  constructor(private configService: ConfigService) {}

  // Sandbox simulation is OFF by default and can never be enabled in production.
  private sandboxFallbackAllowed(): boolean {
    return (
      this.configService.get<string>('NODE_ENV') !== 'production' &&
      this.configService.get<string>('PAYMENTS_SANDBOX_FALLBACK') === 'true'
    );
  }

  supportsCurrency(currency: string): boolean {
    return ['USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(currency.toUpperCase());
  }

  async initializePayment(params: InitializePaymentParams): Promise<InitializePaymentResult> {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new BadGatewayException(
        'Live Stripe processing is not configured for production. Contact platform administration.',
      );
    }
    if (!this.sandboxFallbackAllowed()) {
      throw new BadGatewayException(
        'Stripe test simulation is disabled. Set PAYMENTS_SANDBOX_FALLBACK=true in non-production.',
      );
    }

    const reference = `stripe-checkout-${params.escrowId}-${Date.now()}`;
    this.logger.log(`[Stripe Staging] Initializing international payment intent for ${params.currency}${params.amountMinor / 100}`);

    // When ready for live Stripe keys, this integrates stripe.checkout.sessions.create
    return {
      authorizationUrl: `https://checkout.stripe.com/pay/${reference}`,
      reference,
      rawResponse: { provider: 'stripe', simulated: true },
    };
  }

  async resolveAccount(accountNumber: string, routingCode: string): Promise<ResolveAccountResult> {
    return {
      accountName: 'International Verified Account',
      accountNumber,
      routingCode,
    };
  }

  async createRecipient(
    name: string,
    identifier: string,
    routingCode?: string,
    currency = 'USD',
  ): Promise<string> {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new BadGatewayException(
        'Live Stripe recipient creation is not configured for production.',
      );
    }
    if (!this.sandboxFallbackAllowed()) {
      throw new BadGatewayException(
        'Stripe recipient simulation is disabled. Set PAYMENTS_SANDBOX_FALLBACK=true in non-production.',
      );
    }

    const stripeAccountId = `acct_stripe_${Date.now()}`;
    this.logger.log(`[Stripe Staging] Created Connect payout recipient ${stripeAccountId} for ${name} (${currency})`);
    return stripeAccountId;
  }

  async initiateTransfer(params: TransferPayoutParams): Promise<TransferPayoutResult> {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      throw new BadGatewayException(
        'Live Stripe payouts are not configured for production. Contact platform administration.',
      );
    }
    if (!this.sandboxFallbackAllowed()) {
      throw new BadGatewayException(
        'Stripe transfer simulation is disabled. Set PAYMENTS_SANDBOX_FALLBACK=true in non-production.',
      );
    }

    this.logger.log(`[Stripe Staging] Automated transfer of ${params.currency} ${params.amountMinor / 100} to ${params.recipientCode}`);
    return {
      status: 'paid',
      reference: `tr_stripe_${Date.now()}`,
      simulated: true,
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string): boolean {
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      return false;
    }
    return this.sandboxFallbackAllowed();
  }

  async handleWebhookEvent(event: any): Promise<any> {
    return event;
  }
}
