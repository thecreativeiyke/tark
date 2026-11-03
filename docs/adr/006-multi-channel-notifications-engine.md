# ADR 006: Multi-Channel Notifications Engine & Fallback Architecture

## Status
**ACCEPTED**

## Date
2026-11-03

## Context
Tark is an on-demand artisan dispatch and Safe-Lock escrow platform operating primarily in Nigeria. Critical financial and physical dispatch events occur continuously:
1. An artisan submits a bid on an open job posting.
2. A client locks the job budget in Tark Safe-Lock escrow.
3. Tranche 1 (Start-Work Mobilization) is disbursed to the artisan.
4. An artisan finishes work and requests the client's 4-digit Job Completion Code (Handshake PIN).
5. The handshake is verified and final settlement is transferred.
6. A dispute ticket is raised or resolved at the Tark Resolution Desk.

Missing any of these alerts creates severe friction, distrust, or stalled jobs. Furthermore, the platform requires an architecture that functions at **$0 operational budget** during development and early rollout, without vendor lock-in or fragile third-party platform dependencies (such as heavy Firebase SDK suites).

## Decision

We implement a decoupled, resilient **Multi-Channel Notifications Engine** (`NotificationsModule`) structured around four distinct delivery vectors:

```
                  ┌──────────────────────────────────────────────┐
                  │           Protocol Milestone Event           │
                  └──────────────────────┬───────────────────────┘
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │             NotificationsService             │
                  └──────┬───────────────┼───────────────┬───────┘
                         │               │               │
                         ▼               ▼               ▼
                  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
                  │ In-App Feed │ │  Web Push   │ │  SMS Engine │
                  │ (Postgres)  │ │   (VAPID)   │ │ (Mock/Termii│
                  └─────────────┘ └─────────────┘ └──────┬──────┘
                                                         │
                                                         ▼
                                                ┌────────────────┐
                                                │  Email Engine  │
                                                │ (Resend SDK)   │
                                                └───────┬────────┘
                                                        │ (on error)
                                                        ▼
                                                ┌────────────────┐
                                                │ SMTP Fallback  │
                                                │ (Gmail/Custom) │
                                                └────────────────┘
```

### 1. In-App Notification Feed (100% Owned)
- Backed by PostgreSQL `notifications` table (`Notification` entity).
- Authenticated endpoints: `GET /notifications` (paginated), `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`.
- Every dispatch automatically records an entry in the recipient's in-app feed, ensuring a permanent audit trail regardless of external network or device state.

### 2. Custom Web Push via VAPID (Zero Firebase SDK Lock-in)
- Built using the RFC 8292 standard (VAPID: Voluntary Application Server Identification) via `web-push`.
- Public key exposed via `GET /notifications/vapid-public-key` for frontend ServiceWorker subscription.
- Browser subscriptions stored in `push_subscriptions` table (`PushSubscriptionEntity`).
- Expired or unsubscribed endpoints (HTTP 410 Gone / 404 Not Found) are automatically pruned from the database.

### 3. Resilient Email with Automatic Multi-Provider Fallback
- **Primary Provider**: Resend (`resend` SDK) using verified API key and dynamic sender identity (`RESEND_FROM`).
- **Secondary Fallback**: Nodemailer via standard SMTP (Gmail App Password or custom SMTP server).
- **Execution Flow**: The engine attempts delivery through Resend. If Resend throws, rejects credentials, or exceeds rate limits, the system seamlessly catches the exception, logs a warning, and delivers via the SMTP fallback. The caller never crashes.
- **Email Design Standards**: 
  - Pure inlined CSS for full Gmail and mobile client fidelity.
  - Dark luxury theme matching Tark protocol aesthetic (`#0B0F19` canvas, `#161B26` card container, `#10B981` emerald accent).
  - Web-safe font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`) with progressive typography enhancement.
  - `<meta name="google" content="notranslate">` included to prevent automated translation engines from corrupting Nigerian currency (`₦`) or technical nomenclature.

### 4. Two-Level SMS Engine
- **Level 1 (Console & Database Simulator)**: Active when `SMS_PROVIDER=mock`. Renders high-visibility formatted dispatch boxes in server logs. Enables complete functional testing of templates, trigger logic, and phone sanitization without burning SMS credits.
- **Level 2 (Termii Real Dispatch)**: Active when `SMS_PROVIDER=termii`. Calls Termii's REST API (`https://api.ng.termii.com/api/sms/send`) for real SMS delivery to Nigerian phone networks. If Termii fails or credentials are unconfigured, automatically drops down to Level 1 simulator.

### 5. Dynamic Configuration (Zero Hardcoding)
- All sender addresses, domain names, API keys, and provider selections are strictly injected via NestJS `ConfigService` (`.env`). No domains or personal email addresses are hardcoded.

## Consequences & Guardrails

- **Reliability**: A failure in an external email or SMS gateway does not block or roll back core protocol transactions (bidding, escrow funding, handshake verification, dispute settlement). All notification dispatches run asynchronously with internal error isolation.
- **Cost**: Operating cost in development and staging is exactly **$0**. Transitioning to production SMS only requires updating `SMS_PROVIDER=termii` and providing the production API key.
- **Security Rule**: Handshake PINs (Job Completion Codes) sent via email or SMS must explicitly warn clients to only disclose the code in-person after physical inspection of artisan work.
