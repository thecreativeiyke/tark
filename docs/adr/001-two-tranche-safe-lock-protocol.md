# ADR 001: Two-Tranche Safe-Lock Escrow Protocol

## Status
**ACCEPTED** (2026-10-30)

## Context
In the informal Nigerian artisan market, mutual distrust between clients and service providers causes widespread friction:
1. **Artisans' Dilemma**: Honest artisans cannot finance client projects out of pocket. They need money upfront to purchase materials (pipes, cables, compressor parts) and cover transportation to the job site. If a client promises to pay only after 100% completion, the artisan risks being shortchanged or unpaid.
2. **Clients' Dilemma**: If a client pays 100% upfront, artisans frequently abandon the site, perform substandard work, or disappear with the funds.

Traditional single-payment escrow models (e.g. Upwork 100% milestone locks) do not accommodate the reality of physical trades in developing economies where raw material mobilization is mandatory.

## Decision
We established a strict **two-tranche protocol ("Tark Safe-Lock")**:
1. When a client accepts an artisan's bid, the client deposits **100% of the project funds** into the Tark Safe-Lock upfront.
2. **Tranche 1 (Start-Work Mobilization)** (typically 40%–50% of the bid) is immediately released to the artisan's registered bank account via Paystack once the client initiates the contract. This covers materials and mobilization.
3. **Tranche 2 (Final Completion Payment)** (the remaining balance) is held securely in Safe-Lock.
4. Tranche 2 is **only released** when:
   - The artisan uploads mandatory photographic proof-of-work.
   - The artisan requests the client's 6-digit Job Completion Code.
   - The artisan submits the correct code to the API, proving the client inspected and approved the completed work on-site.

## Consequences & Guardrails
- **No Single Payout Refactoring**: No developer or AI model may merge Safe-Lock into a single 100% post-completion payout.
- **Dispute Scope**: If a dispute occurs after Tranche 1 has been released, the maximum refundable amount to the client is Tranche 2. Tranche 1 has already been disbursed for physical materials and cannot be clawed back automatically.
- **Frontend Naming**: Always present this to users as "Start-Work Mobilization" and "Final Completion Payment" under the "Tark Safe-Lock" banner.
