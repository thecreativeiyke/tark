import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowService } from './escrow.service';
import { EscrowController } from './escrow.controller';
import { EscrowTransaction } from './entities/escrow-transaction.entity';

@Module({
  imports: [TypeOrmModule.forFeature([EscrowTransaction])],
  controllers: [EscrowController],
  providers: [EscrowService],
})
export class EscrowModule {}
