# 🏛️ Architecture Decision Records (ADRs)

> **"Code tells you WHAT was built; ADRs tell you WHY it was built that way."**

This directory stores the official, immutable records of all significant architectural, security, and protocol decisions made in the Tark platform.

Every engineer (human or AI agent) **must review these records** before proposing structural changes to the codebase.

---

## 📋 ADR Index

| ADR # | Title | Status | Date |
|---|---|---|---|
| [ADR 001](./001-two-tranche-safe-lock-protocol.md) | Two-Tranche Safe-Lock Escrow Protocol | **ACCEPTED** | 2026-10-30 |
| [ADR 002](./002-in-app-wallet-refunds-and-non-refundable-fees.md) | In-App Wallet Client Refunds & Non-Refundable Protocol Fee | **ACCEPTED** | 2026-10-31 |
| [ADR 003](./003-mandatory-r2-proof-of-work-and-pin-security.md) | Mandatory Cloudflare R2 Proof-of-Work & PIN Confidentiality | **ACCEPTED** | 2026-10-31 |
| [ADR 004](./004-ai-first-customer-support-and-triage-desk.md) | AI-First Customer Support & Triage Desk (Gemini 3.5 Flash) | **ACCEPTED** | 2026-11-03 |
| [ADR 005](./005-three-ring-security-shield.md) | Three-Ring Security Shield for Public Endpoints | **ACCEPTED** | 2026-11-03 |
| [ADR 006](./006-multi-channel-notifications-engine.md) | Multi-Channel Notifications Engine & Fallback Architecture | **ACCEPTED** | 2026-11-03 |
| [ADR 007](./007-trust-boundaries-and-failure-semantics.md) | Trust Boundaries, Failure Semantics & Output Escaping | **ACCEPTED** | 2026-11-04 |
| [ADR 008](./008-artisan-kyc-verification-desk.md) | Artisan KYC Verification Desk, Observation Mode & Anti-Sybil Shield | **ACCEPTED** | 2026-11-05 |
| [ADR 009](./009-security-hardening-phase1-phase2.md) | Security Hardening & Zero-Trust Defense (Phases 1–9) | **ACCEPTED** | 2026-11-14 |

---

## 📜 ADR Lifecycle & Rules

1. **Immutable History**: Once an ADR is marked `ACCEPTED`, its text is never deleted or altered.
2. **Superseding**: If business requirements or technological capabilities change, write a **new** ADR (e.g. `ADR 009`) and update the original's status to:
   `Status: SUPERSEDED BY ADR 009`.
3. **Amendments**: For small clarifications or security hardening, append an `## Amendment (Date)` section at the bottom of the existing ADR without modifying the original text.

---

## 📝 ADR Template

When creating a new ADR, copy the structure below:

```markdown
# ADR [Number]: [Short, Descriptive Title]

## Status
[PROPOSED | ACCEPTED | SUPERSEDED BY ADR-XXX | DEPRECATED]

## Context
What problem are we trying to solve? What are the market, technical, or security constraints?

## Decision
What specific technical or architectural choice are we making? What alternatives were considered and rejected, and why?

## Consequences & Guardrails
```
