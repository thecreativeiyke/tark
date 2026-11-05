// User-supplied text (names, job titles) ends up inside SMS sent from Tark's sender.
// Strip anything that looks like a link and cap the length so nobody can use a Tark
// SMS to deliver a phishing message.
function clean(text: string, max = 40): string {
  const noLinks = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return noLinks.length > max ? `${noLinks.slice(0, max - 1)}…` : noLinks;
}

function naira(amount: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(amount);
}

export const SmsTemplates = {
  bidReceived(artisanName: string, jobTitle: string, amount: number): string {
    return `Tark Alert: ${clean(artisanName, 30)} placed a bid of ${naira(amount)} on "${clean(jobTitle)}". Review offers in your Tark app.`;
  },

  safeLockFunded(jobTitle: string, tranche1Amount: number): string {
    return `Tark Safe-Lock: Project budget locked for "${clean(jobTitle)}". Start-Work Mobilization of ${naira(tranche1Amount)} is secured.`;
  },

  handshakeReady(jobTitle: string): string {
    // The code itself is deliberately NOT in the SMS: SMS previews show on lock screens, and the
    // artisan is usually standing next to the client when this arrives. The client reads the
    // code inside the authenticated app only.
    return `Tark Security: "${clean(jobTitle)}" was marked complete. Inspect the work in person, then open Tark to get your Job Completion Code. Never share it before inspecting.`;
  },

  tranche1Released(amount: number, jobTitle: string): string {
    return `Tark Alert: Start-Work Mobilization of ${naira(amount)} for "${clean(jobTitle)}" has been sent to your bank account.`;
  },

  payoutSettled(amount: number, jobTitle: string): string {
    return `Tark Payout: Final payment of ${naira(amount)} for "${clean(jobTitle)}" has been sent to your bank account.`;
  },

  disputeNotice(jobTitle: string, status: string): string {
    return `Tark Resolution Desk: Update on "${clean(jobTitle)}". Status is now: ${clean(status, 60)}. Check your app for full details.`;
  },
};
