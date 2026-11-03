# ADR 004: AI-First Customer Support & Triage Desk (Gemini 3.5 Flash)

## Status
**ACCEPTED** (2026-11-03)

## Context
High customer support volume is a major overhead for on-demand service platforms. Most user inquiries fall into repetitive categories:
- Tracking Safe-Lock payments and payout schedules.
- Understanding how to find or share the Job Completion Code.
- Inquiring about artisan verification status.

However, when genuine distress, payment failure, or fraud occurs, slow response times lead to escalations, social media panic, and lost customer trust. Human agents need immediate, high-signal context without having to read through 40 rambling chat messages.

## Decision
We built an **AI First-Responder & Intelligent Triage Desk** (`src/support/`):
1. **Model Selection**:
   - Primary: **Google Gemini 3.5 Flash** (`gemini-3.5-flash`) via Google AI Studio API. Confirmed live, fast response latency, highly capable of structured context extraction.
   - Fallback: **Gemini 2.5 Flash** (`gemini-2.5-flash`) if primary experiences downtime or rate limits.
   - Note: Gemini 4 Argon was tested and rejected due to 0-quota free tier blocks.
2. **Context Injection**:
   - The AI receives live database context injected into each turn: the user's name, role, wallet balance, active job details (title, budget, location), and Safe-Lock status (T1/T2 release state).
3. **Automated Frustration Scoring & Department Routing**:
   - The AI continuously rates user frustration from 1 to 10.
   - It routes the ticket to the appropriate department: `DISPUTE_DESK`, `BILLING_AND_PAYMENTS`, `FRAUD_AND_SAFETY`, or `GENERAL_SUPPORT`.
4. **Succinct Supervisor Case Brief**:
   - When escalation is triggered (frustration >= 7, explicit user demand for human agent, or fraud claim), Gemini generates a **concise, factual 3-sentence case brief**.
   - The human supervisor reads this brief upon opening the ticket in `/support/admin/queue` and can immediately act without reading the full conversation history.

## Consequences & Guardrails
- **Human Escalation Is Always Available**: The AI must never trap a user in an endless loop. If the user asks for a human, `needsEscalation` is set to `true` and the ticket status transitions to `ASSIGNED_TO_HUMAN`.
- **Admin Access Control**: All administrative queues (`/support/admin/queue`), ticket assignment (`PATCH /support/:id/assign`), and resolution (`PATCH /support/:id/resolve`) are strictly guarded by `RolesGuard` requiring `ADMIN` or `SUPER_ADMIN` roles.
