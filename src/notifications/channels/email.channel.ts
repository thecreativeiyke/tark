import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

@Injectable()
export class EmailChannel {
  private readonly logger = new Logger(EmailChannel.name);
  private resendClient: Resend | null = null;
  private smtpTransporter: nodemailer.Transporter | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initProviders();
  }

  private initProviders() {
    const resendApiKey = this.configService.get<string>('RESEND_API_KEY');
    if (resendApiKey && !resendApiKey.includes('placeholder')) {
      this.resendClient = new Resend(resendApiKey);
      this.logger.log('Resend client initialized as primary email provider.');
    } else {
      this.logger.warn('RESEND_API_KEY not configured. Resend will be bypassed.');
    }

    const smtpHost = this.configService.get<string>('SMTP_HOST');
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');
    const smtpPort = this.configService.get<number>('SMTP_PORT', 587);

    if (smtpHost && smtpUser && smtpPass) {
      this.smtpTransporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number(smtpPort),
        secure: Number(smtpPort) === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
      this.logger.log(`SMTP fallback initialized (${smtpHost}:${smtpPort}) for ${smtpUser}.`);
    } else {
      this.logger.warn('SMTP credentials not fully configured. Email fallback disabled.');
    }
  }

  /**
   * Send transactional email with automatic resilient fallback
   * Try 1: Resend (Primary)
   * Try 2: Nodemailer / Gmail SMTP (Fallback)
   */
  async send(options: SendEmailOptions): Promise<{ success: boolean; provider: string; id?: string }> {
    const { to, subject, html } = options;

    // 1. Attempt Primary: Resend
    if (this.resendClient) {
      try {
        const fromAddress =
          this.configService.get<string>('RESEND_FROM') || 'Tark <onboarding@resend.dev>';

        const response = await this.resendClient.emails.send({
          from: fromAddress,
          to,
          subject,
          html,
        });

        if (response.error) {
          throw new Error(`Resend API Error: ${response.error.message}`);
        }

        this.logger.log(`[Email Delivered] via Resend to ${to} (ID: ${response.data?.id})`);
        return { success: true, provider: 'resend', id: response.data?.id };
      } catch (err: any) {
        this.logger.warn(
          `[Email Fallback Triggered] Resend dispatch to ${to} failed: ${err.message}. Attempting SMTP fallback...`,
        );
      }
    }

    // 2. Attempt Fallback: Nodemailer (SMTP)
    if (this.smtpTransporter) {
      try {
        const fromAddress =
          this.configService.get<string>('SMTP_FROM') ||
          this.configService.get<string>('SMTP_USER') ||
          'Tark Protocol <noreply@tark.ng>';

        const info = await this.smtpTransporter.sendMail({
          from: fromAddress,
          to,
          subject,
          html,
        });

        this.logger.log(`[Email Delivered] via SMTP fallback to ${to} (MessageId: ${info.messageId})`);
        return { success: true, provider: 'smtp', id: info.messageId };
      } catch (err: any) {
        this.logger.error(`[Email Failed] SMTP fallback to ${to} also failed: ${err.message}`, err.stack);
      }
    }

    this.logger.error(`[Email Dropped] No email providers could deliver message to ${to}.`);
    return { success: false, provider: 'none' };
  }
}
