import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowService } from './escrow.service';
import { EscrowController } from './escrow.controller';
import { EscrowTransaction } from './entities/escrow-transaction.entity';
import { JobsModule } from '../jobs/jobs.module';
import { User } from '../users/entities/user.entity';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EscrowTransaction, User]),
    JobsModule,
    forwardRef(() => PaymentsModule),
    NotificationsModule,
  ],
  controllers: [EscrowController],
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
