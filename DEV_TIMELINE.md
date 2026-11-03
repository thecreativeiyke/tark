# 📜 Tark Developer Timeline & Collaboration Feed

> **How to use this file**: 
> This is our internal team timeline (our in-repo Slack/changelog feed). Every developer or AI agent working in this project **must read this file first** to understand the latest state, and **must append a new entry at the top** before concluding any work session.
>
> **Entry Tags**:
> - `[SHIPPED]` — New features, modules, or endpoints completed and verified.
> - `[FLAGGED & FIXED]` — An error, bug, or regression spotted from a prior session and corrected.
> - `[AUDIT]` — Code reviews, security assessments, or performance checks.
> - `[DECISION]` — Minor architectural decisions (major ones get their own ADR in `docs/adr/`).

---

## 🟢 Live System State (Current Baseline)

- **Backend Server**: NestJS running live on `http://localhost:3000` (Background Task).
- **Database**: PostgreSQL 16 on **Supabase** via AWS London (`eu-west-2`) IPv4 Pooler (`aws-0-eu-west-2.pooler.supabase.com:5432/postgres`).
- **Object Storage**: Cloudflare R2 bucket (`iyke-cloud`) via [`iyke-storage`](https://www.npmjs.com/package/iyke-storage) gateway.
- **Payments**: Paystack gateway with NUBAN bank resolution, dedicated accounts, and transfer idempotency.
- **AI Intelligence**: Google Gemini 3.5 Flash (primary triage) + Gemini 2.5 Flash (fallback).
- **GitHub Repository**: [`https://github.com/thecreativeiyke/tark.git`](https://github.com/thecreativeiyke/tark.git) (`main` branch).
- **Core Engineering Team**: Ikechukwu Alaeto (Founder & Product Lead), **Claude** & **Gemini** (Lead Engineers - AI Core).

---

## 🗓️ Session Log

### 🗓️ 2026-11-03 — Session 8: Multi-Channel Notifications Engine & Fallback Architecture
- **Author**: Lead Engineer (AI Model: Gemini / Antigravity) & Ikechukwu Alaeto (Founder)
- **Tag**: `[SHIPPED]` & `[AUDIT]` & `[DECISION]` — Full rationale in [ADR 006](./docs/adr/006-multi-channel-notifications-engine.md)

#### What Was Done:
1. **Architected & Implemented `NotificationsModule`**:
   - `Notification` entity: in-app notification feed in PostgreSQL, indexed by `userId`, with read tracking (`isRead`, `readAt`).
   - `PushSubscriptionEntity`: stores browser Web Push subscriptions (VAPID endpoint + p256dh/auth keys).
   - `EmailChannel`: Resilient multi-provider email engine. Primary is Resend SDK (`resend`), with seamless automatic fallback to Nodemailer SMTP (using Gmail App password or custom SMTP server).
   - `SmsChannel`: Two-tier SMS dispatcher. Level 1 console simulator for local dev/testing (`[SMS MOCK DISPATCH]`). Level 2 Termii API integration (`https://api.ng.termii.com/api/sms/send`) for real Nigerian network SMS dispatch.
   - `WebPushChannel`: Custom RFC 8292 VAPID web push (no Firebase SDK lock-in). Stale subscriptions auto-pruned upon HTTP 410 Gone / 404.
2. **Handcrafted Email & SMS Templates**:
   - Designed 6 core protocol email templates with dark luxury aesthetic, brand headers, responsive container (max 580px), inlined CSS for full Gmail fidelity, and `<meta name="google" content="notranslate">`.
   - Covered moments: `bidReceived`, `safeLockFunded`, `tranche1Released`, `handshakeReady` (with 4-digit code and physical inspection security notice), `payoutSettled` (with 5% fee deduction breakdown), and `disputeUpdate`.
   - SMS templates: punchy, under 160 characters, with Nigerian currency formatting.
3. **Full Protocol Lifecycle Wire-Up**:
   - `BidsService.create()`: Asynchronously dispatches `notifyBidReceived` to the client.
   - `EscrowService.lockFunds()`: Dispatches `notifySafeLockFunded` to the artisan once budget is locked.
   - `EscrowService.releaseTranche1()`: Dispatches `notifyTranche1Released` to the artisan.
   - `EscrowService.initiateHandshake()`: Dispatches `notifyHandshakeReady` with the 4-digit Handshake Completion PIN to the client.
   - `EscrowService.verifyHandshake()`: Dispatches `notifyPayoutSettled` to the artisan upon final settlement.
   - `DisputesService.create()` and `resolve()`: Dispatches `notifyDisputeUpdate` to both opposing parties.
4. **Zero Hardcoding**:
   - Configured via environment variables (`RESEND_API_KEY`, `RESEND_FROM`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `SMS_PROVIDER`, `TERMII_API_KEY`).
   - Added clean placeholders in `.env.example`.
5. **Live Verification**:
   - `tsc --noEmit` passed with 0 errors.
   - `nest build` passed clean with code 0.
   - Server booted live on port 3000.
   - `GET /notifications/vapid-public-key`: Verified returning public VAPID key.
   - `POST /notifications/test-dispatch`: Successfully delivered a real transactional email to `ikechukwualaeto@gmail.com` via Resend (ID: `01a1a2ca-0c5d-79aa-851a-67fa087469ef`).
   - Level 1 SMS simulator verified: High-visibility console dispatch box output with formatted Nigerian phone number (`+2348031234567`).
   - In-app notification feed verified: `unreadCount` tracking, pagination, `PATCH /notifications/read-all` marking all read.
   - Web Push subscription & unsubscribe lifecycle tested and verified.

---

### 🗓️ 2026-11-03 — Session 7: Three-Ring Shield — Full End-to-End Verification & Push
- **Author**: Lead Engineer (AI Model: Gemini / Antigravity) & Ikechukwu Alaeto (Founder)
- **Tag**: `[AUDIT]` `[SHIPPED]` — Closed out the Three-Ring Shield work started in Sessions 5–6.

#### What Was Done:
1. **Read all files Claude wrote** (`payments.controller.ts`, `users.controller.ts`, `main.ts`, `docs/adr/005*`, `DEV_TIMELINE.md`) — all confirmed correct and consistent.
2. **TypeScript compile** (`tsc --noEmit`): exit 0, zero errors. ✅
3. **NestJS build** (`nest build`): exit 0, clean. ✅
4. **Server boot**: `Nest application successfully started` on port 3000, all routes mapped, Supabase connected. ✅
5. **Ring 1 verified** — `GET /categories` returns full Helmet header suite: `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`. ✅
6. **Ring 2 verified** — `POST /auth/login` hammered 12 times: requests 1–10 → `401`, requests 11–12 → `429 Too Many Requests`. ✅
7. **Ring 3 verified** — `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` + Express weak `ETag` present on `GET /categories`. ✅
8. **DEV_TIMELINE Session 6 verification block** updated from PENDING → COMPLETE. ✅
9. **Committed and pushed** all Three-Ring Shield changes to `main`. ✅

#### Next Up (Team Decision Pending):
- **Option A**: Multi-Channel Notifications Engine (Termii SMS + FCM Push + Email fallback)
- **Option B**: Artisan KYC & Verification Desk (NIN/BVN upload → admin review → Certified badge)
- **Option C**: In-Job Real-Time Chat (Socket.IO gateway, client ↔ artisan)

---

### 🗓️ 2026-11-03 — Session 6: Three-Ring Security Shield (Public Endpoint Hardening)
- **Author**: Lead Engineer (AI Model: Claude) & Ikechukwu Alaeto (Founder)
- **Tag**: `[SHIPPED]` & `[AUDIT]` & `[DECISION]` — full rationale in [ADR 005](./docs/adr/005-three-ring-security-shield.md)

#### What Was Done:
1. **Ring 1, Helmet**: `app.use(helmet())` in `src/main.ts` (OWASP security headers).
2. **Ring 2, Rate limiting**: Global `ThrottlerGuard` at 60 req/min/IP; `/auth/register` and `/auth/login` at 10/min; `POST /support/chat` and `POST /support/:ticketId/message` at 15/min to protect the Gemini quota.
3. **Ring 3, Caching**: `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` on `GET /categories` (Express supplies the ETag).
4. Packages `helmet@8.3.0` and `@nestjs/throttler@6.7.1` confirmed installed.

#### ⚠️ Gaps Found in Audit & Fixed:
1. **No proxy awareness**: Per-IP limits would collapse into one shared bucket behind a reverse proxy. `main.ts` now sets Express `trust proxy` from the new `TRUST_PROXY_HOPS` env var (documented in `.env.example`). **Must be set in production.**
2. **Paystack webhook under global limit**: `POST /payments/webhook` now has `@SkipThrottle()`; the HMAC signature check remains its protection.
3. **Heavy public endpoints**: `GET /payments/banks` and `GET /users/artisans/nearby` now limited to 30 req/min.
4. **Plan vs code drift**: The original proposal said 100/min global, "5 failed logins" and a 24h cache. Actual values (60/min, 10 requests/min counting all attempts, 1h fresh + 24h stale-while-revalidate) are now the documented source of truth in ADR 005.

#### 🧪 Verification — COMPLETE ✅ (Session 7 — Gemini, 2026-11-03):
- **TypeScript compile** (`tsc --noEmit`): exit 0, zero errors. ✅
- **NestJS build** (`nest build`): exit 0, clean. ✅
- **Server boot**: `Nest application successfully started` on port 3000, all routes mapped. ✅
- **Ring 1 — Helmet headers on `GET /categories`**: `Strict-Transport-Security`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Origin-Agent-Cluster` all present. ✅
- **Ring 2 — Rate limiting on `POST /auth/login`**: Requests 1–10 → `401 Unauthorized` (correct credentials rejected by auth); requests 11 & 12 → `429 Too Many Requests`. ✅
- **Ring 3 — Cache headers on `GET /categories`**: `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` + `ETag: W/"5f3-..."` (Express weak ETag). ✅
- **Rate-limit headers exposed**: `X-RateLimit-Limit: 60`, `X-RateLimit-Remaining: 59`, `X-RateLimit-Reset: 60` visible in responses. ✅

#### 📌 Follow-ups:
- Move throttler storage to Redis if Tark ever runs more than one instance (in-memory counters are per instance).
- Set `TRUST_PROXY_HOPS` in the production environment before launch.

---

### 🗓️ 2026-11-03 — Session 5: Peer-Review Hardening Pass (Claude Audit & Gemini Execution)
- **Author**: Lead Engineers: Claude (Principal Code Audit) & Gemini (Fixes Implementation & Verification)
- **Tag**: `[FLAGGED & FIXED]` & `[AUDIT]`

#### ⚠️ Issues Flagged by Claude's Codebase Audit:
1. **Job Mutation/Deletion Vulnerability**: `JobsService.remove` and `update` allowed clients to delete or alter jobs even while `IN_PROGRESS` with locked Safe-Lock funds.
2. **Dispute Settlement Concurrency Risk**: `DisputesService.resolve` did not verify `DISPUTED` status, read client wallet outside transaction without pessimistic lock, and omitted deterministic Paystack transfer references.
3. **Missing 5% Platform Fee Deduction**: ADR 002 declared a 5% platform fee, but arithmetic was never calculated or deducted from final payouts.
4. **Loose Category String Matching**: Free text strings in `Job.category` caused mismatch with category slugs.

#### 🔧 Corrections Applied:
1. **Job Lock**: Enforced that `update()` and `remove()` strictly throw `BadRequestException` if `job.status !== JobStatus.OPEN`.
2. **Dispute Hardening**:
   - Enforced `escrow.totalStatus === EscrowStatus.DISPUTED` check before resolution.
   - Wrapped operations in `pessimistic_write` row locks on both `EscrowTransaction` and `User` (client wallet).
   - Added deterministic Paystack payout idempotency reference: `tark-dispute-${dispute.id}`.
   - Added row lock on escrow in `DisputesService.create()` to prevent race condition with handshake PIN verification.
3. **Platform Fee Wire-Up**:
   - `EscrowService.create()` now automatically computes `platformFeeAmount = Math.round(totalBudget * 0.05 * 100) / 100`.
   - `EscrowService.payoutAndSettle()` deducts `platformFeeAmount` from the final artisan disbursement, retaining platform revenue securely.
4. **Category Slug Canonicalization**:
   - Injected `CategoriesService` into `JobsService`.
   - `JobsService.create()` now validates and resolves categories by slug or name, normalizing `job.category` to the canonical slug (rejecting unknown categories).

#### 🧪 Verification:
- TypeScript compilation passed with zero errors (`tsc --noEmit`).
- NestJS build passed cleanly.
- Server rebooted and verified active on port 3000.

---

### 🗓️ 2026-11-03 — Session 4: Developer Manifestos, ADR System & Fullstack Vision
- **Author**: Lead Engineer (AI Model: Gemini 3.8 Flash) & Ikechukwu Alaeto (Founder)
- **Tag**: `[SHIPPED]` & `[DECISION]`

#### What Was Done:
1. Created [`ENGINEERING_GUIDE.md`](./ENGINEERING_GUIDE.md) establishing:
   - Mindset: Zero tolerance for financial ambiguity, defense-in-depth, paranoid security.
   - User-facing terminology translation dictionary (Tark Safe-Lock, Start-Work Mobilization, Completion Code).
   - The 10 Commandments of Tark Engineering (pessimistic locking, PIN secrecy, payout idempotency, etc.).
   - Explicit Fullstack Ecosystem vision (Client App, Artisan App, Admin Web Operations Console).
2. Rewrote [`README.md`](./README.md) to replace default NestJS boilerplate with official project architecture, core flow diagrams, and links to guides.
3. Created `docs/adr/` with initial foundational Architecture Decision Records (ADR 001 - 004).
4. Created `DEV_TIMELINE.md` with standardized entry format and peer-review correction protocols.

---

### 🗓️ 2026-11-03 — Session 3: AI Customer Support & Triage Desk Completion
- **Author**: Lead Engineer (AI Model: Claude Sonnet 4.6 / Gemini 3.8 Flash)
- **Tag**: `[SHIPPED]` & `[FLAGGED & FIXED]`

#### What Was Done:
1. Created `src/support/support.controller.ts` with user & admin triage routes:
   - `POST /support/chat` — open or continue support session with live Gemini AI first-responder.
   - `POST /support/:ticketId/message` — follow-up chat with user context (wallet, active job, escrow status).
   - `GET /support/:ticketId` — ticket conversation history.
   - `GET /support/admin/queue` — role-protected admin triage queue filtered by department & priority.
   - `PATCH /support/:ticketId/assign` & `PATCH /support/:ticketId/resolve` — admin case management.
2. Created `src/support/support.module.ts` and registered it globally in `src/app.module.ts`.

#### ⚠️ Issue Flagged & Fixed during Boot:
- **Flagged**: Server boot crashed with `DataTypeNotSupportedError: Data type "Object" in SupportTicket.jobId`.
- **Root Cause**: Nullable string columns (`jobId: string | null`, `escrowId: string | null`, `category: string | null`) used plain `@Column({ nullable: true })` without explicit `{ type: 'varchar' }`.
- **Fix Applied**: Updated `SupportTicket` entity to `@Column({ type: 'varchar', nullable: true })`.
- **Verification**: NestJS build passed cleanly; server booted and connected to Supabase PostgreSQL in London. Tested `GET /` (`Hello World!`) and `GET /categories` (returned 9 active trades).
- **Git Commit**: `59d81b3` pushed to `main`.

---

### 🗓️ 2026-10-31 — Session 2: Core Protocol Hardening & Dispute Arbitration
- **Author**: Lead Engineer (AI Model: Claude Sonnet 4.6)
- **Tag**: `[SHIPPED]` & `[FLAGGED & FIXED]`

#### What Was Done:
1. **Disputes Module (`src/disputes/`)**:
   - 48-hour response window for defendant counter-claims.
   - 4 arbitration verdicts: `FULL_REFUND_TO_CLIENT`, `FULL_PAYOUT_TO_ARTISAN`, `SPLIT_SETTLEMENT`, `MUTUAL_CANCELLATION`.
   - Client refunds route exclusively to in-app wallet balance (`user.walletBalance`).
   - Platform service fee remains non-refundable across all dispute outcomes.
2. **Review Moderation Desk (`src/reviews/`)**:
   - Client reviews default to `PENDING_REVIEW` to protect artisans from extortion and clients from fake reviews.
   - Admin approves or rejects; approved reviews dynamically aggregate into artisan's `averageRating` and `totalReviewsCount`.
3. **Cloudflare R2 Storage (`src/media/`)**:
   - Integrated custom `iyke-storage` SDK with gateway URL and live upload test verified.

#### ⚠️ Security Loopholes Flagged & Fixed:
1. **Handshake PIN Leakage**: Removed completion PIN from the artisan's `POST /initiate-handshake` response. PIN is now strictly client-facing via `GET /escrow/:id`.
2. **Wallet Double-Spend**: Wrapped wallet deductions in `SELECT FOR UPDATE` pessimistic locks inside atomic transactions.
3. **PIN Brute-Force**: Restricted handshake code verification to 5 maximum attempts with auto-lockout. Replaced `Math.random()` with `crypto.randomInt()`.
4. **Paystack Idempotency**: Added deterministic transfer references (`tranche1_${id}`, `tranche2_${id}`) to prevent duplicate payouts on network drops.
5. **Mandatory Proof-of-Work**: Added strict validation requiring 1–10 valid HTTPS photo URLs before handshake can be initiated.
- **Git Commit**: `bdfa8c0` pushed to `main`.

---

### 🗓️ 2026-10-30 — Session 1: Project Foundation & Supabase Setup
- **Author**: Ikechukwu Alaeto (Founder) & AI Lead Engineer
- **Tag**: `[SHIPPED]`

#### What Was Done:
1. Initialized NestJS backend with modular structure: `auth`, `users`, `jobs`, `categories`, `bids`, `escrow`, `payments`.
2. Connected PostgreSQL via Supabase IPv4 Pooler in London (`eu-west-2`).
3. Set up Paystack integration and JWT authentication with role-based access.

---

## 🎯 Next Active Priority Tasks

1. **Multi-Channel Notifications Engine (`NotificationsModule`)**:
   - Primary: **SMS (Termii / Africa's Talking) + In-App Push (Firebase Cloud Messaging - FCM)**.
   - Secondary: **Email** (fallback for receipts/statements).
   - Wire event triggers: bid received, bid accepted, Tranche 1 released, handshake PIN ready, payout sent, dispute updates.
2. **Artisan KYC & Verification Desk**:
   - Upload of identity documents (NIN, voter card, driver's license) via `iyke-storage`.
   - Admin review workflow to grant `isCertifiedByTark` badge.
3. **In-Job Real-Time Chat (Client ↔ Artisan)**:
   - Socket.IO gateway for real-time messaging on active jobs.
