import { renderEmailLayout, escapeHtml as esc } from './email-layout.template';

export interface EmailRenderResult {
  subject: string;
  html: string;
}

const ngn = (val: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(val);

// NOTE ON ESCAPING: every value that a user can type (names, job titles, dispute text)
// is passed through esc() before it goes into the HTML body. Subjects are plain text
// (not HTML), so they use the raw value; the email channel strips line breaks from them.

export const EmailTemplates = {
  /**
   * 1. Bid Received (Sent to Client when an artisan submits an offer)
   */
  bidReceived(data: {
    clientName: string;
    artisanName: string;
    jobTitle: string;
    bidAmount: number;
    completionTimeDays?: number;
    viewBidUrl?: string;
  }): EmailRenderResult {
    const formattedAmount = ngn(data.bidAmount);
    const clientName = esc(data.clientName);
    const artisanName = esc(data.artisanName);
    const jobTitle = esc(data.jobTitle);

    const bodyHtml = `
      <p style="margin: 0 0 16px 0;">Hello ${clientName},</p>
      <p style="margin: 0 0 20px 0;">
        Artisan <strong style="color: #FFFFFF;">${artisanName}</strong> just placed a bid on your job:
        <span style="color: #10B981; font-weight: 600;">"${jobTitle}"</span>.
      </p>

      <div style="background-color: #0F1420; border: 1px solid #232B3B; border-radius: 10px; padding: 20px; margin: 20px 0;">
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color: #94A3B8; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 6px;">Bid Amount</td>
            <td align="right" style="color: #10B981; font-size: 20px; font-weight: 800; padding-bottom: 6px;">${formattedAmount}</td>
          </tr>
          ${
            data.completionTimeDays
              ? `<tr>
                  <td style="color: #94A3B8; font-size: 13px; padding-top: 8px; border-top: 1px solid #1E2738;">Est. Delivery</td>
                  <td align="right" style="color: #F8FAFC; font-size: 14px; font-weight: 600; padding-top: 8px; border-top: 1px solid #1E2738;">${Number(data.completionTimeDays)} Day(s)</td>
                </tr>`
              : ''
          }
        </table>
      </div>

      <p style="margin: 0 0 12px 0; font-size: 14px; color: #94A3B8;">
        Accepting this bid will automatically generate a Tark Safe-Lock escrow session to protect your funds until the work is completed and verified.
      </p>
    `;

    return {
      subject: `New Bid from ${data.artisanName} on "${data.jobTitle}"`,
      html: renderEmailLayout({
        title: `New Bid Submitted`,
        previewText: `${data.artisanName} placed a bid of ${formattedAmount} on "${data.jobTitle}".`,
        bodyHtml,
        actionUrl: data.viewBidUrl || `https://tark.ng/jobs`,
        actionText: `Review & Compare Bids`,
      }),
    };
  },

  /**
   * 2. Safe-Lock Funded (Sent to Artisan when client locks escrow)
   */
  safeLockFunded(data: {
    artisanName: string;
    clientName: string;
    jobTitle: string;
    totalBudget: number;
    tranche1Amount: number;
    actionUrl?: string;
  }): EmailRenderResult {
    const artisanName = esc(data.artisanName);
    const clientName = esc(data.clientName);
    const jobTitle = esc(data.jobTitle);

    const bodyHtml = `
      <p style="margin: 0 0 16px 0;">Hello ${artisanName},</p>
      <p style="margin: 0 0 20px 0;">
        Great news! Client <strong style="color: #FFFFFF;">${clientName}</strong> has deposited and locked the full project budget in Tark Safe-Lock for:
        <span style="color: #10B981; font-weight: 600;">"${jobTitle}"</span>.
      </p>

      <div style="background-color: #0F1420; border: 1px solid #232B3B; border-radius: 10px; padding: 20px; margin: 20px 0;">
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color: #94A3B8; font-size: 13px; text-transform: uppercase;">Total Safe-Lock Escrow</td>
            <td align="right" style="color: #F8FAFC; font-size: 16px; font-weight: 700;">${ngn(data.totalBudget)}</td>
          </tr>
          <tr>
            <td style="color: #94A3B8; font-size: 13px; text-transform: uppercase; padding-top: 10px; border-top: 1px solid #1E2738;">Start-Work Mobilization</td>
            <td align="right" style="color: #10B981; font-size: 18px; font-weight: 800; padding-top: 10px; border-top: 1px solid #1E2738;">${ngn(data.tranche1Amount)}</td>
          </tr>
        </table>
      </div>

      <p style="margin: 0 0 12px 0; font-size: 14px; color: #94A3B8;">
        The client's money is held safely by Tark. You may now reach out to coordinate the work schedule and site arrival.
      </p>
    `;

    return {
      subject: `Safe-Lock Escrow Secured: "${data.jobTitle}"`,
      html: renderEmailLayout({
        title: `Safe-Lock Escrow Funded`,
        previewText: `Funds are secured. Start-Work Mobilization is ready for "${data.jobTitle}".`,
        bodyHtml,
        actionUrl: data.actionUrl || `https://tark.ng/jobs`,
        actionText: `View Active Job`,
      }),
    };
  },

  /**
   * 3. Tranche 1 Released (Start-Work Mobilization sent to the artisan's bank account)
   */
  tranche1Released(data: {
    recipientName: string;
    jobTitle: string;
    amount: number;
    actionUrl?: string;
  }): EmailRenderResult {
    const formattedAmount = ngn(data.amount);
    const recipientName = esc(data.recipientName);
    const jobTitle = esc(data.jobTitle);

    const bodyHtml = `
      <p style="margin: 0 0 16px 0;">Hello ${recipientName},</p>
      <p style="margin: 0 0 20px 0;">
        The <strong style="color: #10B981;">Start-Work Mobilization (${formattedAmount})</strong> for job
        <strong style="color: #FFFFFF;">"${jobTitle}"</strong> has been sent to your bank account.
        Depending on your bank, it can take a few minutes to show.
      </p>
      <p style="margin: 0 0 12px 0; font-size: 14px; color: #94A3B8;">
        Work is officially in progress. Remember to document progress with before-and-after photos via the app.
      </p>
    `;

    return {
      subject: `Start-Work Mobilization Sent: ${formattedAmount}`,
      html: renderEmailLayout({
        title: `Mobilization Sent`,
        previewText: `${formattedAmount} sent to your bank account for "${data.jobTitle}".`,
        bodyHtml,
        actionUrl: data.actionUrl || `https://tark.ng/jobs`,
        actionText: `View Job`,
      }),
    };
  },

  /**
   * 4. Handshake Ready / Completion Code Generated (Sent to Client)
   * The code is 6 digits (see EscrowService.initiateHandshake).
   */
  handshakeReady(data: {
    clientName: string;
    artisanName: string;
    jobTitle: string;
    handshakePin: string;
    actionUrl?: string;
  }): EmailRenderResult {
    const clientName = esc(data.clientName);
    const artisanName = esc(data.artisanName);
    const jobTitle = esc(data.jobTitle);
    const pin = esc(data.handshakePin);

    const bodyHtml = `
      <p style="margin: 0 0 16px 0;">Hello ${clientName},</p>
      <p style="margin: 0 0 20px 0;">
        Artisan <strong style="color: #FFFFFF;">${artisanName}</strong> has submitted proof of work and marked
        <strong style="color: #FFFFFF;">"${jobTitle}"</strong> as completed.
      </p>

      <div style="background-color: #0F1420; border: 2px solid #F59E0B; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
        <span style="display: block; color: #94A3B8; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">
          Your 6-Digit Job Completion Code
        </span>
        <span style="font-size: 36px; font-weight: 900; letter-spacing: 10px; color: #F59E0B; font-family: monospace;">
          ${pin}
        </span>
      </div>

      <div style="background-color: rgba(245, 158, 11, 0.08); border-left: 3px solid #F59E0B; padding: 12px 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; font-size: 13px; color: #FCD34D;">
          ⚠️ <strong>Security Rule:</strong> Inspect the completed work in person before sharing this code. Once the artisan enters this code in their app, the final payment is released and cannot be undone. The code expires in 15 minutes.
        </p>
      </div>
    `;

    return {
      subject: `Job Completion Code Ready: "${data.jobTitle}"`,
      html: renderEmailLayout({
        title: `Job Completion Code`,
        previewText: `Inspect the work and, only if you are satisfied, share your 6-digit code to finalize "${data.jobTitle}".`,
        bodyHtml,
        actionUrl: data.actionUrl || `https://tark.ng/jobs`,
        actionText: `Inspect Proof-of-Work`,
      }),
    };
  },

  /**
   * 5. Payout Settled (Sent to Artisan on final payout)
   */
  payoutSettled(data: {
    artisanName: string;
    jobTitle: string;
    disbursedAmount: number;
    platformFeeAmount: number;
    totalJobBudget: number;
    accountMasked?: string;
    actionUrl?: string;
  }): EmailRenderResult {
    const artisanName = esc(data.artisanName);
    const jobTitle = esc(data.jobTitle);
    const accountMasked = data.accountMasked ? esc(data.accountMasked) : '';

    const bodyHtml = `
      <p style="margin: 0 0 16px 0;">Hello ${artisanName},</p>
      <p style="margin: 0 0 20px 0;">
        Completion code verified! Your final payment for <strong style="color: #FFFFFF;">"${jobTitle}"</strong> has been settled and sent.
      </p>

      <div style="background-color: #0F1420; border: 1px solid #232B3B; border-radius: 10px; padding: 20px; margin: 20px 0;">
        <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color: #94A3B8; font-size: 13px;">Total Job Budget</td>
            <td align="right" style="color: #F8FAFC; font-size: 14px; font-weight: 600;">${ngn(data.totalJobBudget)}</td>
          </tr>
          <tr>
            <td style="color: #94A3B8; font-size: 13px; padding-top: 8px;">Tark Service Fee</td>
            <td align="right" style="color: #EF4444; font-size: 14px; font-weight: 600; padding-top: 8px;">-${ngn(data.platformFeeAmount)}</td>
          </tr>
          <tr>
            <td style="color: #94A3B8; font-size: 14px; font-weight: 700; padding-top: 12px; border-top: 1px solid #1E2738;">Final Payment Sent</td>
            <td align="right" style="color: #10B981; font-size: 20px; font-weight: 800; padding-top: 12px; border-top: 1px solid #1E2738;">${ngn(data.disbursedAmount)}</td>
          </tr>
        </table>
      </div>

      ${
        accountMasked
          ? `<p style="font-size: 13px; color: #94A3B8; margin: 0 0 12px 0;">Sent to your bank account ending in <strong>${accountMasked}</strong>.</p>`
          : ''
      }
    `;

    return {
      subject: `Payment Sent: ${ngn(data.disbursedAmount)} for "${data.jobTitle}"`,
      html: renderEmailLayout({
        title: `Final Payment Sent`,
        previewText: `${ngn(data.disbursedAmount)} sent to your bank account.`,
        bodyHtml,
        actionUrl: data.actionUrl || `https://tark.ng/jobs`,
        actionText: `View Job`,
      }),
    };
  },

  /**
   * 6. Dispute Updates (Tark Resolution Desk)
   */
  disputeUpdate(data: {
    recipientName: string;
    jobTitle: string;
    disputeReason: string;
    status: string;
    resolutionNotes?: string;
    actionUrl?: string;
  }): EmailRenderResult {
    const recipientName = esc(data.recipientName);
    const jobTitle = esc(data.jobTitle);
    const status = esc(data.status);
    const reason = esc(data.disputeReason);
    const notes = data.resolutionNotes ? esc(data.resolutionNotes) : '';

    const bodyHtml = `
      <p style="margin: 0 0 16px 0;">Hello ${recipientName},</p>
      <p style="margin: 0 0 20px 0;">
        There is an official update regarding the Tark Resolution Desk ticket on:
        <strong style="color: #FFFFFF;">"${jobTitle}"</strong>.
      </p>

      <div style="background-color: #0F1420; border-left: 3px solid #3B82F6; border-radius: 6px; padding: 16px 20px; margin: 20px 0;">
        <p style="margin: 0 0 6px 0; font-size: 12px; color: #94A3B8; text-transform: uppercase;">Current Status</p>
        <p style="margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #60A5FA;">${status}</p>

        <p style="margin: 0 0 6px 0; font-size: 12px; color: #94A3B8; text-transform: uppercase;">Issue Summary</p>
        <p style="margin: 0; font-size: 14px; color: #CBD5E1;">"${reason}"</p>
      </div>

      ${
        notes
          ? `<div style="background-color: #121824; border: 1px solid #1F2737; border-radius: 8px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0 0 4px 0; font-size: 12px; color: #94A3B8; font-weight: 600;">Resolution Verdict Notes:</p>
              <p style="margin: 0; font-size: 14px; color: #E2E8F0;">${notes}</p>
            </div>`
          : ''
      }
    `;

    return {
      subject: `Tark Resolution Desk Update: "${data.jobTitle}"`,
      html: renderEmailLayout({
        title: `Resolution Desk Notice`,
        previewText: `Status update: ${data.status} for "${data.jobTitle}".`,
        bodyHtml,
        actionUrl: data.actionUrl || `https://tark.ng/disputes`,
        actionText: `Open Case`,
      }),
    };
  },
};
