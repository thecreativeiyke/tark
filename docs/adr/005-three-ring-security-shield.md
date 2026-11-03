# ADR 005: Three-Ring Security Shield for Public Endpoints

## Status
**ACCEPTED** (2026-11-03)

## Context
Discovery endpoints such as `GET /categories` must stay public so a homeowner or artisan can see what Tark offers before sharing personal details. Locking them behind login would hurt onboarding. Leaving them undefended exposes the platform to scraping, bot storms, quota exhaustion (Gemini, Paystack) and brute-force attempts.

## Decision
Public and abuse-prone endpoints are protected by three layered rings, with no login wall on discovery routes.

### Ring 1: OWASP Security Headers (`helmet`)
- Applied globally in `src/main.ts` via `app.use(helmet())`.
- Covers clickjacking, MIME-sniffing, XSS filter headers and Strict-Transport-Security.

### Ring 2: Rate Limiting (`@nestjs/throttler`)
Global `ThrottlerGuard` registered as `APP_GUARD` in `src/app.module.ts`, tracked per client IP. Actual configured limits:

| Scope | Limit | Why |
|---|---|---|
| Global default | 60 req/min | General browsing, scraping and DDoS protection |
| `POST /auth/register` | 10 req/min | Throttle account creation |
| `POST /auth/login` | 10 req/min | Anti brute-force. Counts all requests, not only failures |
| `POST /support/chat`, `POST /support/:ticketId/message` | 15 req/min | Protect the Gemini quota |
| `GET /payments/banks` | 30 req/min | Public route that calls the payment gateway |
| `GET /users/artisans/nearby` | 30 req/min | Heavy public geo query, deters location scraping |
| `POST /payments/webhook` | Exempt (`@SkipThrottle`) | Server-to-server from Paystack. Protected by HMAC signature verification, and must never drop a legitimate payment event |

Over-limit callers receive HTTP 429 with a friendly message.

### Ring 3: HTTP Caching (`Cache-Control` + ETag)
- `GET /categories` returns `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`: fresh for 1 hour, then served stale for up to 24 hours while revalidating in the background.
- Express adds a weak ETag by default, so conditional requests are already supported.
- Result: most app opens never reach the server, which saves database load and mobile data.

### Proxy awareness
Rate limiting is per IP. Behind a reverse proxy every user would otherwise share the proxy's IP and one bucket. `src/main.ts` therefore sets Express `trust proxy` from the `TRUST_PROXY_HOPS` environment variable (number of proxies in front of the app). It is unset on localhost and **must be set in production**.

## Consequences & Guardrails
- **Public stays public**: Do not move `GET /categories` behind authentication.
- **New public or expensive endpoints** (anything that calls a paid third party, runs a heavy query, or is unauthenticated) must get an explicit `@Throttle` below the global limit.
- **Webhooks** from third parties must use `@SkipThrottle()` together with signature verification, never rate limiting alone.
- **Deployment**: Set `TRUST_PROXY_HOPS` before going live, or per-IP limits will be wrong.
- **Known limitation**: Throttler storage is in-memory, per instance. If Tark scales to multiple instances, move to a shared store (e.g. Redis) so limits are enforced globally.
