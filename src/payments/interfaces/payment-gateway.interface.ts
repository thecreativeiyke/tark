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
}

export interface TransferPayoutResult {
  status: string;
  reference?: string;
  simulated?: boolean;
  rawResponse?: any;
}

export interface IPaymentGateway {
  readonly providerName: string;
  supportsCurrency(currency: string): boolean;
  initializePayment(params: InitializePaymentParams): Promise<InitializePaymentResult>;
  resolveAccount?(accountNumber: string, routingCode: string): Promise<ResolveAccountResult>;
  createRecipient(name: string, identifier: string, routingCode?: string, currency?: string): Promise<string>;
  initiateTransfer(params: TransferPayoutParams): Promise<TransferPayoutResult>;
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  handleWebhookEvent(event: any): Promise<any>;
}
