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
   * Normalize Nigerian mobile numbers to international E.164 format
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

  async send(options: SendSmsOptions): Promise<{ success: boolean; provider: string; messageId?: string }> {
    const provider = (this.configService.get<string>('SMS_PROVIDER') || 'mock').toLowerCase();
    const formattedPhone = this.formatPhoneNumber(options.to);

    // Level 2: Termii Real Dispatch (Live / Sandbox)
    if (provider === 'termii') {
      const apiKey = this.configService.get<string>('TERMII_API_KEY');
      const senderId = this.configService.get<string>('TERMII_SENDER_ID') || 'N-Alert';
      const channel = this.configService.get<string>('TERMII_CHANNEL') || 'dnd';

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

          const res = await axios.post('https://api.ng.termii.com/api/sms/send', payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          });

          this.logger.log(
            `[SMS Delivered] Termii API dispatched to ${formattedPhone} via ${channel} channel (ID: ${res.data?.message_id || 'ok'})`,
          );
          return { success: true, provider: 'termii', messageId: res.data?.message_id };
        } catch (err: any) {
          const errDetail = err.response?.data?.message || err.message;
          this.logger.warn(
            `[Termii Dispatch Failed] Attempt with sender '${senderId}' and channel '${channel}' failed: ${errDetail}. Attempting DND fallback with 'N-Alert'...`,
          );

          // Retry fallback: DND channel with default N-Alert sender
          try {
            const fallbackRes = await axios.post(
              'https://api.ng.termii.com/api/sms/send',
              {
                to: formattedPhone,
                from: 'N-Alert',
                sms: options.message,
                type: 'plain',
                channel: 'dnd',
                api_key: apiKey,
              },
              { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
            );

            this.logger.log(
              `[SMS Delivered] Termii DND fallback successfully dispatched to ${formattedPhone} (ID: ${fallbackRes.data?.message_id})`,
            );
            return { success: true, provider: 'termii', messageId: fallbackRes.data?.message_id };
          } catch (retryErr: any) {
            const retryDetail = retryErr.response?.data?.message || retryErr.message;
            this.logger.warn(
              `[SMS Fallback Triggered] Termii retry also failed (${retryDetail}). Falling back to Level 1 console mock...`,
            );
          }
        }
      } else {
        this.logger.warn('TERMII_API_KEY is not configured. Falling back to Level 1 console mock.');
      }
    }

    // Level 1: Console Mock & Simulator
    this.logger.log(
      `\n┌────────────────── [SMS MOCK DISPATCH] ──────────────────┐\n` +
      `│ Recipient : +${formattedPhone}\n` +
      `│ Provider  : LEVEL 1 CONSOLE SIMULATOR\n` +
      `│ Message   : "${options.message}"\n` +
      `└────────────────────────────────────────────────────────┘`,
    );

    return { success: true, provider: 'mock' };
  }
}
