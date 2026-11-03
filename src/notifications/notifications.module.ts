import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Notification } from './entities/notification.entity';
import { PushSubscriptionEntity } from './entities/push-subscription.entity';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { WebPushChannel } from './channels/web-push.channel';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, PushSubscriptionEntity, User]),
    ConfigModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    EmailChannel,
    SmsChannel,
    WebPushChannel,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
