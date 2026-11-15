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

---

## Amendment: Phase 9 — Audit of the Uncommitted Hardening Pass & Corrections to Earlier Wording (2026-11-14)

**Status of this amendment: ACTIVE.** Written from a read-only audit of the working tree (files modified after commit `bedeca7`), then remediated in the Phase 1 finishing pass recorded in "Remediation applied" below. The audit findings and corrections stay as written; items that are now fixed are marked in "Known limits". Verification of the remediation edits is tracked in the Verification section.

### Corrections to earlier wording

1. **Payout reference names (Phase 7; DEV_TIMELINE Session 13).** Those texts say `tark-t1-<id>` / `tark-t2-<id>`. The code uses `tark-t1-<escrowId>` for Tranche 1 and `tark-final-<escrowId>` for the final settlement (any unpaid Tranche 1 plus Tranche 2, minus the platform fee). A retry after a conclusive failure appends `-r1`, `-r2`, and so on. There is no `tark-t2-` reference. Dispute payouts use `tark-dispute-<disputeId>`, which `applyTransferOutcome` does not match (see Known limits).

2. **The wallet ledger is single-entry, not double-entry (Phase 1 §1 and §4; Phase 3 item 3).** `wallet_ledgers` is a per-wallet journal. Each row has a UNIQUE `reference` (the idempotency key), `userId`, `amount`, and a `type`. It has no counter-account and no `balanceAfter`. It does not record online escrow funding (the `ESCROW_FUNDING` enum value has no writer in `payments.service.ts` or `escrow.service.ts`; confirm with `git grep ESCROW_FUNDING`), tranche payouts, retained platform fees (`feeCollectedMinor` lives on `escrow_transaction`) or dispute payouts to artisans. "Append-only" is a convention, not a database rule (no trigger blocks UPDATE or DELETE). `wallet_sane` keeps a balance non-negative and not NaN; nothing enforces that `walletBalance` equals the sum of its ledger rows. Read "wallet debit auditability" as "wallet credits and debits are idempotent and traceable", not as a complete financial audit trail.

3. **Upload inspection is header-only (Phase 5).** `detectFileType` proves a file starts like a JPEG, PNG, WebP, HEIC, MP4, MOV or WebM. It cannot detect a polyglot (a valid image or video with a script or other payload appended or embedded), and it does not strip metadata, so EXIF GPS coordinates in photos survive upload. "Rejects HTML, SVG, PHP and executables" means such files are rejected when they do not start with an accepted signature. Defence against a polyglot depends on serving: the detected content type, `X-Content-Type-Options: nosniff`, a cookieless asset origin, and ideally re-encoding images. `helmet()` sets nosniff on the API origin only; the headers on the CDN gateway were not verified. The brand lists in Phase 5 are abbreviated; the code accepts a wider set (9 HEIC, 18 MP4/ISO, 1 QuickTime brand).

4. **Handshake code delivery (ADR 003, ADR 006 body).** The 6-digit Job Completion Code reaches the client through exactly two channels: the authenticated `GET /escrow/:id`, and the handshake-ready email. The SMS carries a prompt without the code. The push body and the stored in-app message do not carry it either (ADR 006 amendment 2, ADR 007 §4). Any text saying the code is sent by SMS is wrong. The comment in `EscrowService.initiateHandshake` ("via Email, In-App, Push & SMS") describes the alert, not the code. The email copy of the code sits in the mail provider's logs; the 15-minute expiry and single use are the mitigation. Real SMS delivery has never been achieved (ADR 006 amendment 6).

5. **KYC URL shield compares host only (Phase 6).** Phase 6 says the parsed `origin` and `pathname` must match the CDN base. `validateKycUrls` checks `protocol === 'https:'` and `host` only. Any file on the CDN host passes, including another user's upload. Compare `validateProofUrls`, which also requires the `/escrow/proof-of-work/` path segment. In addition, `documentSha256` and `selfieSha256` are client-supplied, and the fallback hash includes `userId` and `Date.now()`, so the document-hash duplicate check cannot match in practice; only the `idNumber` check is effective.

6. **Timing and revocation claims (Phase 8).** (a) `login` always runs `bcrypt.compare`, so unknown emails cost the same as known ones. `forgot-password` returns an identical body, but for a registered email it awaits an extra UPDATE, a notification INSERT and a user lookup before responding, so response time is not equalised. (b) There is no ban or suspension flag. Sessions are revoked only by a `tokenVersion` bump (password reset or change). Role changes take effect immediately because `JwtStrategy.validate` reads the role from the database. (c) `change-password` increments `tokenVersion`, which also revokes the caller's own token; the response says "other sessions" and returns no new token. (d) `scripts/test-auth-lifecycle.js` lists a tenth scenario (login timing) in its header that has no step.

7. **Dispute payout ordering (Phase 4, Known limits).** That text says the artisan transfer is sent before the database transaction commits. In the working tree `DisputesService.resolve` sends it after the commit. The failure mode is now the reverse: see Known limits.

### Known limits found during this audit (status after the Phase 1 finishing pass)
- **FIXED (Remediation 1–3).** **Dispute artisan payout has no durable pending record.** After `resolve` commits (dispute `RESOLVED`, escrow `SETTLED`, tranches `RELEASED`), a failed or timed-out `initiateTransfer` is only logged. Nothing retries it, `tark-dispute-*` webhooks are not reconciled, and calling `resolve` again is rejected. The artisan can be recorded as paid and not be paid. The Phase 7 pattern (commit `PAYOUT_PENDING` and a reference first, then dispatch, then reconcile) should be applied to dispute payouts.
- **FIXED (Remediation 4).** `DisputesService.assign` has no status check and can move a `RESOLVED` dispute back to `UNDER_INVESTIGATION`.
- **FIXED (Phase 10).** `GET /reviews/artisan/:artisanId` is public and returns whole review rows, including `adminNotes`, `moderatedBy`, `clientId` and `jobId`, with no pagination.
- **OPEN.** `CreateJobDto.mediaUrls` accepts arbitrary URLs (no CDN-host check) and `currency` accepts any string.
- **FIXED (Phase 10).** `GET /users/artisans/nearby` rounds distance to 0.1 km but accepts any query point, so repeated queries can trilaterate an artisan's stored coordinates.

### 13-point remediation list (owner's audit)
1. **Disputes/payouts collision.** `pessimistic_write` lock, reject a dispute while a tranche is `PAYOUT_PENDING`; `applyTransferOutcome` must not overwrite `DISPUTED`.
2. **Dispute payout skipped the two-phase design.** Commit `PAYOUT_PENDING` + `tark-dispute-<id>` before dispatch; reconcile via webhook and sweep; `PATCH /disputes/:id/retry-payout` (see Remediation applied 1–3).
3. **Dispute refunds ignored currency and tranche status.** Guard `currency === 'NGN'`; leave already-`RELEASED` tranches untouched.
4. **Reset password was not atomic.** Single `UPDATE` that increments `tokenVersion` where the token matches and `expiresAt > NOW()`.
5. **Forgot-password timing, HTML escaping and cooldown.** HTML-escape `fullName`, 60-second cooldown, fire-and-forget email branch (see Remediation applied 7).
6. **Email collision race returned 500.** Unique index plus catch of Postgres `23505` → `ConflictException`.
7. **KYC approve/reject lacked a status guard.** Restrict to `PENDING_REVIEW` / `RESUBMITTED`; block admin self-review.
8. **KYC signed access token was inert.** Removed the unused fake HMAC and the hardcoded fallback secret.
9. **Wallet top-up used float addition.** Integer kobo math.
10. **Platform 5% fee used float calculation.** Integer kobo math.
11. **JWT strategy returned a stale role.** `JwtStrategy.validate()` returns the live database `role`.
12. **CORS allowlist, `@MaxLength(72)` on passwords, Supabase ref scrubbed from `.env.example`.**
13. **Documentation accuracy.** Single-entry ledger reality, header-only upload check vs polyglots/EXIF, `tark-final-<id>` reference naming, email-only PIN delivery, and the `DEV_TIMELINE.md` / `ENGINEERING_GUIDE.md` corrections.

### Remediation applied (Phase 1 finishing pass)
1. **Two-phase dispute payout (fixes the first Known limit and correction 7).** `Dispute` gained `payoutStatus` (`NOT_REQUIRED` / `PAYOUT_PENDING` / `RELEASED` / `PAYOUT_FAILED`), `payoutReference` (UNIQUE) and `payoutDispatchedAt`, plus a partial index on pending payouts. `DisputesService.resolve` commits `PAYOUT_PENDING` and the reference `tark-dispute-<disputeId>` inside the verdict transaction, then dispatches the transfer after commit via `EscrowService.dispatchDisputePayout`. `RELEASED` is recorded only on provider confirmation. Timeouts, 5xx errors and `pending` / `otp` statuses stay `PAYOUT_PENDING`; a provider rejection is verified before the payout is marked `PAYOUT_FAILED`. The `resolve` response reports `artisanPayoutStatus` and counts only confirmed money in `artisanDisbursedToBank`.
2. **Dispute payout outcomes.** `EscrowService.applyTransferOutcome` routes `tark-dispute-*` references to the dispute row, so `transfer.success`, `transfer.failed` and `transfer.reversed` webhooks, the dispatch response and the reconciliation sweep all use one idempotent path. `reconcilePendingPayouts` (timer and `POST /escrow/admin/reconcile-payouts`) now also sweeps pending dispute payouts. A transfer the provider has never heard of becomes `PAYOUT_FAILED` after the grace period.
3. **Admin retry.** `PATCH /disputes/:id/retry-payout` re-dispatches a `PAYOUT_FAILED` payout with a fresh reference (`-r1`, `-r2`, ...). It first asks the provider about the old reference and refuses to send if that transfer succeeded or is still in flight.
4. **`assign` guard.** `DisputesService.assign` takes a row lock and rejects `RESOLVED` and `DISMISSED` disputes, so a verdict can no longer be reopened (the enum has no `CLOSED`).
5. **KYC.** In production `submitKyc` refuses unless `KYC_PRIVATE_STORAGE_READY === 'true'` (503). `validateKycUrls` now also requires the `/cdn/` path prefix, closing the host-only gap in correction 5 (the client-supplied hash weakness in that item remains).
6. **Notification enum.** `KYC_SUBMITTED` existed in the TypeScript `NotificationType` but not in the database enum, so the receipt notification failed. `scripts/migrate-dispute-payout.js` adds every `NotificationType` value to `notifications_type_enum` idempotently.
7. **Forgot-password timing (correction 6a).** The notification dispatch for a registered email is fire-and-forget with error logging. The token UPDATE is still awaited, so a small difference remains.
8. **Housekeeping.** Removed the unused `DisputeCategory` import and the unused `totalBudget` variable, fixed the mis-indented verdict-notification block, and fixed two missing spaces in the Pay-For-Me share text.
9. **Docs.** `DEV_TIMELINE.md` and `ENGINEERING_GUIDE.md` payout reference and PIN range corrected; ADR index extended to Phases 1–9.

### Verification
- Baseline before the finishing pass (recorded by the owner): `npx tsc --noEmit` and `npm run build` with 0 errors; `test-auth-lifecycle.js` 27/27, `test-kyc-url-validation.js` 4/4, `test-upload-magic-bytes.js` 41/41, `test-payout-two-phase.js` 57/57.
- After the finishing pass (all run by the owner, 0 regressions): `node scripts/migrate-dispute-payout.js` applied cleanly (no legacy stuck disputes); `npx tsc --noEmit` and `npm run build` 0 errors; `test-auth-lifecycle.js` 27/27; `test-kyc-url-validation.js` 4/4 (the `notifications_type_enum` warning no longer appears); `test-upload-magic-bytes.js` 41/41; `test-payout-two-phase.js` 57/57.
- `test-webhook-and-dispute.js` stops at Step 2 (`An escrow can only be created after a bid has been accepted for this job`). The script predates the accepted-bid requirement for escrow creation; it needs a bid-acceptance step before it can exercise the dispute path. Not a regression from this pass.
- Not re-run against the amended code: `redteam-active-hack-phase1.js`, `redteam-active-hack-phase2.js`.

---

## Amendment: Phase 10 — Phase 2 Discovery, Teaser & Side-Door Hardening (2026-11-15)

### Context
After Phases 1–9 the job and reputation read paths still leaked or over-trusted:
1. `GET /jobs` used `OptionalJwtAuthGuard`, accepted a caller-chosen `status`, and returned whole `Job` rows to anyone (including `clientId`, tranche amounts, `mediaUrls`).
2. `GET /jobs/:id` served any job id, in any status, with the same fields. Phase 1 §5 (H-2) only coarsened the address.
3. There was no personal workspace endpoint, so clients and artisans had no safe way to list their own jobs.
4. An artisan's trade categories were the self-editable `skills` array, so "verified" scope did not exist.
5. `GET /reviews/artisan/:artisanId` returned whole review rows (see Phase 9 Known limits) with no pagination.
6. `GET /users/artisans/nearby` exposed distance at 0.1 km resolution, which allows trilateration of stored coordinates.

### Decision

**A. Verified trade scope (admin-controlled).**
- New columns: `user.verifiedCategories text[]` (default `{}`), `user.areaCode varchar(64)`, `job.areaCode varchar(64)`. `UpdateProfileDto` is unchanged, so artisans cannot write them.
- `job.areaCode` is derived server-side from `location` (last comma segment, normalized to a slug, e.g. `ibadan`) on create and whenever `location` is updated. A location with no comma yields `NULL`. Artisan area codes are set by admins at the same (city) granularity.
- `KycService.approveKyc(recordId, adminId, dto)` accepts optional `{ verifiedCategories, areaCode }`. Explicit categories must each resolve to an active category (else 400). With no body, an existing scope is kept; otherwise the artisan's declared `skills` that resolve to active categories are snapshotted.
- `PATCH /kyc/admin/artisans/:userId/scope` (admin / super_admin) updates scope for a Tark-Certified artisan. Both paths validate categories through `CategoriesService.resolveCategory` and normalize the area code.

**B. `GET /jobs/me`.** `JwtAuthGuard`; `req.user?.userId` asserted (401 otherwise) before any query; `WHERE clientId = :userId OR artisanId = :userId`; keyset pagination; strict allowlist "party view" (exact address and coordinates only for the client, or for the assigned artisan while the job is `IN_PROGRESS` / `COMPLETED`).

**C. `GET /jobs` (artisan discovery).** `JwtAuthGuard` + `RolesGuard` (`ARTISAN`), then a database re-check that the user is an artisan with `isCertifiedByTark` (403 otherwise). `status = 'OPEN'` is forced; the `status` and `page` query params were removed. Results are limited to `category IN (verifiedCategories)` and `areaCode = artisan.areaCode`; the optional `category` filter can only narrow, never widen. Search matches `title` only, with `%`, `_` and `\` escaped. Pagination is an opaque keyset cursor over `(createdAt DESC, id DESC)` using `limit + 1` for `hasMore` (no `COUNT(*)`); the cursor carries Postgres' own text rendering of `createdAt` so microseconds are not lost. An artisan with no scope receives an empty page. Output allowlist: `id, title, description (truncated to 200 chars), category, areaCode, location (coarse), currency, budget, status, createdAt`.

**D. `GET /jobs/teaser` (public).** No JWT guard; `@Throttle` 10 req/min per IP on top of the global limit. At most 10 `OPEN` jobs; allowlist `{ area, title (40 chars), category, createdAt, budgetTier }`. `budgetTier` is `MICRO` / `STANDARD` / `MAJOR`, or `CUSTOM_QUOTE` when the budget is 0 or null; thresholds live in `jobs.utils.ts` and are never sent. No job ids, user ids, raw amounts, currency or coordinates. The query selects only the columns it emits (plus `id`, needed for entity hydration and never emitted).

**E. `GET /jobs/:id` side door.** `ParseUUIDPipe`. The client or assigned artisan gets the party view. Everyone else (anonymous users, other users and admins alike) gets `404` unless `status === 'OPEN'`, and then a public view: `id, title, description, category, areaCode, location (coarse), status, budgetTier, createdAt`, plus `budget` and `currency` only when the caller is an artisan who is `isCertifiedByTark` in the database (the token claim alone is not trusted). `tranche1Amount`, `tranche2Amount`, `clientId`, `artisanId`, `mediaUrls` and coordinates are never part of the public view.

**F. `GET /reviews/artisan/:artisanId`.** `ParseUUIDPipe` on the id; keyset pagination with `limit` default 20, max 50; explicit allowlist `{ id, rating, comment, proofMediaUrls, createdAt }`. `adminNotes`, `moderatedBy`, `moderatedAt`, `clientId`, `jobId`, `status` and `updatedAt` are not returned.

**G. `GET /users/artisans/nearby`.** `distanceKm` is replaced by `distanceBand`: `< 2 km`, `2–5 km`, `5–10 km`, and `10+ km` (added because the search radius can reach 50 km; owner decision: keep). Results are ordered by band, then `id`; ordering by exact distance would leak the ranking inside a band. Allowlist: `id, fullName, role, skills, isCertifiedByTark, createdAt, distanceBand`. The optional `category` filter matches the admin-set `verifiedCategories` (trimmed and lowercased), not the self-editable `skills`, so an unverified artisan cannot self-tag into a regulated trade and appear in a category search.

**H. Migration.** `scripts/migrate-verified-scope.js` (idempotent, one transaction): adds the three columns, backfills `job.areaCode`, and creates `IDX_job_clientId`, `IDX_job_artisanId` and `IDX_job_status_category_createdAt` (names match the `@Index` decorators in `job.entity.ts`).

### Corrections to earlier wording
- Phase 1 §5 (H-2) says `GET /jobs` and `GET /jobs/:id` use `OptionalJwtAuthGuard` and reveal full detail to admins. Superseded: `GET /jobs` now requires a verified artisan, and on `GET /jobs/:id` admins are treated as non-parties (no admin bypass).
- Phase 1 §5 (H-1) says distance is "rounded to 1 decimal place". Superseded by the bands in G.

### Breaking API changes
- `GET /jobs` and `GET /reviews/artisan/:artisanId` return `{ data, meta: { limit, hasMore, nextCursor } }` instead of an array / `{ data, meta: { total, page, ... } }`.
- `GET /jobs` rejects anonymous and non-artisan callers; `status` and `page` are gone.
- `GET /users/artisans/nearby` returns `distanceBand` instead of `distanceKm`.

### Known limits (not addressed here)
- Existing certified artisans start with an empty scope and see no jobs on `GET /jobs` until an admin sets it (`PATCH /kyc/admin/artisans/:userId/scope`); the migration does not grandfather `skills`.
- ~~`GET /users/artisans/nearby` still filters `category` against the self-declared `skills` array, not `verifiedCategories`.~~ Resolved in the closing pass (see G).
- Distance bands reduce but do not remove trilateration: an attacker can still probe band boundaries (2, 5, 10 km) within the 30 req/min throttle.
- `budgetTier` thresholds assume NGN-scale amounts and ignore `currency`.
- `proofMediaUrls` on approved reviews are public by owner decision (they are the review's evidence and pass Tark's magic-byte validator); they carry no EXIF scrubbing (see Phase 9 correction 3).
- `PATCH /jobs/:id`, `DELETE /jobs/:id` and `CreateJobDto.mediaUrls` / `currency` validation are unchanged.
- The keyset cursor assumes `createdAt` is `timestamp without time zone` (the TypeORM default for `@CreateDateColumn`).

### Verification
- Part A (run by the owner against the local server and Supabase): `node scripts/migrate-verified-scope.js` applied cleanly (`user.verifiedCategories` + `user.areaCode` ready, `job.areaCode` backfilled 27 rows, 3 job indexes created); `npx tsc --noEmit` 0 errors; `GET /jobs` unauthenticated → 401; `GET /jobs/nearby` → 400 (`uuid is expected`, i.e. it is routed to `:id`); `GET /jobs/teaser` returns at most 10 items with exactly `{ area, title, category, createdAt, budgetTier }`.
- Part B (run by the owner, before the nearby-filter change):
  - `npx tsc --noEmit`: 0 errors. `npm test -- --runInBand`: 5/5 suites, **70/70 tests** (`jobs.service.spec.ts`, `jobs.controller.spec.ts`, `reviews.service.spec.ts`, `users.service.spec.ts`, `app.controller.spec.ts`).
  - Live: `GET /reviews/artisan/not-a-uuid` → 400; `GET /jobs` unauthenticated → 401; `GET /jobs/not-a-uuid` → 400.
  - Stress: `autocannon -c 20 -d 10 /jobs/teaser` → 10 × 2xx, 2,701 × 429, 29 ms median latency. `X-Forwarded-For` spoofing with 15 rotating IPs → 10 × 200, 5 × 429 (spoofed headers ignored).
  - Adversarial: `>150KB` JSON on `/auth/login` → 413; forged `alg: none` admin JWT → 401; `POST /auth/register` with `role: "ADMIN"`, `isKycVerified: true`, `walletBalance: 5000000` → 400; stale JWT replay after password change → 401; forged Paystack webhook signature → 400.
  - The previous `redteam-active-hack-phase2.js` failed immediately on its unauthenticated `GET /jobs` expectation (401), which confirmed the lockdown and that the script was stale.
- Closing pass: `UsersService.findNearbyArtisans` filters `category` on `verifiedCategories`; `users.service.spec.ts` gained 4 tests (Jest total 70 → 74); `scripts/redteam-active-hack-phase2.js` was rewritten for the Phase 10 contracts and asserts, against the live server and database:
  - `GET /jobs`: 401 anonymous, 403 for clients, `{ data, meta }` with the exact discovery keys for a verified artisan, only `OPEN` jobs, hidden when the artisan's area or category differs, with an empty scope, or when `?category=` names an unverified trade; `?status=` cannot widen results.
  - `GET /jobs/teaser`: public, ≤ 10 items, exact keys, no ids/street/coordinates/raw budget.
  - `GET /jobs/me`: 401 anonymous, party view with exact address for the owner only, nothing for strangers, 400 on a garbage cursor.
  - `GET /jobs/:id`: 400 on a non-UUID, 404 for an unknown id, public view keys (plus `budget`/`currency` only for a verified artisan), exact address and coordinates only for the owner, 404 for anonymous/outsider/unassigned artisan once the job is not `OPEN`.
  - `GET /reviews/artisan/:id`: 400 on a non-UUID, only `APPROVED` rows, exact keys, no `adminNotes`/`moderatedBy`/`clientId`/`jobId`, `createdAt DESC` order, keyset pages with no duplicates, 400 on a garbage cursor, `limit` capped at 50.
  - `GET /users/artisans/nearby`: 401 anonymous, exact keys, `distanceBand` and no `distanceKm`, an artisan at the query point in `< 2 km`, a self-tagged unverified trade hidden from `?category=`, the verified trade found (case-insensitively).
  - `PATCH /users/profile` cannot change `verifiedCategories` or `areaCode` (checked in the database).
  - The Phase 1 §5 checks (password hash, bid IDOR, malformed webhooks, support BOLA) are retained.
- **Closing gate, run by the owner (final state, 2026-11-15)** — status: **Phase 2 COMPLETE**:
  - `npx tsc --noEmit`: 0 errors.
  - `npm test -- --runInBand`: 5/5 suites, **74/74 tests** (`jobs.service.spec.ts`, `jobs.controller.spec.ts`, `users.service.spec.ts`, `reviews.service.spec.ts`, `app.controller.spec.ts`).
  - `node scripts/redteam-active-hack-phase2.js`: **all 8 attacks 100% repelled** (H-4 auth leak, H-2 job discovery/teaser/me/non-open 404, H-3 bid IDOR, H-1 nearby `distanceBand` + `verifiedCategories` scope, P-2 malformed webhooks, H-12 support BOLA, H-5 public reviews allowlist/pagination, H-6 `PATCH /users/profile` scope injection).
  - The database was cleaned after the run: all test accounts and child rows removed, keeping only the `super_admin` account and the static `category` lookup rows.
  - Operational note: `/jobs/teaser` is throttled to 10 requests per minute per IP and the script calls it once, so wait about 60 seconds after any load test before running it.


---

## Amendment: Phase 11 — Claude Adversarial Audit Response & Auth Lifecycle Hardening (2026-11-15)

### Context

An independent adversarial static review by Claude identified 12 categories of real defects spanning dispute/payout concurrency, password reset atomicity, HTML injection, KYC guard gaps, CORS misconfiguration, float arithmetic in money paths, and stale JWT claims. All 12 were investigated against the committed code (commit `8c72229`). Ten were genuine and already committed; two required documentation corrections but no code changes.

Additionally, the auth module was reviewed for missing password-management DTOs and endpoints. All five auth flows (`register`, `login`, `forgot-password`, `reset-password`, `change-password`) were confirmed wired with correct throttling and validation.

### Decisions

#### A. Dispute / Payout Isolation (Claude finding #1 & #2)

**Payout-dispute collision guard** — `DisputesService.create()` now:
1. Takes a `pessimistic_write` lock on the escrow row *before* any status check.
2. Throws `400 Bad Request` if `tranche1Status` or `tranche2Status` is `PAYOUT_PENDING` ("transfer in-flight").
3. Checks for an existing open dispute record *under the same lock* (prevents two concurrent dispute creations).

**Two-phase dispute payout** — `DisputesService.resolve()` now:
- Phase 1 (inside `dataSource.transaction()`): sets escrow `PAYOUT_PENDING`, commits the deterministic reference (`tark-dispute-{disputeId}`), saves all DB state.
- Phase 2 (after commit, outside the transaction): dispatches the Paystack transfer via `escrowService.dispatchDisputePayout()`. Ambiguous outcomes (timeout, 5xx) leave the dispute in `PAYOUT_PENDING` for the reconciliation sweep; only `transfer.success` moves it to `RELEASED`.

#### B. Tranche Labeling & Currency Guard (Claude finding #3)

- In `resolve()`, only tranches whose `tranche1Status` / `tranche2Status` are **not already `RELEASED`** are labeled `REFUNDED`. Tranches that were already paid out are preserved correctly.
- A guard throws `400 Bad Request` if `clientRefundMinor > 0` and `escrow.currency !== 'NGN'`—non-NGN refunds cannot be credited to the NGN in-app wallet.

#### C. Atomic Password Reset (Claude finding #4)

`UsersService.resetPasswordAtomic(tokenHash, hashedPassword)` performs a single atomic SQL UPDATE:
```sql
UPDATE "user"
SET password = $1,
    "passwordResetTokenHash" = NULL,
    "passwordResetExpiresAt" = NULL,
    "tokenVersion" = "tokenVersion" + 1
WHERE "passwordResetTokenHash" = $2
  AND "passwordResetExpiresAt" > NOW()
```
Returns `true` only if `affected > 0`. Two concurrent requests with the same token: the first succeeds, the second finds no matching row and fails. No intermediate state is observable.

#### D. forgotPassword Hardening (Claude finding #5)

- `escapeHtml()` applied to `user.fullName` before interpolation into the HTML email body.
- **Per-account cooldown**: a new reset email is only dispatched if `passwordResetExpiresAt - now < 29 minutes` (i.e., the existing token has less than 29 of its 30 minutes remaining). Re-requesting during the first 60 seconds is silently swallowed. This prevents email-bombing a victim.
- Mail dispatch is **fire-and-forget** (`.catch()` logging, response does not wait on SMTP): a registered email cannot be distinguished from an unknown one by response timing.

#### E. Email Collision Race → 409 (Claude finding #6)

`UsersService.create()` wraps `repository.save()` in a try/catch that converts PostgreSQL error code `23505` (unique-violation) to `ConflictException (409)` instead of leaking an unhandled 500.

#### F. KYC Status & Self-Review Guards (Claude finding #7)

- `approveKyc()` and `rejectKyc()` both throw `BadRequestException` if the record is not in `PENDING_REVIEW` or `RESUBMITTED` status — prevents resurrection of `REJECTED` or `SUPERSEDED` records.
- Both throw `ForbiddenException` if `record.userId === adminId` — prevents self-approval by an artisan who is also an admin.

#### G. KYC Document Access Token Removed (Claude finding #8)

`getSecureDocumentAccess()` previously returned an `accessToken` computed with a hardcoded `'tark-sec-token'` fallback secret (a no-op security theatre). It now returns only `{ targetUrl, sha256, docType }`. Signed URL delegation is deferred to the CDN layer (Cloudflare R2 signed URL generation is not yet integrated).

#### H. Integer Kobo Arithmetic (Claude findings #9 & #10)

All money arithmetic now uses integer minor units (kobo) to prevent floating-point drift:
- **Wallet top-up webhook**: `(Math.round(Number(user.walletBalance || 0) * 100) + amountMinor) / 100`
- **Platform fee**: `Math.round((totalBudgetMinor * 5) / 100) / 100` (5% of kobo amount, integer division)
- **Dispute wallet credit**: `(Math.round(Number(lockedClient.walletBalance || 0) * 100) + clientRefundMinor) / 100`

#### I. Live DB Role in JWT Strategy (Claude finding #11)

`JwtStrategy.validate()` queries the `User` table on every authenticated request and returns `{ userId: user.id, email: user.email, role: user.role }` from the live row — not from the token payload. A role demotion by an admin takes effect on the next request without requiring a token refresh.

#### J. CORS Allowlist, Password Length Cap, .env.example (Claude finding #12)

- **CORS**: `main.ts` reads `CORS_ALLOWED_ORIGINS` from env (comma-separated) and builds an explicit allowlist (`https://tark.ng`, `https://admin.tark.ng`, localhost ports). `origin: true` (reflect-all) is removed.
- **Password truncation**: `@MaxLength(72)` added to all four password fields (`RegisterDto.password`, `LoginDto.password`, `ResetPasswordDto.newPassword`, `ChangePasswordDto.currentPassword`, `ChangePasswordDto.newPassword`) — bcrypt silently truncates at 72 bytes; an attacker submitting a 10,000-char password would have its hash collision-exposed.
- **.env.example**: real Supabase project ref `dousknjnueijzbmvecbn` replaced with placeholder `your-project-ref`.

#### K. Auth Endpoint Inventory (confirmed complete)

| Endpoint | DTO | Guard | Rate Limit |
|----------|-----|-------|-----------|
| `POST /auth/register` | `RegisterDto` | None | 10/min |
| `POST /auth/login` | `LoginDto` | None | 10/min |
| `POST /auth/forgot-password` | `ForgotPasswordDto` | None | 5/min |
| `POST /auth/reset-password` | `ResetPasswordDto` | None | 5/min |
| `POST /auth/change-password` | `ChangePasswordDto` | `JwtAuthGuard` | Global |
| `GET /auth/me` | — | `JwtAuthGuard` | Global |

All auth DTOs have `@MaxLength(72)` on password fields. `ForgotPasswordDto.email` has a lowercase `@Transform` and `@IsEmail` validator.

#### L. Claude Overclaims (no code action required)

| Claim | Reality |
|-------|---------|
| Transfer refs should be `tark-t2-` | Code uses `tark-t1-` and `tark-final-` — this is correct per ADR 002 |
| "Double-entry wallet ledger" | Ledger is append-only single-entry with a `UNIQUE` reference constraint; true double-entry bookkeeping is out of scope for Phase 1 |
| "Polyglot pass with magic-byte check" | The magic-byte detector checks the actual binary header, not the MIME claim; polyglot bypass requires a file with a valid JPEG/PNG/MP4 header *and* an embedded payload — documented as a known residual risk in Phase 9 |
| Handshake PIN in email is a leak | Intentional product decision: the PIN is the client's proof-of-completion and must be communicated to them via a channel the artisan cannot read |

### Verification

All five live test suites re-run against `localhost:3000` backed by Supabase, 2026-11-15:

| Suite | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | clean |
| `node scripts/test-auth-lifecycle.js` | ALL PASSED (forgot/reset/change-password, tokenVersion, case-collision, >72-char reject) |
| `node scripts/redteam-active-hack-phase1.js` | 5/5 attacks 100% repelled |
| `node scripts/redteam-active-hack-phase2.js` | 8/8 attacks 100% repelled |
| `node scripts/test-kyc-url-validation.js` | ALL PASSED |
| `node scripts/test-upload-magic-bytes.js` | 41/41 checks passed |

### Known Remaining Gaps (carry-forward to Phase 12)

1. **Multi-currency wallet**: `walletBalance` is a single NGN column; a true multi-currency wallet (NGN, USD, GHS, ZAR) requires a `wallet_balances (userId, currency, balanceMinor)` table, `toMinorUnits(amount, currency)` utility, and gateway routing (Paystack for NGN/GHS/ZAR, Stripe stub for USD — see Phase 12 ADR).
2. **`CreateJobDto.currency` validation**: `currency` is an unvalidated free string; must be `@IsIn(['NGN', 'USD', 'GHS', 'ZAR'])` with `@Transform(uppercase)`.
3. **Stale-save on profile update**: `UsersService.updateProfile()` uses `Object.assign(user, dto); repo.save(user)` — should use `repo.update(id, fields)` with an explicit allowlist to prevent concurrent requests overwriting wallet balance or security fields.
4. **Signed CDN URLs for KYC documents**: `getSecureDocumentAccess()` currently returns only the raw CDN URL; Cloudflare R2 signed-URL generation should be integrated before production KYC goes live.
5. **Money correctness test suite**: the full Paystack sandbox journey (fund → T1 release → proof → handshake → settle) has no automated test; the escrow service changes are exercised only through unit tests and manual runs.
