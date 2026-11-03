export const SmsTemplates = {
  bidReceived(artisanName: string, jobTitle: string, amount: number): string {
    const formatted = new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      maximumFractionDigits: 0,
    }).format(amount);
    return `Tark Alert: ${artisanName} placed a bid of ${formatted} on "${jobTitle}". Review offers in your Tark app.`;
  },

  safeLockFunded(jobTitle: string, tranche1Amount: number): string {
    const formatted = new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      maximumFractionDigits: 0,
    }).format(tranche1Amount);
    return `Tark Safe-Lock: Project budget locked for "${jobTitle}". Start-Work Mobilization of ${formatted} is secured.`;
  },

  handshakePin(handshakePin: string, jobTitle: string): string {
    return `Tark Security PIN: Your 4-digit Job Completion Code for "${jobTitle}" is ${handshakePin}. Share ONLY after physical inspection.`;
  },

  payoutSettled(amount: number, jobTitle: string): string {
    const formatted = new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      maximumFractionDigits: 0,
    }).format(amount);
    return `Tark Payout: Final payment of ${formatted} for "${jobTitle}" has been disbursed to your account.`;
  },

  disputeNotice(jobTitle: string, status: string): string {
    return `Tark Resolution Desk: Update on "${jobTitle}". Status is now: ${status}. Check your app for full details.`;
  },
};
