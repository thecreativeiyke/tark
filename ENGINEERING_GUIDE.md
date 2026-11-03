# 🛡️ Tark Engineering Manifesto & Developer Guide

> **"Build systems so resilient and trustworthy that they cannot be broken, because real people's livelihoods and hard-earned money depend on every line of code we write."**

Welcome to the engineering team of **Tark**. 

Tark is not just another marketplace app. It is an on-demand artisan service dispatch and escrow protocol built to solve the single largest bottleneck in the informal African services economy: **mutual distrust between clients and skilled artisans**.

When a homeowner hires an electrician, plumber, carpenter, or solar installer in Lagos, Abuja, or Port Harcourt:
- **Clients fear**: paying upfront and watching the artisan disappear or abandon half-finished work.
- **Artisans fear**: investing their own hard-earned money in materials and labor only for the client to refuse payment, delay endlessly, or dispute arbitrarily upon completion.

Tark eliminates this friction through a **two-tranche escrow guarantee protocol ("Tark Safe-Lock")**, cryptographically backed handshake verification, mandatory photo proof-of-work, and intelligent AI-assisted dispute resolution.

Every developer who contributes to this repository must internalize the principles and rules in this document.

---

## 🎯 1. The Tark Mindset

### Rule 1: Zero Tolerance for Financial Ambiguity
Money in Tark is never an abstraction. A missing kobo or an uncontrolled race condition is a direct blow to someone's trust in the platform. 
- Never update wallet balances or escrow states without atomic database transactions.
- Never write optimistic locks where real money is moving — always use pessimistic locking (`SELECT FOR UPDATE`).
- Never pretend an external payment transfer succeeded when a third-party gateway failed. Fail explicitly and alert early.

### Rule 2: Defense in Depth (Hard to Break by Design)
Assume network failures, concurrent double-clicks, malicious payloads, and dishonest actors on both sides of every transaction.
- Every API endpoint that handles state transitions must be idempotent.
- Every secret (handshake PIN, auth tokens, webhook signatures) must be guarded ruthlessly. Handshake PINs are **never** returned to the artisan via any API response.
- Brute-force attacks on verification codes must be stopped cold (strict attempt limits and auto-lockout).

### Rule 3: Frontend Simplicity vs Backend Rigor
While the backend protocol is rigorous and mathematically sound, the user-facing experience must be simple, relatable, and comforting.
- **Do not burden end users with intimidating technical jargon.**
- Refer to the terminology dictionary below whenever creating DTOs, notification messages, error responses, or UI copy.

| Backend / Protocol Concept | User-Facing Display Name | Why? |
|---|---|---|
| `Escrow` / `EscrowTransaction` | **Tark Safe-Lock** | "Escrow" feels legalistic and foreign; "Safe-Lock" communicates security instantly. |
| `Tranche 1` | **Start-Work Mobilization** | Clearly indicates funds for materials and transport to commence work. |
| `Tranche 2` | **Final Completion Payment** | Clearly marks the final balance paid when the work is certified done. |
| `Handshake PIN` / `Verification Code` | **Job Completion Code** | Clients understand that giving this 6-digit code releases the final payment. |
| `Dispute Engine` | **Tark Resolution Desk** | Emphasizes resolution and fairness rather than hostility. |
| `Platform Service Fee` | **Tark Protocol Fee** | Standard, non-refundable platform protection charge. |

---

## 📱 2. The Fullstack Ecosystem: API-First Architecture

Tark is an end-to-end **fullstack ecosystem**. We are building the backend first with obsessive rigor so that when we build the mobile and web frontend applications, they sit atop an indestructible, rock-solid foundation.

### The 3 Frontend Clients We Are Building For:
1. **Tark Client Mobile App** (Mobile-first):
   - Fast geo-location discovery of artisans nearby.
   - 1-click job posting with diagnostic media uploads.
   - Real-time bid comparison & in-app chat.
   - **Tark Safe-Lock** funding & viewing the 6-digit Job Completion Code.
   - In-app wallet management (instant refunds & re-use).

2. **Tark Artisan Mobile App** (Mobile-first):
   - Real-time job alerts (Push + SMS) matching their trade and location.
   - One-tap bid submission and negotiation.
   - Safe-Lock tracking: instant notification of *Start-Work Mobilization* release.
   - In-app camera integration with Cloudflare R2 (`iyke-storage`) for mandatory proof-of-work uploads.
   - In-person Job Completion Code input to trigger instant bank transfer via Paystack.

3. **Tark Operations & Admin Web Console** (Desktop Web):
   - Review moderation queue (approving/rejecting client ratings).
   - Dispute arbitration desk with evidence inspection and multi-path verdicts.
   - AI triage escalation dashboard with Gemini-generated succinct briefs and frustration scores.
   - Artisan KYC verification desk (NIN/BVN approval for the "Certified by Tark" badge).

### Non-Negotiable API Standards for Frontend Readiness:
- **Predictable Response Shapes**: Never return arbitrary or changing JSON keys. Every response must match a defined DTO or entity structure.
- **Actionable Error Messages**: Frontend apps need clear errors to show users. Always provide descriptive messages in exceptions (e.g. `BadRequestException('At least 1 proof-of-work photo is required')` instead of generic errors).
- **Mobile Bandwidth Conscious**: Many users and artisans in Nigeria are on metered mobile data (2G/3G/4G). Keep API payloads lean, paginate list endpoints, and let Cloudflare R2 CDN handle media delivery.
- **CORS & Auth Headers**: CORS is enabled globally for all mobile and web origins. All protected routes strictly enforce Bearer JWT tokens.

---

## 🏗️ 3. High-Level Architecture & Tech Stack

```
                          ┌────────────────────────────────┐
                          │   Client App & Artisan App     │
                          │   (React Native / Flutter / Web)│
                          └───────────────┬────────────────┘
                                          │ HTTPS / REST / WSS
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │          Tark NestJS Core Backend        │
                     │  - Auth & Role Guards (RBAC)            │
                     │  - Jobs & Dispatch Engine                │
                     │  - Bids & Negotiation Layer              │
                     │  - Safe-Lock Escrow Protocol (2 Tranches)│
                     │  - Review Moderation Desk               │
                     │  - Multi-Channel Notifications Engine    │
                     │  - Gemini 3.5 Flash AI Triage Desk      │
                     └──────┬──────────────┬─────────────┬──────┘
                            │              │             │
              ┌─────────────┴──┐    ┌──────┴──────┐   ┌──┴───────────────┐
              ▼                ▼    ▼             ▼   ▼                  ▼
     ┌─────────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────┐
     │ Supabase Pooler │ │ Cloudflare R2 │ │ Paystack API  │ │ Google Gemini│
     │ PostgreSQL 16   │ │ (iyke-storage)│ │ Direct NUBAN/ │ │ AI Studio    │
     │ IPv4 Session    │ │ Photo Proofs, │ │ Dedicated Acc │ │ Triage, Brief│
     │ London eu-west-2│ │ Diagnostics   │ │ Payouts       │ │ & Frustration│
     └─────────────────┘ └───────────────┘ └───────────────┘ └──────────────┘
```

- **Framework**: [NestJS](https://nestjs.com/) (Modular, TypeScript, Dependency Injection)
- **Database ORM**: [TypeORM](https://typeorm.io/) on **PostgreSQL 16** via Supabase IPv4 Pooler
- **Object Storage**: [iyke-storage](https://www.npmjs.com/package/iyke-storage) backed by **Cloudflare R2** (Zero-egress cost storage for high-res job diagnostics and proof-of-work photos)
- **Payment Gateway**: [Paystack](https://paystack.com/) (Card checkout, NUBAN bank resolution, dedicated virtual accounts, recipient transfers)
- **AI Intelligence**: **Google Gemini 3.5 Flash** (Primary fast conversational triage) & **Gemini 2.5 Flash** (Fallback)
- **Notification Hierarchy**: **SMS (Termii / Africa's Talking) + In-App Push (FCM)** as Tier 1, **Email** as secondary fallback

---

## 🔒 4. The 10 Commandments of Tark Engineering

### 1. Atomic Database Transactions on All Fund Operations
Whenever accepting a bid, funding an escrow, releasing a tranche, or refunding a client, wrap the entire operation in a `DataSource.transaction()` block:
```typescript
await this.dataSource.transaction(async (manager) => {
  // Lock rows, update statuses, increment wallet balances
});
```
Never perform partial saves across disconnected database operations.

### 2. Pessimistic Row Locking on Wallets
To prevent race conditions, rapid double-submits, or parallel withdrawal attempts, lock the user's wallet record before checking balances:
```typescript
const user = await manager
  .getRepository(User)
  .createQueryBuilder('user')
  .setLock('pessimistic_write')
  .where('user.id = :id', { id: userId })
  .getOne();
```

### 3. The Artisan Must Never See the Completion PIN via API
The 6-digit Job Completion Code exists exclusively to prove the **client physically inspected and approved the work**.
- When the artisan initiates the handshake, the API returns `{ message: 'Handshake initiated successfully', expiresAt }`.
- The PIN is only readable by the client via authenticated `GET /escrow/:id`.
- The client verbally tells or shows the PIN to the artisan on-site once satisfied.
- The artisan enters this PIN into their app (`PATCH /escrow/:id/verify-handshake`), releasing Tranche 2.

### 4. Mandatory Photo Proof-of-Work
An artisan cannot initiate completion without submitting valid, authenticated HTTPS URLs of the completed work stored on our Cloudflare R2 bucket:
- Minimum: 1 photo. Maximum: 10 photos.
- Every URL must be validated with class-validator `@IsUrl({ protocols: ['https'] })`.

### 5. Brute-Force Code Lockout
Verification codes are strictly protected:
- Track `failedAttempts` on the transaction.
- If 5 incorrect attempts occur, lock the transaction, invalidate the code, and trigger an alert.
- Generate codes using `crypto.randomInt(100000, 999999)`, never `Math.random()`.

### 6. Payout Idempotency
Never call Paystack's `/transfer` endpoint without a deterministic, unique transfer reference (e.g. `tranche1_${escrowId}_${timestamp}`). If network drops during the HTTP request, Paystack will reject duplicate transfers using the reference, preventing double payouts.

### 7. Non-Refundable Platform Fee & In-App Refunds
- In all dispute resolution scenarios, the platform service fee (e.g., 5%) is **strictly non-refundable**.
- Any refund issued to a client is credited directly to their **in-app Tark wallet**, not reversed back to an external bank card. This prevents chargeback fraud and keeps funds ready for their next artisan request.

### 8. Reviews Are Moderated Before Becoming Public
To protect artisans from extortion and clients from fake astroturfed ratings, client reviews enter a `PENDING_REVIEW` queue. Only upon approval by a Tark administrator are ratings aggregated into the artisan's public profile.

### 9. TypeORM Postgres Explicit Types on Nullable Columns
In TypeScript/TypeORM, writing:
```typescript
@Column({ nullable: true })
jobId: string | null; // ❌ FAILS with DataTypeNotSupportedError: Data type "Object"
```
causes PostgreSQL metadata errors. **Always write:**
```typescript
@Column({ type: 'varchar', nullable: true })
jobId: string | null; // ✅ SAFE
```

### 10. Security First: Never Commit `.env`
No production API key, Supabase password, Paystack secret, or Gemini token may ever be committed to git. Use `.env.example` with clear documentation for required environment variables.

---

## 📁 5. Project Directory Structure

```
src/
├── auth/           # JWT auth, Passport strategies, RolesGuard, @Roles() decorator
├── users/          # Profiles, client/artisan roles, wallet balances, certifications
├── jobs/           # Job posting, lifecycle status, geo-location, category tagging
├── bids/           # Artisan bidding, price proposals, client bid acceptance
├── escrow/         # Safe-Lock protocol, 2-tranche state machine, handshake PIN
├── payments/       # Paystack gateway, bank lookup, dedicated accounts, webhooks
├── media/          # iyke-storage Cloudflare R2 uploader & signed gateway access
├── reviews/        # Post-job ratings, admin moderation desk, rating aggregation
├── disputes/       # 48h dispute lifecycle, 4 verdict pathways, admin arbitration
├── support/        # Gemini 3.5 Flash triage desk, case brief, human escalation
├── categories/     # Artisan skill trades (Plumbing, Solar, Electrical, etc.)
└── main.ts         # Bootstrap, validation pipes, CORS config
```

---

## 🚀 6. Local Setup & Contribution Workflow

### 1. Prerequisites
- **Node.js**: v18.x or v20.x
- **PostgreSQL**: v15+ (or Supabase remote instance)
- **Git**

### 2. Environment Configuration
Clone the repository and copy the sample environment file:
```bash
cp .env.example .env
```
Fill in your configuration:
- `DATABASE_URL`: Connection string to PostgreSQL (Use Supabase pooler for serverless stability)
- `JWT_SECRET`: Random 48-byte hex string
- `PAYSTACK_SECRET_KEY`: Your Paystack secret test key
- `STORAGE_GATEWAY_URL` & `STORAGE_API_KEY`: Cloudflare R2 / iyke-storage gateway
- `GEMINI_API_KEY`: Google AI Studio API key

### 3. Install Dependencies & Build
```bash
npm install
npm run build
```

### 4. Running the Development Server
```bash
npm run start:dev
```
The server starts on `http://localhost:3000`.

### 5. Git Commit Standards
We follow conventional commit guidelines:
- `feat: <description>` for new features
- `fix: <description>` for bug fixes or security patches
- `refactor: <description>` for code restructuring
- `docs: <description>` for documentation updates

---

## 🤝 7. Final Word

Every piece of logic you build in Tark will touch the real world. A prompt response on an artisan's phone means dinner on the table. A secured Safe-Lock escrow means a family's generator or roof gets fixed without anxiety.

**Build with pride, test relentlessly, and make Tark unbreakable.**
