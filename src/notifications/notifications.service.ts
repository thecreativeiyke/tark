import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Notification, NotificationType } from './entities/notification.entity';
import { PushSubscriptionEntity } from './entities/push-subscription.entity';
import { User } from '../users/entities/user.entity';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { WebPushChannel } from './channels/web-push.channel';
import { EmailTemplates, EmailRenderResult } from './templates/email-templates';
import { SmsTemplates } from './templates/sms-templates';
import { CreatePushSubscriptionDto } from './dto/push-subscription.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';

export interface DispatchNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, any>;
  email?: {
    subject?: string;
    template?: EmailRenderResult;
    html?: string;
  };
  sms?: {
    message: string;
  };
  webPush?: {
    title?: string;
    body?: string;
    url?: string;
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(PushSubscriptionEntity)
    private readonly pushSubRepository: Repository<PushSubscriptionEntity>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly emailChannel: EmailChannel,
    private readonly smsChannel: SmsChannel,
    private readonly webPushChannel: WebPushChannel,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Return the public VAPID key so frontends can register for Web Push
   */
  getVapidPublicKey(): { publicKey: string } {
    const key = this.configService.get<string>('VAPID_PUBLIC_KEY') || '';
    return { publicKey: key };
  }

  /**
   * Save or update a browser push subscription for a user
   */
  async savePushSubscription(userId: string, dto: CreatePushSubscriptionDto): Promise<PushSubscriptionEntity> {
    let existing = await this.pushSubRepository.findOne({
      where: { endpoint: dto.endpoint },
    });

    if (existing) {
      existing.userId = userId;
      existing.p256dh = dto.keys.p256dh;
      existing.auth = dto.keys.auth;
      existing.userAgent = dto.userAgent || existing.userAgent;
      return this.pushSubRepository.save(existing);
    }

    const sub = this.pushSubRepository.create({
      userId,
      endpoint: dto.endpoint,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: dto.userAgent || null,
    });
    return this.pushSubRepository.save(sub);
  }

  /**
   * Remove a push subscription
   */
  async removePushSubscription(userId: string, endpoint: string): Promise<void> {
    await this.pushSubRepository.delete({ userId, endpoint });
  }

  /**
   * Fetch in-app notifications for the authenticated user
   */
  async getUserNotifications(userId: string, query: QueryNotificationsDto) {
    const { limit = 20, offset = 0, unreadOnly = false } = query;

    const qb = this.notificationsRepository
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId })
      .orderBy('n.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    if (unreadOnly) {
      qb.andWhere('n.isRead = false');
    }

    const [items, total] = await qb.getManyAndCount();
    const unreadCount = await this.getUnreadCount(userId);

    return {
      data: items,
      total,
      limit,
      offset,
      unreadCount,
    };
  }

  /**
   * Get unread notifications count for badge display
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationsRepository.count({
      where: { userId, isRead: false },
    });
  }

  /**
   * Mark a single notification as read
   */
  async markAsRead(id: string, userId: string): Promise<Notification> {
    const notification = await this.notificationsRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification #${id} not found`);
    }

    notification.isRead = true;
    notification.readAt = new Date();
    return this.notificationsRepository.save(notification);
  }

  /**
   * Mark all notifications as read for current user
   */
  async markAllAsRead(userId: string): Promise<{ affected: number }> {
    const result = await this.notificationsRepository.update(
      { userId, isRead: false },
      { isRead: true, readAt: new Date() },
    );
    return { affected: result.affected || 0 };
  }

  /**
   * Central Dispatch Method:
   * 1. Saves to DB for in-app feed.
   * 2. Fires Email asynchronously if email data provided.
   * 3. Fires SMS asynchronously if sms data provided.
   * 4. Fires Web Push to all active device subscriptions.
   */
  async dispatch(options: DispatchNotificationOptions): Promise<Notification> {
    const { userId, type, title, message, metadata } = options;

    // 1. In-App Notification (Always stored)
    const notification = this.notificationsRepository.create({
      userId,
      type,
      title,
      message,
      metadata: metadata || null,
      isRead: false,
    });
    const saved = await this.notificationsRepository.save(notification);

    // Load user for contact details (email/phone)
    const user = await this.usersRepository.findOne({ where: { id: userId } });

    // 2. Email Dispatch (Fire-and-forget async)
    if (options.email && user?.email) {
      const subject = options.email.subject || options.email.template?.subject || title;
      const html = options.email.html || options.email.template?.html || `<p>${message}</p>`;

      this.emailChannel
        .send({ to: user.email, subject, html })
        .catch((err) => this.logger.error(`Email dispatch error: ${err.message}`));
    }

    // 3. SMS Dispatch
    if (options.sms && user?.phoneNumber) {
      this.smsChannel
        .send({ to: user.phoneNumber, message: options.sms.message })
        .catch((err) => this.logger.error(`SMS dispatch error: ${err.message}`));
    }

    // 4. Web Push Dispatch
    this.dispatchWebPush(userId, {
      title: options.webPush?.title || title,
      body: options.webPush?.body || message,
      url: options.webPush?.url || '/',
      data: { type, notificationId: saved.id },
    }).catch((err) => this.logger.error(`Web push error: ${err.message}`));

    return saved;
  }

  private async dispatchWebPush(
    userId: string,
    payload: { title: string; body: string; url?: string; data?: any },
  ) {
    const subscriptions = await this.pushSubRepository.find({ where: { userId } });
    if (!subscriptions || subscriptions.length === 0) return;

    for (const sub of subscriptions) {
      const res = await this.webPushChannel.send(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
      );

      // If subscription expired, prune from database automatically
      if (res.expired) {
        await this.pushSubRepository.delete({ id: sub.id });
        this.logger.log(`Pruned stale push subscription #${sub.id}`);
      }
    }
  }

  // ==============================================================
  // PROTOCOL-LEVEL TRIGGERS (Tark Safe-Lock Workflows)
  // ==============================================================

  /**
   * 1. Trigger when an artisan submits a bid
   */
  async notifyBidReceived(params: {
    clientId: string;
    clientName: string;
    artisanName: string;
    jobTitle: string;
    bidAmount: number;
    completionTimeDays?: number;
    jobId: string;
  }) {
    const smsText = SmsTemplates.bidReceived(params.artisanName, params.jobTitle, params.bidAmount);
    const emailResult = EmailTemplates.bidReceived({
      clientName: params.clientName,
      artisanName: params.artisanName,
      jobTitle: params.jobTitle,
      bidAmount: params.bidAmount,
      completionTimeDays: params.completionTimeDays,
      viewBidUrl: `https://tark.ng/jobs/${params.jobId}`,
    });

    return this.dispatch({
      userId: params.clientId,
      type: NotificationType.BID_RECEIVED,
      title: `New Bid on "${params.jobTitle}"`,
      message: `${params.artisanName} bid ₦${params.bidAmount.toLocaleString()} on your job.`,
      metadata: { jobId: params.jobId, bidAmount: params.bidAmount },
      email: { template: emailResult },
      sms: { message: smsText },
      webPush: { url: `/jobs/${params.jobId}` },
    });
  }

  /**
   * 2. Trigger when client locks full escrow funds in Tark Safe-Lock
   */
  async notifySafeLockFunded(params: {
    artisanId: string;
    artisanName: string;
    clientName: string;
    jobTitle: string;
    totalBudget: number;
    tranche1Amount: number;
    jobId: string;
    escrowId: string;
  }) {
    const smsText = SmsTemplates.safeLockFunded(params.jobTitle, params.tranche1Amount);
    const emailResult = EmailTemplates.safeLockFunded({
      artisanName: params.artisanName,
      clientName: params.clientName,
      jobTitle: params.jobTitle,
      totalBudget: params.totalBudget,
      tranche1Amount: params.tranche1Amount,
      actionUrl: `https://tark.ng/jobs/${params.jobId}`,
    });

    return this.dispatch({
      userId: params.artisanId,
      type: NotificationType.SAFE_LOCK_FUNDED,
      title: `Safe-Lock Escrow Funded`,
      message: `Client deposited full budget for "${params.jobTitle}". Mobilization ready.`,
      metadata: { jobId: params.jobId, escrowId: params.escrowId },
      email: { template: emailResult },
      sms: { message: smsText },
      webPush: { url: `/jobs/${params.jobId}` },
    });
  }

  /**
   * 3. Trigger when Tranche 1 (Start-Work Mobilization) is released to artisan
   */
  async notifyTranche1Released(params: {
    artisanId: string;
    artisanName: string;
    jobTitle: string;
    amount: number;
    jobId: string;
  }) {
    const emailResult = EmailTemplates.tranche1Released({
      recipientName: params.artisanName,
      jobTitle: params.jobTitle,
      amount: params.amount,
      actionUrl: `https://tark.ng/wallet`,
    });

    return this.dispatch({
      userId: params.artisanId,
      type: NotificationType.TRANCHE1_RELEASED,
      title: `Start-Work Mobilization Released`,
      message: `₦${params.amount.toLocaleString()} has been credited to your in-app wallet for "${params.jobTitle}".`,
      metadata: { jobId: params.jobId, amount: params.amount },
      email: { template: emailResult },
      sms: {
        message: `Tark Alert: Start-Work Mobilization of ₦${params.amount.toLocaleString()} for "${params.jobTitle}" is in your wallet.`,
      },
      webPush: { url: `/wallet` },
    });
  }

  /**
   * 4. Trigger when artisan requests completion and Handshake PIN is generated
   */
  async notifyHandshakeReady(params: {
    clientId: string;
    clientName: string;
    artisanName: string;
    jobTitle: string;
    handshakePin: string;
    jobId: string;
  }) {
    const smsText = SmsTemplates.handshakePin(params.handshakePin, params.jobTitle);
    const emailResult = EmailTemplates.handshakeReady({
      clientName: params.clientName,
      artisanName: params.artisanName,
      jobTitle: params.jobTitle,
      handshakePin: params.handshakePin,
      actionUrl: `https://tark.ng/jobs/${params.jobId}`,
    });

    return this.dispatch({
      userId: params.clientId,
      type: NotificationType.HANDSHAKE_READY,
      title: `Job Completion Code Ready`,
      message: `Artisan marked "${params.jobTitle}" complete. Inspect work and verify code: ${params.handshakePin}.`,
      metadata: { jobId: params.jobId },
      email: { template: emailResult },
      sms: { message: smsText },
      webPush: { url: `/jobs/${params.jobId}` },
    });
  }

  /**
   * 5. Trigger when Handshake PIN is confirmed and final payout settles
   */
  async notifyPayoutSettled(params: {
    artisanId: string;
    artisanName: string;
    jobTitle: string;
    disbursedAmount: number;
    platformFeeAmount: number;
    totalJobBudget: number;
    accountMasked?: string;
    jobId: string;
  }) {
    const smsText = SmsTemplates.payoutSettled(params.disbursedAmount, params.jobTitle);
    const emailResult = EmailTemplates.payoutSettled({
      artisanName: params.artisanName,
      jobTitle: params.jobTitle,
      disbursedAmount: params.disbursedAmount,
      platformFeeAmount: params.platformFeeAmount,
      totalJobBudget: params.totalJobBudget,
      accountMasked: params.accountMasked,
      actionUrl: `https://tark.ng/wallet`,
    });

    return this.dispatch({
      userId: params.artisanId,
      type: NotificationType.PAYOUT_SETTLED,
      title: `Final Payment Settled`,
      message: `₦${params.disbursedAmount.toLocaleString()} has been transferred for "${params.jobTitle}".`,
      metadata: { jobId: params.jobId, disbursedAmount: params.disbursedAmount },
      email: { template: emailResult },
      sms: { message: smsText },
      webPush: { url: `/wallet` },
    });
  }

  /**
   * 6. Trigger when a dispute ticket is updated or resolved
   */
  async notifyDisputeUpdate(params: {
    userId: string;
    userName: string;
    jobTitle: string;
    disputeReason: string;
    status: string;
    resolutionNotes?: string;
    disputeId: string;
  }) {
    const smsText = SmsTemplates.disputeNotice(params.jobTitle, params.status);
    const emailResult = EmailTemplates.disputeUpdate({
      recipientName: params.userName,
      jobTitle: params.jobTitle,
      disputeReason: params.disputeReason,
      status: params.status,
      resolutionNotes: params.resolutionNotes,
      actionUrl: `https://tark.ng/disputes/${params.disputeId}`,
    });

    return this.dispatch({
      userId: params.userId,
      type: NotificationType.DISPUTE_RESOLVED,
      title: `Resolution Desk Update: ${params.status}`,
      message: `Case status update for "${params.jobTitle}": ${params.status}`,
      metadata: { disputeId: params.disputeId, status: params.status },
      email: { template: emailResult },
      sms: { message: smsText },
      webPush: { url: `/disputes/${params.disputeId}` },
    });
  }
}
