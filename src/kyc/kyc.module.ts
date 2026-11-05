import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { KycRecord } from './entities/kyc-record.entity';
import { User } from '../users/entities/user.entity';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycTriageService } from './services/kyc-triage.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([KycRecord, User]),
    ConfigModule,
    forwardRef(() => NotificationsModule),
  ],
  controllers: [KycController],
  providers: [KycService, KycTriageService],
  exports: [KycService],
})
export class KycModule {}
