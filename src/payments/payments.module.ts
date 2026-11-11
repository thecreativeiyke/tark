import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { User } from '../users/entities/user.entity';
import { Job } from '../jobs/entities/job.entity';
import { WalletLedger } from './entities/wallet-ledger.entity';
import { PaystackGateway } from './gateways/paystack.gateway';
import { StripeGateway } from './gateways/stripe.gateway';
import { PaymentGatewayResolver } from './gateways/payment-gateway.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Job, WalletLedger]),
    forwardRef(() => EscrowModule),
  ],
  controllers: [PaymentsController],
  providers: [
    PaystackGateway,
    StripeGateway,
    PaymentGatewayResolver,
    PaymentsService,
  ],
  exports: [PaymentsService, PaymentGatewayResolver],
})
export class PaymentsModule {}
