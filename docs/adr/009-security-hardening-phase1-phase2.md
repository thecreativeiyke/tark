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

---

## Amendment: Phase 3 Hardening & Defect Remediation (2026-11-11)

Following peer cross-check by Claude Desktop, the following deep architectural patches were applied and live-verified:

1. **Paystack Sandbox Guard**: Fake virtual accounts (`96xxxxxxx`) and sandbox checkout URLs are strictly restricted behind `PAYMENTS_SANDBOX_FALLBACK=true` outside production. Production calls throw a 502 Bad Gateway to prevent real customer transfers to simulated accounts.
2. **Atomic Wallet Funding (H-8)**: `PaymentsService.fundEscrowWithWallet()` locks `EscrowTransaction` first, re-verifies `INITIATED` status, acquires a row lock on `User`, debits balance, inserts `wdebit-${escrowId}` into `WalletLedger`, sets `fundedVia = 'WALLET'`, and locks funds inside a single atomic transaction.
3. **Webhook Money Retention**: Overpayments or late online payments on wallet-funded escrows are credited to the client's wallet with idempotent ledger references (`overpay-${ref}`, `unmatched-${ref}`) rather than dropped.
4. **Dispute Fee Enforcement (H-9)**: Platform service fee is strictly subtracted in integer kobo before distributing settlement funds across all verdicts (`FULL_REFUND`, `FULL_PAYOUT`, `SPLIT_SETTLEMENT`). Refunds write `dispute-refund-${dispute.id}` to `WalletLedger`.
5. **Fail-Closed Location Coarsening**: Commaless addresses default to "Exact location shared after assignment"; location field removed from public text search to eliminate oracle probing.
6. **Admin Role Enum Alignment**: Corrected uppercase string checks (`'ADMIN'`) to `UserRole.ADMIN` (`'admin'`).
7. **Payout Direct-Update Prevention**: Removed `payoutProvider`, `payoutAccountIdentifier`, and `payoutBankOrNetwork` from `UpdateProfileDto` to mandate verified onboarding via `/payments/bank/save`.

---

## Amendment: Phase 4 — Replay-Proof Online Funding (2026-11-11)

A cross-check of the Phase 3 webhook change found a defect in it, which was then fixed and regression-tested.

### Defect
Phase 3 amendment item 3 treated a webhook on an already-funded escrow as an idempotent replay only when `escrow.paystackReference === reference`. But `paystackReference` holds only the **most recent** checkout started: `initializePayment` overwrites it, and `GET /payments/pay-for-me/:escrowId` calls `initializePayment` on every request. Sequence that broke it:
1. Client initialises checkout (reference A), then opens Pay-For-Me (reference B overwrites `paystackReference`).
2. Client pays link A. The webhook resolves the escrow through the `tark-<escrowId>-` reference fallback and funds it.
3. The provider redelivers the webhook for A. A ≠ B, so it was treated as a second payment and credited to the client's wallet as `overpay-A`.

Net effect: a replayed funding webhook minted wallet balance equal to the escrow total.

### Decision
- New column `escrow_transaction.fundedReference` (varchar, nullable), set inside `lockFundsInTransaction` to the exact reference that funded the escrow (`null` for wallet funding). Migration: `scripts/migrate-phase4.js` (idempotent).
- `PaymentsService.handleAlreadyFundedEscrow` compares the incoming reference to `fundedReference`. Rows funded before this column existed have it `NULL` and fall back to the old `paystackReference` comparison; they are intentionally not backfilled, because the only available value is the unreliable one.
- Any other reference arriving on a funded escrow (a second checkout paid, or a payment after wallet funding) is credited to the client's wallet once, under the idempotent ledger key `overpay-${reference}`.
- The concurrent-delivery path (a parallel webhook losing the funding race) goes through the same check, so it also resolves to idempotent rather than a credit.

### Also changed
- `DisputesService.resolve` now computes `lockedMinor`, `feeMinor` and `distributableMinor` from the escrow row read **under** the `pessimistic_write` lock, not from a read taken before it.

### Verification
`scripts/test-dva-and-checkout.js` gained two regression steps, run against the live local server and Supabase:
- **6b**: replay of the exact funding webhook returns idempotent, `fundedReference` equals the paying reference, no `overpay-` row exists, wallet stays 0.
- **6c**: a different reference on the funded escrow credits the wallet exactly once (50,000); its own replay is ignored.

Step 6b reproduces the exact sequence that broke the pre-fix logic (replay of a reference that is no longer `paystackReference`). It was not run against the old build, so its failing-before behaviour is by reasoning, not observation.

### Corrections to earlier wording
- Phase 3 item 1 said sandbox **checkout URLs** are gated behind `PAYMENTS_SANDBOX_FALLBACK`. They are not: `initializePayment` has no sandbox branch and always calls the real gateway. The flag gates the simulated DVA, customer code, bank resolution and payout recipient.
- Phase 3 item 3 says overpayments are credited "rather than dropped". That holds for NGN only: a non-NGN payment on an already-funded escrow is still logged and ignored, not credited.

### Known limits (not addressed here)
- Verification uses a **simulated** DVA (`Paystack-Titan (Sandbox)`, `96…` account numbers) and webhooks signed locally with the project's own secret. It proves the handler's logic, not real Paystack DVA provisioning or real webhook delivery. A test-key run against a public staging URL is still outstanding.
- In `DisputesService.resolve` the artisan Paystack transfer is sent before the DB transaction commits. A later failure rolls the DB back but not the transfer. The fixed reference `tark-dispute-${id}` makes a retry safe from a double payout.

---

## Amendment: Phase 5 — Upload Magic-Byte Binary Inspection & Filename Normalization (2026-11-12)

### Context & Threat Model
Upload endpoints (`/media/upload`, `/media/proof-of-work`, `/media/job-diagnostics`, `/media/avatar`) previously filtered files using client-supplied MIME headers and multer extensions. An adversary could upload arbitrary hostile payloads (PHP shells, HTML/JS stored XSS, script-bearing SVGs, Windows/ELF executables) with spoofed headers (e.g. `image/png`).

### Decision
1. **Magic-Byte Signature Inspection (`src/media/file-signature.ts`)**:
   - Inspects the leading binary header bytes of all uploaded buffers.
   - Whitelists only approved binary formats:
     - Images: JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`), WebP (`RIFF...WEBP`), HEIC (`ftypheic`, `ftypmif1`).
     - Videos: MP4 (`ftypisom`, `ftypmp42`), MOV (`ftypqt`), WebM (`1A 45 DF A3`).
   - Rejects all other formats including HTML, SVG, PHP, executables (MZ, ELF), ZIPs, GIFs, and AVIFs.
2. **Family & Intent Cross-Validation**:
   - Compares detected binary type against claimed category (e.g. MP4 cannot masquerade as `image/png`).
   - Avatar uploads strictly require an image family.
3. **Atomic Batch Inspection**:
   - Multi-file uploads (e.g. Proof of Work) validate all buffers before dispatching any to Cloudflare R2, ensuring no orphan files are left on rejected batches.
4. **Filename Normalization & Path Traversal Neutralization**:
   - `safeFilename()` strips directory traversal sequences (`../`, `..\`) and neutralizes double extensions (e.g. `shell.php.png` -> sanitized safe stem + detected extension).

### Verification
- `scripts/test-upload-magic-bytes.js`:
  - **Part A (Offline Detector)**: 9 accepted formats, 14 rejected formats, filename sanitization.
  - **Part B (Live Hostile Exploitation)**: 11 attack vectors tested against live endpoints (HTML disguised as PNG, PHP disguised as JPEG, EXE disguised as PNG, batch with one fake, unauthenticated uploads) — 41/41 checks passed.

---

## Amendment: Phase 6 — KYC Document & Selfie URL Shield (2026-11-12)

### Context
`POST /kyc/submit` accepts `documentUrl` and `selfieUrl`. Without server-side URL validation, an artisan could submit hostile external links (`https://evil-attacker.com/doc.png`) or spoofed phishing domains, causing internal compliance viewers or administrative reviewers to fetch external untrusted content.

### Decision
- Implemented `validateKycUrls()` in `src/kyc/kyc.service.ts`.
- Validates that both `documentUrl` and `selfieUrl` are valid HTTPS URLs whose parsed `origin` and `pathname` strictly match the configured Tark Cloudflare CDN gateway base (`STORAGE_CUSTOM_CDN_URL` or default `https://iyke-storage-gateway.iyke-storage-gateway.workers.dev/cdn`).
- Submissions with non-Tark CDN domains or spoofed hostnames are rejected with `400 Bad Request`.

### Verification
- `scripts/test-kyc-url-validation.js` verified live against the server and database:
  - Hostile external document URL rejected (400)
  - Hostile external selfie URL rejected (400)
  - Spoofed CDN domain rejected (400)
  - Legitimate Tark CDN URL accepted (201)

---

## Amendment: Phase 7 — Two-Phase Decoupled Payout State Machine & Sweeper (2026-11-12)

### Context & Flaw in Previous Implementation
In the previous implementation (`7ae6dfb`), external calls to `PaystackGateway.initiateTransfer()` were executed inside the database transaction holding row locks. Consequently:
1. Provider timeouts or network drops rolled back the database transaction, losing the record that a transfer had been requested.
2. Late incoming `transfer.success` webhooks could not match any `PAYOUT_PENDING` record.
3. Paystack's initial response can be `pending` or `otp` (meaning funds have not yet left); treating non-throwing initiation as settled caused premature job completion.

### Decision
1. **Two-Phase Decoupled Commit**:
   - **Phase 1 (In Lock)**: Acquires pessimistic write lock on `EscrowTransaction`, sets `trancheStatus` to `PAYOUT_PENDING`, records a deterministic transfer reference (`tark-t1-<id>` or `tark-t2-<id>`), and commits immediately.
   - **External Gateway Call (Out of Lock)**: Calls Paystack outside the database lock, preventing connection pool exhaustion and database freeze during third-party latency.
   - **Phase 2 (In Lock)**: Applies outcome via centralized `applyTransferOutcome()` based on verified Paystack status:
     - `success` -> marks tranche `RELEASED`, settles escrow / completes job if final.
     - `pending` / `otp` / unknown timeout -> leaves tranche `PAYOUT_PENDING` for webhook or sweeper reconciliation.
     - `failed` / definitive provider rejection -> marks tranche `PAYOUT_FAILED`, allowing safe retry with incremented reference (`tark-t1-<id>-r1`).
2. **Reconciliation Sweeper**:
   - Periodic sweeper queries `PAYOUT_PENDING` tranches stuck beyond threshold and invokes `verifyTransfer()` to reconcile status.
3. **Transfer Webhook Handlers**:
   - `transfer.success`, `transfer.failed`, and `transfer.reversed` routed through `applyTransferOutcome()`.
   - Late `transfer.failed` webhooks on already settled escrows are ignored (idempotent).
4. **Database Migration**:
   - `scripts/migrate-payout-states.js` added `PAYOUT_PENDING` and `PAYOUT_FAILED` to PostgreSQL tranche status enums.

### Verification
- Tested via `scripts/test-payout-two-phase.js` using local Paystack stub simulating provider delay, timeout, OTP, failure, and sweeper resolution.

---

## Amendment: Phase 8 — Authentication Lifecycle, Session Revocation & Timing Attack Hardening (2026-11-14)

### Context
Security review identified gaps in user identity and session lifecycle:
1. Missing forgot-password, reset-password, and change-password flows.
2. User account enumeration via timing differences between registered and non-registered emails.
3. Absence of JWT token revocation: demoted admins, banned users, or accounts after password reset maintained valid token access until JWT expiry.
4. Case-sensitivity collision: registering variations of existing emails (e.g. `Test@tark.ng` vs `test@tark.ng`).

### Decision
1. **Cryptographic Token Hashing for Password Reset**:
   - `POST /auth/forgot-password` generates a 32-byte cryptographic random hex token.
   - Computes SHA-256 hash and stores `passwordResetTokenHash` and `passwordResetExpiresAt` (30 minutes) on the `"user"` table.
   - Raw token is delivered out-of-band via notifications (email link); database leak does not expose valid reset tokens.
   - Single-use: `POST /auth/reset-password` clears the token hash and expiry to `NULL`.
2. **Non-Enumerating Constant-Time Responses**:
   - `POST /auth/forgot-password` returns the exact same success message whether the email exists or not.
   - `AuthService.login()` runs `bcrypt.compare` against a constant dummy hash for non-existent emails, preventing timing-based account discovery.
3. **Stateful Session Revocation via `tokenVersion`**:
   - Added `tokenVersion INT DEFAULT 0` to `"user"`.
   - Included `tv: tokenVersion` in JWT payloads.
   - `JwtStrategy.validate()` verifies `payload.tv === user.tokenVersion`.
   - Both `resetPassword` and `changePassword` increment `tokenVersion`, instantly revoking all active JWT sessions across devices.
4. **Case-Insensitive Email Collision Shield**:
   - Case normalization at DTO (`@Transform`) and query layers (`LOWER(email)`).
   - Created unique functional index in PostgreSQL: `CREATE UNIQUE INDEX idx_user_lower_email ON "user" (LOWER(email))`.
5. **Database Migrations**:
   - `scripts/migrate-auth-hardening.js`: added columns, normalized emails, created unique lowercase index.
   - `scripts/migrate-notification-password-reset.js`: added `PASSWORD_RESET` to `notifications_type_enum`.

### Verification
- `scripts/test-auth-lifecycle.js`:
  - Step 1: Lowercase registration & JWT validation on `/auth/me` (201).
  - Step 2: Uppercase email registration collision blocked (409 Conflict).
  - Step 3: Forgot-password non-enumeration check (identical responses for existing and non-existent accounts).
  - Step 4: Verification of 64-character SHA-256 hash and 30-minute expiry in PostgreSQL.
  - Step 5: Rejection of invalid and expired tokens (400 Bad Request).
  - Step 6: Valid password reset, token cleared from DB, and replay attack blocked.
  - Step 7: Pre-reset JWT rejected on `/auth/me` with 401 Unauthorized (`tokenVersion` mismatch).
  - Step 8: Login with old password rejected (401), login with new password succeeds (201).
  - Step 9: Authenticated change-password rejecting wrong current password (401), succeeding with correct password, and revoking prior JWT.
  - 100% of tests passed.

