import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { GeminiService } from './gemini.service';
import { SupportTicket } from './entities/support-ticket.entity';
import { SupportMessage } from './entities/support-message.entity';
import { User } from '../users/entities/user.entity';
import { Job } from '../jobs/entities/job.entity';
import { EscrowTransaction } from '../escrow/entities/escrow-transaction.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SupportTicket,
      SupportMessage,
      User,
      Job,
      EscrowTransaction,
    ]),
    AuthModule,
  ],
  controllers: [SupportController],
  providers: [SupportService, GeminiService],
  exports: [SupportService],
})
export class SupportModule {}
