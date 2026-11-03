# ADR 003: Mandatory Cloudflare R2 Proof-of-Work & PIN Confidentiality

## Status
**ACCEPTED** (2026-10-31)

## Context
In early iterations of the escrow handshake protocol:
1. An artisan could initiate a completion handshake without providing any visual evidence that the work was actually completed.
2. The 6-digit handshake PIN was temporarily returned in the response of `POST /escrow/:id/initiate-handshake`. Because this endpoint is called by the artisan, the artisan could inspect their mobile app network inspector and obtain the PIN, defeating the entire purpose of client physical approval.
3. The verification endpoint did not limit failed attempts, leaving the 6-digit numeric PIN vulnerable to automated brute-force attacks (100,000 combinations).

## Decision
We implemented a strict cryptographic and evidentiary security layer:
1. **Mandatory Photo Proof-of-Work**:
   - The artisan must upload between 1 and 10 photographic proof URLs stored on Cloudflare R2 via our `iyke-storage` gateway (`https://iyke-storage-gateway...`).
   - The API strictly validates these URLs with `@ArrayMinSize(1)`, `@ArrayMaxSize(10)`, and `@IsUrl({ protocols: ['https'] })`.
   - Without valid photo proof, `initiateHandshake` immediately throws `BadRequestException`.
2. **PIN Confidentiality (Artisan API Masking)**:
   - The completion PIN is **never** returned to the artisan via any API response.
   - The artisan's `POST /initiate-handshake` receives only `{ message: 'Handshake initiated successfully', expiresAt }`.
   - The PIN is **strictly accessible only to the authenticated client** via `GET /escrow/:id`.
   - The client physically verifies the completed work in person, and verbally shares or shows the code to the artisan.
3. **Cryptographic Generation & Brute-Force Protection**:
   - Codes are generated using `crypto.randomInt(100000, 999999)` instead of insecure PRNGs (`Math.random()`).
   - Every transaction tracks `failedAttempts`. If 5 consecutive failed verification attempts occur, the transaction is locked and the PIN invalidated.

## Consequences & Guardrails
- **Artisans Cannot Bypass Proof-of-Work**: No developer or AI model may loosen the `proofOfWorkUrls` validation to optional.
- **PIN Never Logged**: Server loggers must never output the plaintext PIN in production logs.
- **Storage Gateway Integrity**: Proof-of-work media must be stored on Cloudflare R2 via `iyke-storage` to ensure zero egress bandwidth charges.
