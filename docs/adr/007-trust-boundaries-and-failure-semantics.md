# ADR 007: Trust Boundaries, Failure Semantics & Output Escaping

## Status
**ACCEPTED**

## Date
2026-11-04

## Context
A principal-level review of the codebase on 2026-11-04 found that several *different* features shared the same four root causes. Each one let a user, a provider, or a script quietly get a result the platform never actually earned. Money and identity are at stake, so these are fixed as rules, not one-off patches.

1. **Authority taken from the caller.** `POST /auth/register` accepted any `role`, including `admin` and `super_admin`, and the service copied it onto the new user. Anyone on the internet could create a super admin and reach every admin route (dispute payouts, review moderation, support queue).
2. **Silent success on failure.** The Paystack gateway returned `{ simulated: true }` when a transfer failed, so escrows were marked paid when no money moved. The SMS channel logged a failed Termii send and still returned `success: true`. The KYC triage service returned a hardcoded `faceMatchScore` of 0.94 although no face comparison exists.
3. **Untrusted text in trusted channels.** Names, job titles and dispute text were pasted raw into HTML emails and SMS sent from Tark's own sender, enabling phishing from a trusted address.
4. **Secrets shown where bystanders can see them.** The 6-digit Job Completion Code was placed in the SMS, the push body and the stored in-app message. The artisan is usually next to the client when it arrives, which defeats the purpose of the code (proof that the *client* approved the work).
5. **Confusing the token payload with an entity.** `JwtStrategy.validate()` returns `{ userId, email, role }`. A new module read `req.user.id` (always `undefined`) and treated `req.user` as a `User`. An `undefined` value inside a TypeORM `where` is silently dropped, so a query can match every row.
6. **Transaction boundaries.** `acceptBid` runs in a transaction, but `EscrowService.create` read the job on a different connection, which cannot see the transaction's uncommitted writes. Bid acceptance could never succeed.

## Decision

1. **Authority never comes from the request body.**
   - Public registration may create only `client` or `artisan` (`@IsIn` on the DTO **and** an explicit mapping in `UsersService.create`).
   - Admin and super-admin accounts are provisioned only by an operator with database access, using `node scripts/admin-audit.js --promote <email> --role <role> --yes`.
   - Never spread a DTO into an entity for any security-relevant field. Map fields explicitly.
2. **A failure is reported as a failure.**
   - Payment provider failures throw. Simulation exists only when `PAYMENTS_SANDBOX_FALLBACK=true` **and** `NODE_ENV` is not `production`.
   - `SmsChannel` returns `success: false` in production when nothing was delivered. The console simulator is development-only.
   - No component may fabricate verification evidence. Where a check is not performed, the output must say so (KYC summary states "NOT PERFORMED").
3. **Untrusted text is neutralised at the edge.**
   - Every user-supplied value in an HTML email body goes through `escapeHtml()`. Title, preview text and button text are escaped inside `renderEmailLayout`.
   - SMS text strips links and truncates user-supplied names and titles.
   - Email subjects are single-line (CR/LF removed).
4. **The Job Completion Code lives only in the authenticated app and the deliberate-open email.** It is never in SMS, push, or the stored in-app message. Clients read it with `GET /escrow/:id`.
5. **Controllers pass ids, never entities.** `req.user` is `{ userId, email, role }`. Services load the entity they need. An id that may be `undefined` must be rejected before it reaches a `where` clause.
6. **Code that runs inside a transaction passes the `EntityManager` to anything it calls that reads or writes the same rows** (e.g. `EscrowService.create(dto, clientId, manager)`).
7. **Identity documents are sensitive.**
   - They must not be served from public storage. Until private storage and signed URLs exist, KYC submissions are blocked in production by `KYC_PRIVATE_STORAGE_READY` (default `false`).
   - Government ID numbers must be encrypted, or stored as a keyed hash for duplicate detection, **before real users are onboarded** (open item).

## Alternatives Considered
- *Allow admin registration with a secret code:* rejected. It adds a secret that can leak and still exposes the endpoint.
- *Keep the code in SMS for convenience:* rejected. SMS previews appear on lock screens. Many users would prefer SMS delivery, so this must be revisited together with an in-app "reveal code" confirmation step.
- *Keep the sandbox fallback on by default:* rejected. It hides real provider errors, which is exactly when a developer needs to see them.

## Consequences & Guardrails
- Creating an admin now needs one command. That friction is intentional.
- Local development against Paystack test keys works with real errors. Developers who want simulation must set `PAYMENTS_SANDBOX_FALLBACK=true` in their own `.env`.
- **Rules for every future engineer and AI agent:**
  - Do not add a role, permission, price, fee or amount that the client can send.
  - Do not write a `catch` that returns success. If you cannot do the thing, say so.
  - Do not log or notify a secret that releases money.
  - Do not render user text into HTML or SMS without escaping or sanitising it.
  - Do not read `req.user.id`. Use `req.user.userId`.
  - Money-path changes ship with tests.

## Known Gaps (as of 2026-11-04)
- Wallet funding can double-charge; the Paystack webhook can double-credit a wallet on a repeated event.
- KYC document URLs are public CDN links; `getSecureDocumentAccess` returns the raw URL and its "access token" is not enforced anywhere.
- No automated tests cover escrow, wallet, payments or disputes.
- The 5% platform fee is applied to the final payout only and is not shown to artisans at bid time; the dispute path states the fee is retained but does not apply it. Founder decision needed.
