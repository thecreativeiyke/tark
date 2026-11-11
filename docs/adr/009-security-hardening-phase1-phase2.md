# ADR 009: Security Hardening & Zero-Trust Defense (Phase 1 & Phase 2)

## Status
**ACCEPTED** (2026-11-11)

## Context
Following a dual-agent offensive security review (destructive static penetration audit by Claude Desktop and active live-payload verification by Antigravity), multiple high-severity vulnerabilities were identified across Tark's core financial and identity operations:
1. **Financial Sinks (C-1..C-3)**: Webhook double-spend on wallet credits, handshake PIN brute-force without cooldown across reset cycles, and floating-point decimal slop / non-compliant mobilization splits on bids.
2. **Authorization & IDOR (H-1..H-4, H-12)**: Unauthenticated exposure of artisan contact details and exact coordinates; unauthenticated exposure of clients' private home addresses in job listings; horizontal privilege escalation on bid inspection; leakage of bcrypt password hashes in user endpoints; and BOLA in AI support context loading.
3. **Audit Cross-Check Defects (P-1..P-6)**: Exponential PIN lockout incorrectly penalizing honest expiries; unvalidated webhook payloads (NaN amounts, missing references); unvalidated `acceptBid` tranche rules; and missing ledger records for wallet debits.

## Decision

### 1. Webhook Deduplication & Financial Idempotency (C-1, P-2)
- Created `wallet_ledgers` table with a `UNIQUE` constraint on `reference`.
- `PaymentsService.handleWebhook`:
  - Validates payload: `reference` (non-empty string), `amountMinor` (safe integer > 0), `status === 'success'`, and `currency === 'NGN'`.
  - For wallet deposits: acquires a `pessimistic_write` row lock on `User`, inserts a `WalletLedger` row of type `CREDIT`, and adds balance in an atomic transaction. Catches PostgreSQL unique violation error code `23505` to return idempotent 200/201 responses without duplicate credits.
  - Escrow deposit matching: validates that incoming webhook amount and currency exactly equal the escrow total.

### 2. Handshake PIN Lockout & Expired PIN Resilience (C-2, P-1)
- Handshake cycle tracking via `handshakeCycles` (int, default 0) and `handshakeLockedUntil` (timestamptz) on `EscrowTransaction`.
- Differentiated reset logic: `resetHandshake(escrow, opts = { penalize: false })`.
  - **Honest Expiry (15 minutes)**: resets PIN and attempts with `penalize: false`, allowing the artisan or client to restart immediately without penalty.
  - **5 Failed Attempts**: invokes `resetHandshake` with `penalize: true`, incrementing `handshakeCycles` and setting exponential lockout:
    $$\text{cooldown} = \min(15 \times 2^{n-1}, 1440) \text{ minutes}$$
  - `initiateHandshake` strictly checks `handshakeLockedUntil > new Date()`, blocking adversary attempts to bypass the lockout.
  - If `handshakeCycles >= 3`, a security warning is logged for administrative/dispute review.

### 3. Integer Kobo Tranche Split Policy (C-3, P-3)
- Created centralized policy engine `src/escrow/escrow-policy.ts` using integer kobo conversions (`toMinorUnits`).
- Tranche 1 (Start-Work Mobilization) must strictly be between 30% and 50% of the total bid amount:
  $$\text{tranche1Minor} + \text{tranche2Minor} = \text{totalMinor}$$
- `BidsService.acceptBid()` re-validates tranche compliance at acceptance time, preventing legacy or tampered bids from slipping through.

### 4. Wallet Debit Auditability & Database Integrity (P-6, DB Constraints)
- `PaymentsService.fundEscrowWithWallet()` writes a `WalletLedger` row of type `DEBIT` inside the atomic deduction transaction.
- Added database CHECK constraint on `"user"`:
  ```sql
  ALTER TABLE "user" ADD CONSTRAINT wallet_sane CHECK ("walletBalance" >= 0 AND "walletBalance" <> 'NaN'::numeric);
  ```

### 5. Identity, Location & PII Hardening (H-1, H-2, H-3, H-4, H-12)
- **Artisan Privacy (`H-1`)**: `GET /users/artisans/nearby` is protected by `JwtAuthGuard` and rate-limited to 30 req/min. Strips `email`, `phoneNumber`, `latitude`, `longitude`, returning only verified artisans (`isCertifiedByTark = true`) with distance rounded to 1 decimal place.
- **Job Location Coarsening (`H-2`)**: `GET /jobs` and `GET /jobs/:id` use `OptionalJwtAuthGuard`. For anonymous users and non-owners, `address` is truncated to city/state (last 2 segments) and coordinates are stripped (`null`). Full address is revealed only to job owners, admins, or assigned artisans on active/completed jobs.
- **Bid Access Scoping (`H-3`)**: `GET /bids/job/:jobId` and `GET /bids/:id` protected by `JwtAuthGuard`. Clients view bids on their jobs; artisans view only their own bids; admins view all.
- **Password Hash Redaction (`H-4`)**: `User.password` entity column marked `@Column({ select: false })`. `UsersService.findByEmail()` explicitly uses `.addSelect('user.password')` solely for authentication verification.
- **Support AI BOLA Defense (`H-12`)**: `SupportService.buildUserContext()` validates that the caller is a party to the referenced job/escrow or an admin before including details in the AI prompt context.

## Consequences & Guardrails
- All schema additions (`handshakeCycles`, `handshakeLockedUntil`, `feeCollectedMinor`, `wallet_ledgers`) must be documented in versioned migration scripts.
- Every future financial endpoint or state transition MUST be accompanied by an executable red-team penetration script verifying adversarial scenarios (double-spend, race condition, replay, rounding attack).
- Active test suites `scripts/redteam-active-hack-phase1.js` and `scripts/redteam-active-hack-phase2.js` serve as continuous regression gates.
