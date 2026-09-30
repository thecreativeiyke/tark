import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [EscrowModule, UsersModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
