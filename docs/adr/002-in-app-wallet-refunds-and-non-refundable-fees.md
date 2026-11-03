# ADR 002: In-App Wallet Client Refunds & Non-Refundable Protocol Fee

## Status
**ACCEPTED** (2026-10-31)

## Context
When a dispute arises between a client and an artisan, arbitration verdicts may require returning funds to the client (e.g. `FULL_REFUND_TO_CLIENT` or `SPLIT_SETTLEMENT`).

Two critical risks exist with external bank card refunds:
1. **Chargeback / Reversal Double-Loss**: External card reversals via Paystack can take 5–10 business days and expose Tark to card dispute disputes where funds leave Tark twice.
2. **Platform Solvency**: Operational costs, payment gateway transaction charges, SMS alerts, and AI compute are consumed immediately upon contract creation. If platform service fees were refunded, Tark would operate at a direct financial loss on every disputed job.

## Decision
1. **Wallet-Only Client Refunds**:
   - Any refund awarded to a client from Safe-Lock is credited **strictly and exclusively to their in-app Tark wallet (`user.walletBalance`)**.
   - No automated or direct external bank account transfers or card charge reversals are permitted for client refunds.
   - The client can immediately use these wallet funds to hire another artisan on Tark with zero extra funding steps.
2. **Non-Refundable Protocol Service Fee**:
   - The platform service fee (e.g. 5% of total budget) is **strictly non-refundable** under all dispute verdicts (`FULL_REFUND_TO_CLIENT`, `MUTUAL_CANCELLATION`, etc.).
   - The maximum refundable sum to the client is `job.budget - platformFeeAmount`.

## Consequences & Guardrails
- **Zero External Refund Routes**: There must never be an API route that sends escrow dispute refunds directly to a client's bank account or initiates Paystack card chargebacks.
- **Pessimistic Locking on Wallets**: Since wallets hold real redeemable value, all wallet deductions (`POST /payments/fund-with-wallet`) must use `setLock('pessimistic_write')` within an atomic database transaction.
- **User Terms Transparency**: The client must be informed in the app UI during checkout that platform fees are non-refundable and refunds are credited to the Tark wallet.
