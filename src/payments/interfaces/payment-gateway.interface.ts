export interface InitializePaymentParams {
  escrowId: string;
  email: string;
  amountMinor: number; // Kobo, Cents, Pesewas (standard integer units)
  currency: string;
  metadata?: Record<string, any>;
}

export interface InitializePaymentResult {
  authorizationUrl: string;
  reference: string;
  rawResponse?: any;
}

export interface ResolveAccountResult {
  accountName: string;
  accountNumber: string;
  routingCode: string;
}

export interface TransferPayoutParams {
  amountMinor: number;
  currency: string;
  recipientCode: string;
  reason: string;
  // Unique, deterministic reference so the provider rejects a duplicate payout
  // for the same escrow tranche (idempotency).
  reference?: string;
}

export interface TransferPayoutResult {
  status: string;
  reference?: string;
  simulated?: boolean;
  rawResponse?: any;
}

// Thrown by a gateway when a transfer request did not come back with a usable answer.
//  REJECTED: the provider answered with a definitive error, so NO transfer was created.
//  UNKNOWN:  timeout / 5xx / network failure, so a transfer MAY have been created.
export class TransferDispatchError extends Error {
  constructor(
    message: string,
    public readonly outcome: 'REJECTED' | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'TransferDispatchError';
  }
}

export interface VerifyTransferResult {
  found: boolean;
  status?: string;
  reference?: string;
  amountMinor?: number;
}

export interface IPaymentGateway {
  readonly providerName: string;
  supportsCurrency(currency: string): boolean;
  initializePayment(params: InitializePaymentParams): Promise<InitializePaymentResult>;
  resolveAccount?(accountNumber: string, routingCode: string): Promise<ResolveAccountResult>;
  createRecipient(name: string, identifier: string, routingCode?: string, currency?: string): Promise<string>;
  initiateTransfer(params: TransferPayoutParams): Promise<TransferPayoutResult>;
  // Looks a transfer up by our reference. Needed to retry payouts safely (never pay twice).
  verifyTransfer?(reference: string): Promise<VerifyTransferResult>;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  handleWebhookEvent(event: any): Promise<any>;
}
