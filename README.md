# 🛡️ Tark Backend API & Protocol Engine

> The on-demand artisan service dispatch and escrow protocol platform.

Tark connects clients with verified, skilled local artisans (electricians, plumbers, carpenters, solar technicians, mechanics, etc.) through a fraud-resistant, two-tranche escrow guarantee protocol (**Tark Safe-Lock**), cryptographic completion handshakes, mandatory photo proof-of-work, and intelligent AI-powered support and dispute triage.

---

## 📖 Essential Reading for Developers

All engineers working on this codebase **must** read and adhere to our engineering principles and security rules:

👉 **[Read the Tark Engineering Manifesto & Developer Guide (ENGINEERING_GUIDE.md)](./ENGINEERING_GUIDE.md)**

It covers:
- The Tark engineering mindset: Zero money leakage, defense-in-depth, paranoid security.
- Plain-language terminology dictionary for frontend vs backend.
- The 10 Commandments of Tark Engineering (pessimistic locking, transaction safety, PIN secrecy, payout idempotency).
- Architecture diagram and database conventions.

---

## ⚡ Tech Stack

- **Runtime & Framework**: Node.js + [NestJS](https://nestjs.com/) (TypeScript)
- **Database**: PostgreSQL 16 managed via [Supabase](https://supabase.com/) (AWS London `eu-west-2` pooler) with [TypeORM](https://typeorm.io/)
- **Media & Proof-of-Work Storage**: [Cloudflare R2](https://www.cloudflare.com/products/r2/) accessed via [`iyke-storage`](https://www.npmjs.com/package/iyke-storage) gateway
- **Payments & Transfers**: [Paystack](https://paystack.com/) (Cards, Bank Transfer, Dedicated Virtual Accounts, NUBAN resolution)
- **AI Triage & Case Summarization**: [Google Gemini 3.5 Flash](https://ai.google.dev/) via Google AI Studio API
- **Authentication**: JWT with Role-Based Access Control (`CLIENT`, `ARTISAN`, `ADMIN`, `SUPER_ADMIN`)

---

## 🔄 Core Protocol Flow

```
1. Client Posts Job ────► 2. Artisans Submit Bids ────► 3. Client Accepts Bid
                                                                   │
4. Funds Released (Tranche 1) ◄── Funds Locked in Safe-Lock ◄──────┘
   (Start-Work Mobilization)
         │
         ▼
5. Artisan Executes Work & Uploads Mandatory Proof-of-Work Photos (Cloudflare R2)
         │
         ▼
6. Artisan Initiates Handshake ────► 7. Client Reviews Work & Shares 6-Digit Completion Code
                                                                   │
8. Final Payout (Tranche 2) Released to Artisan ◄──────────────────┘
         │
         ▼
9. Client Leaves Review ────► Review Moderation Desk ────► Public Artisan Rating
```

---

## 🛠️ Quick Start

### 1. Setup Environment
```bash
cp .env.example .env
```
Configure your `.env` variables with your PostgreSQL connection, Paystack test keys, Cloudflare R2 credentials, and Google Gemini API key.

### 2. Install Dependencies
```bash
npm install
```

### 3. Build & Run
```bash
# Compile TypeScript
npm run build

# Start server in watch mode
npm run start:dev
```

Server will be running at `http://localhost:3000`.

---

## 🔒 Security Best Practices

- **Never commit `.env`**: Credentials, database strings, and API secrets must never touch version control.
- **Transactions & Row Locking**: Any balance change or escrow state transition must run inside a database transaction with pessimistic row locking (`SELECT FOR UPDATE`).
- **PIN Confidentiality**: Handshake completion PINs are only returned to the client and never exposed to the artisan's API responses.

---

## 👥 Contributors & Engineering Team

- **Founder & Product Lead**: Ikechukwu Alaeto ([@thecreativeiyke](https://github.com/thecreativeiyke))
- **Lead Engineers**: **Claude** & **Gemini** (AI Engineering Core)
- **License**: Private & Proprietary — Tark Platform
