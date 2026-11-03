import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

export interface SendPushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
  data?: Record<string, any>;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

@Injectable()
export class WebPushChannel {
  private readonly logger = new Logger(WebPushChannel.name);
  private isConfigured = false;

  constructor(private readonly configService: ConfigService) {
    this.initVapid();
  }

  private initVapid() {
    const publicKey = this.configService.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.configService.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.configService.get<string>('VAPID_SUBJECT') || 'mailto:support@tark.ng';

    if (publicKey && privateKey && !publicKey.includes('placeholder')) {
      try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        this.isConfigured = true;
        this.logger.log('WebPushChannel initialized with custom VAPID keys.');
      } catch (err: any) {
        this.logger.error(`Failed to configure VAPID details: ${err.message}`);
      }
    } else {
      this.logger.warn('VAPID keys not configured. Browser Web Push will be disabled.');
    }
  }

  async send(
    subscription: PushSubscriptionKeys,
    payload: SendPushPayload,
  ): Promise<{ success: boolean; expired: boolean }> {
    if (!this.isConfigured) {
      return { success: false, expired: false };
    }

    try {
      const stringifiedPayload = JSON.stringify({
        title: payload.title,
        body: payload.body,
        icon: payload.icon || '/icon-192.png',
        badge: payload.badge || '/badge-72.png',
        data: {
          url: payload.url || '/',
          ...payload.data,
        },
      });

      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
          },
        },
        stringifiedPayload,
        {
          TTL: 86400, // 24 hours
        },
      );

      return { success: true, expired: false };
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        this.logger.warn(`Push subscription has expired or unsubscribed: ${subscription.endpoint}`);
        return { success: false, expired: true };
      }
      this.logger.error(`Web Push notification failed: ${err.message}`);
      return { success: false, expired: false };
    }
  }
}
