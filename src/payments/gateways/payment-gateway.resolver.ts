import { Injectable, BadRequestException } from '@nestjs/common';
import { IPaymentGateway } from '../interfaces/payment-gateway.interface';
import { PaystackGateway } from './paystack.gateway';
import { StripeGateway } from './stripe.gateway';

@Injectable()
export class PaymentGatewayResolver {
  private readonly gateways: IPaymentGateway[];

  constructor(
    private paystackGateway: PaystackGateway,
    private stripeGateway: StripeGateway,
  ) {
    this.gateways = [this.paystackGateway, this.stripeGateway];
  }

  resolveByCurrency(currency: string): IPaymentGateway {
    const normalized = (currency || 'NGN').toUpperCase();
    const gateway = this.gateways.find((g) => g.supportsCurrency(normalized));
    if (!gateway) {
      throw new BadRequestException(`No payment gateway configured for currency: ${currency}`);
    }
    return gateway;
  }

  resolveByProvider(providerName: string): IPaymentGateway {
    const gateway = this.gateways.find((g) => g.providerName.toLowerCase() === providerName.toLowerCase());
    if (!gateway) {
      throw new BadRequestException(`Unknown payment gateway provider: ${providerName}`);
    }
    return gateway;
  }
}
