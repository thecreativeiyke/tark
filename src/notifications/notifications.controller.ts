import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreatePushSubscriptionDto } from './dto/push-subscription.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { NotificationType } from './entities/notification.entity';

interface AuthenticatedRequest {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Public: Retrieve VAPID Public Key for Web Push browser subscription
   */
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('vapid-public-key')
  getVapidPublicKey() {
    return this.notificationsService.getVapidPublicKey();
  }

  /**
   * Protected: Get authenticated user's notifications (paginated)
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  getMyNotifications(
    @Request() req: AuthenticatedRequest,
    @Query() query: QueryNotificationsDto,
  ) {
    return this.notificationsService.getUserNotifications(req.user.userId, query);
  }

  /**
   * Protected: Get unread count for badge display
   */
  @UseGuards(JwtAuthGuard)
  @Get('unread-count')
  getUnreadCount(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.getUnreadCount(req.user.userId).then((count) => ({
      unreadCount: count,
    }));
  }

  /**
   * Protected: Mark all notifications as read
   */
  @UseGuards(JwtAuthGuard)
  @Patch('read-all')
  markAllAsRead(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.markAllAsRead(req.user.userId);
  }

  /**
   * Protected: Mark a single notification as read
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/read')
  markAsRead(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.notificationsService.markAsRead(id, req.user.userId);
  }

  /**
   * Protected: Subscribe web browser to Push Notifications via VAPID
   */
  @UseGuards(JwtAuthGuard)
  @Post('subscribe-push')
  subscribePush(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreatePushSubscriptionDto,
  ) {
    return this.notificationsService.savePushSubscription(req.user.userId, dto);
  }

  /**
   * Protected: Unsubscribe web browser from Push Notifications
   */
  @UseGuards(JwtAuthGuard)
  @Delete('unsubscribe-push')
  unsubscribePush(
    @Request() req: AuthenticatedRequest,
    @Body('endpoint') endpoint: string,
  ) {
    return this.notificationsService.removePushSubscription(req.user.userId, endpoint);
  }

  /**
   * Protected (Dev/Test): Dispatch a multi-channel test notification to the authenticated user
   */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseGuards(JwtAuthGuard)
  @Post('test-dispatch')
  testDispatch(
    @Request() req: AuthenticatedRequest,
    @Body('channel') channel?: 'all' | 'email' | 'sms' | 'push',
    @Body('customMessage') customMessage?: string,
  ) {
    const text = customMessage || 'This is a live test notification from Tark Safe-Lock Multi-Channel Engine.';
    const selectedChannel = channel || 'all';

    const dispatchOptions: any = {
      userId: req.user.userId,
      type: NotificationType.SYSTEM_ALERT,
      title: 'Tark System Test Alert',
      message: text,
      metadata: { isTest: true, dispatchedAt: new Date().toISOString() },
    };

    if (selectedChannel === 'all' || selectedChannel === 'email') {
      dispatchOptions.email = {
        subject: '🧪 Tark Multi-Channel Test Notification',
        html: `<p>Hello,</p><p>${text}</p><p>Multi-channel engine test successful!</p>`,
      };
    }

    if (selectedChannel === 'all' || selectedChannel === 'sms') {
      dispatchOptions.sms = {
        message: `Tark Test: ${text}`,
      };
    }

    if (selectedChannel === 'all' || selectedChannel === 'push') {
      dispatchOptions.webPush = {
        title: 'Tark Test Alert',
        body: text,
        url: '/',
      };
    }

    return this.notificationsService.dispatch(dispatchOptions);
  }
}
