import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SendSmsOptions {
  to: string;
  message: string;
}

@Injectable()
export class SmsChannel {
  private readonly logger = new Logger(SmsChannel.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Normalize Nigerian mobile numbers to international format (no plus sign)
   * e.g. "08012345678" -> "2348012345678"
   */
  private formatPhoneNumber(phone: string): string {
    const cleaned = phone.replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      return `234${cleaned.substring(1)}`;
    }
    if (cleaned.startsWith('234') && cleaned.length === 13) {
      return cleaned;
    }
    return cleaned;
  }

  /**
   * Returns success:true ONLY when a real provider accepted the message.
   * The console simulator exists for local development and is never used in
   * production: a failed security-code SMS must be reported as failed.
   */
  async send(
    options: SendSmsOptions,
  ): Promise<{ success: boolean; provider: string; messageId?: string }> {
    const provider = (this.configService.get<string>('SMS_PROVIDER') || 'mock').toLowerCase();
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    const formattedPhone = this.formatPhoneNumber(options.to);

    // Level 2: Termii real dispatch
    if (provider === 'termii') {
      const apiKey = this.configService.get<string>('TERMII_API_KEY');
      const senderId = this.configService.get<string>('TERMII_SENDER_ID') || 'Tark';
      const channel = this.configService.get<string>('TERMII_CHANNEL') || 'generic';
      const baseUrl =
        this.configService.get<string>('TERMII_BASE_URL') || 'https://v4.api.termii.com/api';

      if (apiKey && !apiKey.includes('placeholder')) {
        try {
          const payload = {
            to: formattedPhone,
            from: senderId,
            sms: options.message,
            type: 'plain',
            channel,
            api_key: apiKey,
          };

          const res = await axios.post(`${baseUrl}/sms/send`, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          });

          this.logger.log(
            `[SMS Delivered] Termii accepted message to +${formattedPhone} via ${channel} channel (ID: ${res.data?.message_id || 'ok'})`,
          );
          return { success: true, provider: 'termii', messageId: res.data?.message_id };
        } catch (err: any) {
          const errDetail = err.response?.data?.message || err.message;
          if (isProduction) {
            this.logger.error(
              `[SMS FAILED] Termii rejected the message to +${formattedPhone}: "${errDetail}". No fallback in production.`,
            );
            return { success: false, provider: 'termii' };
          }
          this.logger.warn(
            `[Termii Dispatch Notice] Real SMS to +${formattedPhone} failed: "${errDetail}". Using the DEV console simulator instead (nothing was delivered).`,
          );
        }
      } else {
        if (isProduction) {
          this.logger.error('TERMII_API_KEY is not configured. SMS was NOT sent.');
          return { success: false, provider: 'none' };
        }
        this.logger.warn('TERMII_API_KEY is not configured. Using the DEV console simulator.');
      }
    }

    if (isProduction) {
      this.logger.error('SMS_PROVIDER is not a live provider. SMS was NOT sent.');
      return { success: false, provider: 'none' };
    }

    // Level 1: development console simulator. Nothing is actually delivered.
    this.logger.log(
      `\n┌────────────────── [SMS MOCK DISPATCH - NOT DELIVERED] ──────────────────┐\n` +
        `│ Recipient : +${formattedPhone}\n` +
        `│ Provider  : DEV CONSOLE SIMULATOR\n` +
        `│ Message   : "${options.message}"\n` +
        `└──────────────────────────────────────────────────────────────────────┘`,
    );

    return { success: true, provider: 'mock' };
  }
}
