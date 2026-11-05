# ADR 008: Artisan KYC Verification Desk, Observation Mode & Anti-Sybil Shield

## Status
**ACCEPTED** — 2026-11-05

## Context
Tark dispatches independent artisans into clients' homes, private offices, and construction sites across Nigeria. Trust and personal safety are the fundamental currency of the protocol. If unvetted, anonymous actors are permitted to enter homes or receive client escrow funds, the platform incurs catastrophic physical and brand liability.

Simultaneously, demanding immediate, friction-heavy verification upon initial sign-up causes catastrophic user abandonment (the "cold-start dropoff"). Furthermore, stolen or leaked National Identification Number (NIN) slips and voter cards are widely circulated in Nigeria, making naive single-document validation vulnerable to sybil attacks and account evasion by banned actors.

## Decision
We architected a comprehensive **Artisan KYC & Verification Desk** founded on six immutable principles:

1. **Read-Only Observation Mode (Progressive Friction)**:
   - Newly registered artisans enter Tark in an unverified "Observation Mode".
   - They may explore the live job marketplace, configure profiles, and review opportunities, but their bidding capability is strictly locked at the protocol level (`BidsService.create` throws `403 Forbidden`).
   - The verified badge (`User.isCertifiedByTark = true`) is the sole cryptographic unlock for placing bids.

2. **Positional Name Strictness**:
   - In Nigerian official registries (NIMC, FRSC, INEC), positional name structure (First/Given Name vs. Surname/Last Name) is legally distinct.
   - We require explicit `documentFirstName`, `documentMiddleName`, and `documentLastName`.
   - The intelligence engine evaluates positional alignment (`EXACT`, `INVERTED`, `PARTIAL`, `MISMATCH`). If an artisan entered their surname first on their profile, the engine tags it as `INVERTED` rather than failing them outright, enabling one-click admin alignment.

3. **Mandatory Live Face Photo (Selfie) & Cryptographic Hashes**:
   - To counteract leaked NIN slips, an artisan must provide both their official document and a matching live face portrait.
   - Every file is fingerprinted using a SHA-256 hash (`documentSha256` and `selfieSha256`).

4. **Anti-Sybil Duplicate Prevention**:
   - Before accepting any KYC submission, the system executes an anti-sybil cross-check: if the submitted ID number or file SHA-256 hash is already associated with any other `APPROVED` or `PENDING_REVIEW` profile, the request is immediately rejected with `409 Conflict`.
   - Banned actors cannot re-register with burner emails using previously seen credentials.

5. **Dynamic White-Labeled Intelligence Triage (`Tark-Intelligence-v1`)**:
   - Submissions pass through an abstracted intelligence engine (`KycTriageService`).
   - Evaluates credential format integrity (11-digit NIN regex, standard VIN/license patterns), expiry dates, tamper/hash validity, and name alignment.
   - Produces a standardized compliance dossier for human compliance officers without leaking underlying third-party vendor names or AI providers.

6. **Zero Data Loss Archiving & Time-Limited Signed Access**:
   - Implemented TypeORM native soft deletes (`@DeleteDateColumn({ nullable: true }) deletedAt`).
   - Records are never physically deleted from PostgreSQL. Previous attempts are marked `SUPERSEDED`, creating an immutable audit trail.
   - PII documents are protected from public crawling; admins and artisans access files via authenticated, time-limited signed tokens (`GET /kyc/document/:id/:type` valid for 15 minutes).

7. **Role Hierarchy Expansion**:
   - Added `DEVELOPER` to `UserRole` alongside `CLIENT`, `ARTISAN`, `ADMIN`, and `SUPER_ADMIN`.
   - Developers are restricted to system diagnostics and cannot inspect cleartext PII or unilaterally flip verification badges.

## Consequences & Guardrails
- **Bidding Gate Guarantee**: No unverified artisan can ever place a bid on a client's job.
- **Admin Verification Desk**: 1-click approvals atomically update `User.isCertifiedByTark`, `certificationBadgeTitle`, set `idVerified = true`, and dispatch celebratory multi-channel notifications (in-app, email, SMS).
- **Audit Compliance**: Full historical snapshots are permanently retained under NDPR standards.

---

### Team Attribution
- **Founder & Product Lead**: Ikechukwu Alaeto
- **Lead Engineers**: Claude & Gemini (Tark AI Core)
