import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowService } from './escrow.service';
import { EscrowController } from './escrow.controller';
import { EscrowTransaction } from './entities/escrow-transaction.entity';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EscrowTransaction]),
    JobsModule,
  ],
  controllers: [EscrowController],
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
