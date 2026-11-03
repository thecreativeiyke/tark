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

---

## 🗓️ Session Log

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
