/**
 * TWO-PHASE PAYOUT TEST SUITE (fake Paystack)
 *
 * Why this exists: in sandbox mode every simulated transfer succeeds instantly, so the failure
 * paths (pending, OTP, provider refusal, 5xx / lost response, failed webhook, reconciliation)
 * can never run. This script starts a FAKE Paystack on localhost and drives the real server and
 * the real database through each of them.
 *
 * HOW TO RUN (use a DEV database only: the reconcile step is global):
 *
 *   1. Stop your running server.
 *   2. In ONE terminal (Windows cmd):
 *        set PAYSTACK_BASE_URL=http://localhost:4010
 *        set PAYMENTS_SANDBOX_FALLBACK=false
 *        set PAYOUT_RECONCILE_INTERVAL_SECONDS=0
 *        node dist/main.js
 *   3. In ANOTHER terminal:
 *        node scripts/test-payout-two-phase.js
 *   4. Afterwards restart the server normally (without those three variables).
 *
 * PAYSTACK_BASE_URL is ignored when NODE_ENV=production.
 */
require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { Client } = require('pg');

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run with NODE_ENV=production.');
  process.exit(1);
}

const BASE_URL = process.env.APP_URL || 'http://localhost:3000';
const STUB_PORT = Number(process.env.STUB_PORT || 4010);
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_fake_secret_key';
const CDN =
  process.env.STORAGE_CUSTOM_CDN_URL ||
  'https://iyke-storage-gateway.iyke-storage-gateway.workers.dev/cdn';

const ts = Date.now();
const PASSWORD = 'SecurePassword123!';
const CLIENT_EMAIL = `twophase.client.${ts}@tark.ng`;
const ARTISAN_EMAIL = `twophase.artisan.${ts}@tark.ng`;
const ADMIN_EMAIL = `twophase.admin.${ts}@tark.ng`;

let clientToken = '';
let artisanToken = '';
let adminToken = '';
let pg;

// ───────────────────────── fake Paystack ─────────────────────────
// mode controls what POST /transfer answers:
//   success      200, status 'success'
//   pending      200, status 'pending'   (the normal real-world answer)
//   otp          200, status 'otp'       (OTP confirmation enabled on the account)
//   reject       400, provider refuses   (definitive: nothing was created)
//   unknown      500, BUT the transfer was created (response lost)
//   unknown-lost 500, and the transfer was NOT created
const stub = { mode: 'success', transfers: {}, calls: [] };

const stubServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${STUB_PORT}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'POST' && url.pathname === '/transfer') {
      const payload = JSON.parse(body || '{}');
      const ref = payload.reference;
      stub.calls.push({ mode: stub.mode, reference: ref, amount: payload.amount });
      const record = (status) => {
        stub.transfers[ref] = { status, amount: payload.amount };
      };
      const ok = (status) =>
        send(200, {
          status: true,
          message: 'Transfer has been queued',
          data: { status, reference: ref, amount: payload.amount, transfer_code: `TRF_${ts}` },
        });

      switch (stub.mode) {
        case 'success':
          record('success');
          return ok('success');
        case 'pending':
          record('pending');
          return ok('pending');
        case 'otp':
          record('otp');
          return ok('otp');
        case 'reject':
          return send(400, { status: false, message: 'Your balance is not enough to fulfil this request' });
        case 'unknown':
          record('pending');
          return send(500, { status: false, message: 'Internal error' });
        case 'unknown-lost':
          return send(500, { status: false, message: 'Internal error' });
        default:
          return send(500, { status: false, message: 'stub: bad mode' });
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/transfer/verify/')) {
      const ref = decodeURIComponent(url.pathname.split('/').pop());
      const t = stub.transfers[ref];
      if (!t) return send(404, { status: false, message: 'Transfer not found' });
      return send(200, { status: true, data: { status: t.status, reference: ref, amount: t.amount } });
    }

    send(404, { message: `stub: unhandled ${req.method} ${url.pathname}` });
  });
});

// ───────────────────────── helpers ─────────────────────────
let checks = 0;
function expect(cond, msg, extra) {
  checks++;
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
  }
  console.log(`   ✅ ${msg}`);
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json ?? text };
}

const okStatus = (s) => s === 200 || s === 201;

function sign(payload) {
  return crypto.createHmac('sha512', PAYSTACK_SECRET).update(JSON.stringify(payload)).digest('hex');
}

async function webhook(event, reference) {
  const payload = { event, data: { reference, status: event.split('.')[1] } };
  return request('/payments/webhook', {
    method: 'POST',
    headers: { 'x-paystack-signature': sign(payload) },
    body: payload,
  });
}

async function escrowRow(id) {
  const r = await pg.query(
    `SELECT "tranche1Status","tranche2Status","totalStatus","tranche1TransferRef","tranche2TransferRef","handshakePin","feeCollectedMinor"
     FROM escrow_transaction WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function jobStatusOf(escrowId) {
  const r = await pg.query(
    `SELECT status FROM job WHERE id::text = (SELECT "jobId"::text FROM escrow_transaction WHERE id = $1)`,
    [escrowId],
  );
  return String(r.rows[0]?.status || '').toUpperCase();
}

const release = (id) => request(`/escrow/${id}/release-tranche1`, { method: 'PATCH', token: clientToken });
const verify = (id, pin) =>
  request(`/escrow/${id}/verify-handshake`, { method: 'PATCH', token: artisanToken, body: { pin } });

async function startHandshake(id) {
  const hs = await request(`/escrow/${id}/initiate-handshake`, {
    method: 'PATCH',
    token: artisanToken,
    body: { proofOfWorkUrls: [`${CDN}/escrow/proof-of-work/twophase-${Date.now()}.png`] },
  });
  expect(okStatus(hs.status), 'Handshake initiated', hs.body);
  const read = await request(`/escrow/${id}`, { token: clientToken });
  return read.body.handshakePin;
}

async function reconcile() {
  const r = await request('/escrow/admin/reconcile-payouts?olderThanSeconds=0&notFoundGraceSeconds=0', {
    method: 'POST',
    token: adminToken,
  });
  expect(okStatus(r.status), 'Reconcile endpoint reachable as admin', r.body);
  console.log(`      reconcile summary: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createFundedEscrow(label) {
  const jobRes = await request('/jobs', {
    method: 'POST',
    token: clientToken,
    body: {
      title: `Roof Repair Leak Fix ${label}`,
      description: 'Urgent leak fixing in Victoria Island Lagos',
      category: 'Solar & Inverter Systems',
      location: 'Victoria Island, Lagos',
      budget: 100000,
      tranche1Amount: 40000,
      tranche2Amount: 60000,
    },
  });
  const jobId = jobRes.body?.id || jobRes.body?.job?.id;
  if (!jobId) throw new Error(`Job creation failed: ${JSON.stringify(jobRes.body)}`);

  const bidRes = await request('/bids', {
    method: 'POST',
    token: artisanToken,
    body: { jobId, amount: 100000, tranche1Amount: 40000, tranche2Amount: 60000, coverNote: 'Two-phase payout test' },
  });
  const bidId = bidRes.body?.id || bidRes.body?.bid?.id;
  if (!bidId) throw new Error(`Bid creation failed: ${JSON.stringify(bidRes.body)}`);

  const acceptRes = await request(`/bids/${bidId}/accept`, { method: 'PATCH', token: clientToken });
  if (!okStatus(acceptRes.status)) throw new Error(`Bid accept failed: ${JSON.stringify(acceptRes.body)}`);
  const escrowId = acceptRes.body.escrow.id;

  const fundPayload = {
    event: 'charge.success',
    data: { reference: `tark-${escrowId}-${Date.now()}`, amount: 10000000, status: 'success', currency: 'NGN' },
  };
  await request('/payments/webhook', {
    method: 'POST',
    headers: { 'x-paystack-signature': sign(fundPayload) },
    body: fundPayload,
  });

  const row = await escrowRow(escrowId);
  expect(row.totalStatus === 'FUNDS_LOCKED', `Escrow ${label} funded and locked`, row);
  return escrowId;
}

async function cleanup() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const u = await c.query('SELECT id FROM "user" WHERE email = ANY($1::text[])', [
      [CLIENT_EMAIL, ARTISAN_EMAIL, ADMIN_EMAIL],
    ]);
    const ids = u.rows.map((r) => r.id);
    if (!ids.length) return;
    const list = ids.map((_, i) => `$${i + 1}`).join(',');
    await c.query(`DELETE FROM wallet_ledgers WHERE "userId"::text IN (${list})`, ids);
    await c.query(`DELETE FROM notifications WHERE "userId"::text IN (${list})`, ids);
    await c.query(
      `DELETE FROM bid WHERE "artisanId"::text IN (${list}) OR "jobId"::text IN (SELECT id::text FROM job WHERE "clientId"::text IN (${list}))`,
      ids,
    );
    await c.query(`DELETE FROM escrow_transaction WHERE "clientId"::text IN (${list}) OR "artisanId"::text IN (${list})`, ids);
    await c.query(`DELETE FROM job WHERE "clientId"::text IN (${list})`, ids);
    await c.query(`DELETE FROM "user" WHERE id::text IN (${list})`, ids);
  } finally {
    await c.end();
  }
}

// ───────────────────────── scenarios ─────────────────────────
async function run() {
  console.log('\n================================================================');
  console.log('💥 TWO-PHASE PAYOUT SUITE (fake Paystack on :' + STUB_PORT + ')');
  console.log('================================================================\n');

  await new Promise((resolve) => stubServer.listen(STUB_PORT, resolve));
  pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  try {
    console.log('SETUP: client, certified artisan with payout recipient, admin');
    const c = await request('/auth/register', {
      method: 'POST',
      body: { email: CLIENT_EMAIL, password: PASSWORD, fullName: 'Twophase Client', role: 'client' },
    });
    clientToken = c.body.accessToken;
    const a = await request('/auth/register', {
      method: 'POST',
      body: { email: ARTISAN_EMAIL, password: PASSWORD, fullName: 'Twophase Artisan', role: 'artisan' },
    });
    artisanToken = a.body.accessToken;
    await request('/auth/register', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: PASSWORD, fullName: 'Twophase Admin', role: 'client' },
    });
    await pg.query(`UPDATE "user" SET role = 'admin' WHERE email = $1`, [ADMIN_EMAIL]);
    await pg.query(
      `UPDATE "user" SET "isCertifiedByTark" = true, "payoutRecipientCode" = 'RCP_twophase_123', "payoutAccountIdentifier" = '0123456789' WHERE email = $1`,
      [ARTISAN_EMAIL],
    );
    const login = await request('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: PASSWORD } });
    adminToken = login.body.accessToken;
    expect(!!clientToken && !!artisanToken && !!adminToken, 'All three accounts ready');

    // ── Escrow A: refusal, lost response, webhook, pending final payout, reconciliation ──
    console.log('\nESCROW A');
    const A = await createFundedEscrow('A');

    console.log('\nS1  Provider definitively refuses (400) → rolled back, retryable');
    stub.mode = 'reject';
    const r1 = await release(A);
    expect(
      stub.calls.length >= 1,
      'Server reached the FAKE Paystack (if this fails: restart the server with PAYSTACK_BASE_URL and PAYMENTS_SANDBOX_FALLBACK=false)',
    );
    expect(r1.status === 400, 'Refusal returns 400, with no provider detail leaked', r1.body);
    expect(!JSON.stringify(r1.body).includes('balance is not enough'), 'Provider error text is not exposed to the client');
    let row = await escrowRow(A);
    expect(row.tranche1Status === 'LOCKED', 'Tranche 1 back to LOCKED', row);

    console.log('\nS2  Response lost (500, transfer WAS created) → PAYOUT_PENDING must SURVIVE');
    stub.mode = 'unknown';
    const r2 = await release(A);
    expect(okStatus(r2.status), 'Ambiguous failure does not error the request', r2.body);
    expect(r2.body.tranche1Status === 'PAYOUT_PENDING', 'Response shows PAYOUT_PENDING', r2.body.tranche1Status);
    row = await escrowRow(A);
    expect(row.tranche1Status === 'PAYOUT_PENDING', 'PAYOUT_PENDING is persisted in the database (the core fix)', row);
    expect(row.totalStatus === 'FUNDS_LOCKED', 'Escrow status unchanged while pending', row.totalStatus);
    const t1Ref = row.tranche1TransferRef;
    expect(/^tark-t1-/.test(t1Ref) && t1Ref.endsWith('-r1'), 'Fresh single-use reference after the earlier refusal', t1Ref);

    console.log('\nS3  Re-entrant calls while pending are blocked and send nothing to the provider');
    const before = stub.calls.length;
    const r3 = await release(A);
    expect(r3.status === 400, 'Second release-tranche1 → 400', r3.body);
    expect(stub.calls.length === before, 'No second transfer request reached the provider');
    const hsBlocked = await request(`/escrow/${A}/initiate-handshake`, {
      method: 'PATCH',
      token: artisanToken,
      body: { proofOfWorkUrls: [`${CDN}/escrow/proof-of-work/blocked.png`] },
    });
    expect(hsBlocked.status === 400, 'Handshake cannot start while a payout is pending', hsBlocked.body);

    console.log('\nS4  Late transfer.success webhook finds the escrow and settles it');
    const w1 = await webhook('transfer.success', t1Ref);
    expect(okStatus(w1.status), 'Webhook accepted', w1.body);
    row = await escrowRow(A);
    expect(row.tranche1Status === 'RELEASED' && row.totalStatus === 'TRANCHE_1_RELEASED', 'Tranche 1 RELEASED, escrow TRANCHE_1_RELEASED', row);
    const w1b = await webhook('transfer.success', t1Ref);
    const rowReplay = await escrowRow(A);
    expect(okStatus(w1b.status) && rowReplay.tranche1Status === 'RELEASED', 'Replay is idempotent', w1b.body);

    console.log('\nS5  Final payout: provider answers "pending" → NOT settled yet');
    stub.mode = 'pending';
    const pin = await startHandshake(A);
    const v = await verify(A, pin);
    expect(okStatus(v.status), 'verify-handshake accepted', v.body);
    expect(v.body.tranche2Status === 'PAYOUT_PENDING', 'Response shows PAYOUT_PENDING, not RELEASED', v.body.tranche2Status);
    row = await escrowRow(A);
    expect(row.tranche2Status === 'PAYOUT_PENDING' && row.tranche1Status === 'RELEASED', 'DB: tranche 2 pending, tranche 1 still released', row);
    expect(row.tranche2TransferRef === `tark-final-${A}`, 'Deterministic final reference stored', row.tranche2TransferRef);
    expect(row.totalStatus !== 'SETTLED', 'Escrow NOT settled while provider has not confirmed', row.totalStatus);
    expect(row.handshakePin === null, 'PIN consumed');
    expect((await jobStatusOf(A)) !== 'COMPLETED', 'Job NOT marked COMPLETED yet');
    const dupVerify = await verify(A, pin);
    expect(dupVerify.status === 400, 'Replaying the PIN is rejected', dupVerify.body);

    console.log('\nS6  Reconciliation sweep asks the provider and settles it');
    stub.transfers[row.tranche2TransferRef].status = 'success';
    const sum6 = await reconcile();
    expect(sum6.settled >= 1, 'Sweep reports the payout as settled', sum6);
    row = await escrowRow(A);
    expect(row.tranche2Status === 'RELEASED' && row.totalStatus === 'SETTLED', 'Escrow SETTLED', row);
    expect((await jobStatusOf(A)) === 'COMPLETED', 'Job COMPLETED only now');

    console.log('\nS7  Late failed/reversed webhooks cannot flip a released tranche');
    await webhook('transfer.failed', `tark-final-${A}`);
    await webhook('transfer.reversed', `tark-final-${A}`);
    row = await escrowRow(A);
    expect(row.tranche2Status === 'RELEASED' && row.totalStatus === 'SETTLED', 'Still RELEASED / SETTLED (logged for an operator instead)', row);

    // ── Escrow B: OTP status, abandoned, retry with fresh reference ──
    console.log('\nESCROW B');
    const B = await createFundedEscrow('B');

    console.log('\nS8  Provider answers "otp" (needs approval) → NOT paid; abandoned → failed → retry works');
    stub.mode = 'otp';
    const rb = await release(B);
    expect(okStatus(rb.status) && rb.body.tranche1Status === 'PAYOUT_PENDING', 'otp is treated as pending, not paid', rb.body);
    row = await escrowRow(B);
    const refB = row.tranche1TransferRef;
    stub.transfers[refB].status = 'abandoned';
    const sum8 = await reconcile();
    expect(sum8.failed >= 1, 'Sweep records the abandoned transfer as failed', sum8);
    row = await escrowRow(B);
    expect(row.tranche1Status === 'PAYOUT_FAILED' && row.totalStatus === 'FUNDS_LOCKED', 'Tranche 1 PAYOUT_FAILED, escrow still FUNDS_LOCKED', row);
    stub.mode = 'success';
    const rb2 = await release(B);
    expect(okStatus(rb2.status) && rb2.body.tranche1Status === 'RELEASED', 'Client can retry and it succeeds immediately', rb2.body);
    row = await escrowRow(B);
    expect(row.tranche1TransferRef === `${refB}-r1`, 'Retry used a NEW single-use reference', row.tranche1TransferRef);

    // ── Escrow C: failed final payout via webhook, then retry ──
    console.log('\nESCROW C');
    const C = await createFundedEscrow('C');

    console.log('\nS9  Final payout fails by webhook → clean state → artisan retries → settles');
    stub.mode = 'success';
    expect(okStatus((await release(C)).status), 'Tranche 1 released');
    stub.mode = 'pending';
    const pinC = await startHandshake(C);
    expect(okStatus((await verify(C, pinC)).status), 'Final payout accepted as pending');
    row = await escrowRow(C);
    const finalRefC = row.tranche2TransferRef;
    const wf = await webhook('transfer.failed', finalRefC);
    expect(okStatus(wf.status), 'transfer.failed webhook accepted', wf.body);
    row = await escrowRow(C);
    expect(row.tranche2Status === 'PAYOUT_FAILED', 'Tranche 2 PAYOUT_FAILED', row);
    expect(row.tranche1Status === 'RELEASED', 'Tranche 1 stays RELEASED', row);
    expect(row.totalStatus === 'TRANCHE_1_RELEASED' && row.handshakePin === null, 'Escrow back to a clean TRANCHE_1_RELEASED (no stuck handshake)', row);
    expect(row.feeCollectedMinor === 0, 'Fee not counted as collected for a failed payout', row.feeCollectedMinor);
    stub.mode = 'success';
    const pinC2 = await startHandshake(C);
    const vC2 = await verify(C, pinC2);
    expect(okStatus(vC2.status) && vC2.body.totalStatus === 'SETTLED', 'Retry settles the escrow', vC2.body);
    row = await escrowRow(C);
    expect(row.tranche2TransferRef === `${finalRefC}-r1`, 'Retry used a NEW single-use reference', row.tranche2TransferRef);
    expect((await jobStatusOf(C)) === 'COMPLETED', 'Job COMPLETED');

    // ── Escrow D: provider never heard of it → rolled back by the sweep ──
    console.log('\nESCROW D');
    const D = await createFundedEscrow('D');

    console.log('\nS10 Request lost and transfer never created → sweep rolls back → retry works');
    stub.mode = 'unknown-lost';
    const rd = await release(D);
    expect(okStatus(rd.status) && rd.body.tranche1Status === 'PAYOUT_PENDING', 'Left pending (we cannot know yet)', rd.body);
    const sum10 = await reconcile();
    expect(sum10.reverted >= 1, 'Sweep finds the provider has no such transfer and rolls back', sum10);
    row = await escrowRow(D);
    expect(row.tranche1Status === 'LOCKED', 'Tranche 1 back to LOCKED', row);
    stub.mode = 'success';
    const rd2 = await release(D);
    expect(okStatus(rd2.status) && rd2.body.tranche1Status === 'RELEASED', 'Retry succeeds', rd2.body);

    console.log('\n================================================================');
    console.log(`✨ ALL ${checks} TWO-PHASE PAYOUT CHECKS PASSED`);
    console.log('================================================================\n');
  } finally {
    stubServer.close();
    await pg.end().catch(() => {});
    try {
      await cleanup();
      console.log('[Cleanup] Test data removed.');
    } catch (e) {
      console.error('[Cleanup error]', e.message);
    }
  }
}

run().catch((err) => {
  console.error('\n❌ SUITE FAILED:', err.message);
  process.exit(1);
});
