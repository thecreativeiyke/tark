/**
 * ACTIVE TEST SUITE: DVA GENERATION, CHECKOUT URLS & PAYMENT RAILS
 * Tests:
 * 1. Dedicated Virtual Account (DVA) provisioning via POST /payments/dedicated-account
 * 2. Online Payment Checkout URL generation via POST /payments/initialize
 * 3. Pay-For-Me shareable payment rails via GET /payments/pay-for-me/:escrowId
 * 4. Online payment funding webhook execution -> Escrow FUNDS_LOCKED transition
 * 5. Automatic cleanup of test users
 */
require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { Client } = require('pg');

const BASE = { hostname: 'localhost', port: 3000 };
const ts = Date.now();

function req(opts, body = null) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

function POST(path, body, token) {
  return req({
    ...BASE, path, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }, body);
}

function GET(path, token) {
  return req({
    ...BASE, path, method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

async function run() {
  console.log('\n================================================================');
  console.log('💳 ACTIVE TEST SUITE: DVA PROVISIONING & CHECKOUT URL RAILS');
  console.log('================================================================\n');

  const pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const clientEmail = `dva.client.${ts}@tark.ng`;
  const artisanEmail = `dva.artisan.${ts}@tark.ng`;

  console.log('1️⃣ Registering and certifying users...');
  const regClient = await POST('/auth/register', {
    email: clientEmail, password: 'SecurePass1!', fullName: 'Tark Test Client', role: 'client',
  });
  if (regClient.status !== 201) throw new Error(`Client register failed: ${JSON.stringify(regClient.data)}`);
  const clientToken = regClient.data.accessToken;
  const clientId = decodeJwt(clientToken).sub;

  const regArtisan = await POST('/auth/register', {
    email: artisanEmail, password: 'SecurePass1!', fullName: 'Tark Test Artisan', role: 'artisan',
  });
  if (regArtisan.status !== 201) throw new Error(`Artisan register failed: ${JSON.stringify(regArtisan.data)}`);
  const artisanToken = regArtisan.data.accessToken;
  const artisanId = decodeJwt(artisanToken).sub;

  // Certify artisan so they can bid
  await pgClient.query(`UPDATE "user" SET "isCertifiedByTark" = true, "kycStatus" = 'APPROVED' WHERE id = $1`, [artisanId]);
  console.log('   ✅ Client and Certified Artisan created.');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 1: Dedicated Virtual Account (DVA) Generation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n2️⃣ Testing DVA Generation (POST /payments/dedicated-account)...');
  const dvaRes = await POST('/payments/dedicated-account', {}, clientToken);
  console.log(`   Response Code: ${dvaRes.status}`);
  console.log('   DVA Payload:', dvaRes.data);

  if (dvaRes.status !== 200 && dvaRes.status !== 201) {
    throw new Error(`DVA Generation failed with status ${dvaRes.status}: ${JSON.stringify(dvaRes.data)}`);
  }
  if (!dvaRes.data.accountNumber || !dvaRes.data.bankName) {
    throw new Error(`DVA Generation returned invalid payload: ${JSON.stringify(dvaRes.data)}`);
  }
  console.log(`   ✅ DVA Generated successfully! Bank: ${dvaRes.data.bankName}, Account: ${dvaRes.data.accountNumber}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // SETUP JOB & ESCROW
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3️⃣ Setting up Job & Compliant Bid for Escrow Payment Testing...');
  const jobRes = await POST('/jobs', {
    title: 'AC Maintenance & Servicing',
    description: 'Repair 2 inverter split units',
    category: 'electrical',
    location: '15 Admiralty Way, Lekki Phase 1, Lagos',
    budget: 50000,
  }, clientToken);
  if (jobRes.status !== 201) throw new Error(`Job creation failed: ${JSON.stringify(jobRes.data)}`);
  const jobId = jobRes.data.id;

  const bidRes = await POST('/bids', {
    jobId,
    amount: 50000,
    tranche1Amount: 20000,
    tranche2Amount: 30000,
    coverNote: 'Expert servicing with OEM parts',
  }, artisanToken);
  if (bidRes.status !== 201) throw new Error(`Bid creation failed: ${JSON.stringify(bidRes.data)}`);
  const bidId = bidRes.data.id;

  // Accept bid -> Escrow created
  const acceptRes = await req({
    ...BASE,
    path: `/bids/${bidId}/accept`,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
  });
  if (acceptRes.status !== 200) throw new Error(`Bid accept failed: ${JSON.stringify(acceptRes.data)}`);
  const escrowId = acceptRes.data.escrow.id;
  console.log(`   ✅ Escrow created: ${escrowId} (Status: ${acceptRes.data.escrow.totalStatus})`);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 2: Online Payment Initialization (Checkout URL)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n4️⃣ Testing Online Checkout URL Generation (POST /payments/initialize)...');
  const initRes = await POST('/payments/initialize', { escrowId }, clientToken);
  console.log(`   Response Code: ${initRes.status}`);
  console.log('   Checkout Payload:', initRes.data);

  if (initRes.status !== 200 && initRes.status !== 201) {
    throw new Error(`Initialize Payment failed with status ${initRes.status}: ${JSON.stringify(initRes.data)}`);
  }
  if (!initRes.data.authorization_url || !initRes.data.reference) {
    throw new Error(`Invalid payment initialization response: ${JSON.stringify(initRes.data)}`);
  }
  console.log(`   ✅ Checkout URL generated: ${initRes.data.authorization_url}`);
  console.log(`   ✅ Paystack Reference: ${initRes.data.reference}`);
  const paystackRef = initRes.data.reference;

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 3: Pay-For-Me Multi-Channel Rails
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5️⃣ Testing Pay-For-Me Multi-Channel Rails (GET /payments/pay-for-me/:escrowId)...');
  const payForMeRes = await GET(`/payments/pay-for-me/${escrowId}`, clientToken);
  console.log(`   Response Code: ${payForMeRes.status}`);
  const share = payForMeRes.data;

  if (payForMeRes.status !== 200) {
    throw new Error(`Pay-For-Me failed with status ${payForMeRes.status}: ${JSON.stringify(share)}`);
  }
  if (!share.paymentRails?.onlineCheckoutUrl) {
    throw new Error('Pay-For-Me is missing onlineCheckoutUrl');
  }
  if (!share.paymentRails?.virtualAccount?.accountNumber) {
    throw new Error('Pay-For-Me is missing virtualAccount details');
  }
  if (!share.shareChannels?.whatsappUrl || !share.shareChannels?.smsUrl) {
    throw new Error('Pay-For-Me is missing social share channels');
  }
  console.log(`   ✅ Online Checkout Link: ${share.paymentRails.onlineCheckoutUrl}`);
  console.log(`   ✅ Dedicated Bank Transfer: ${share.paymentRails.virtualAccount.bankName} - ${share.paymentRails.virtualAccount.accountNumber}`);
  console.log(`   ✅ WhatsApp Share URL: ${share.shareChannels.whatsappUrl.slice(0, 50)}...`);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 4: Online Payment Webhook -> Escrow FUNDS_LOCKED
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6️⃣ Testing Webhook Execution on Checkout Reference...');
  const webhookBody = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: paystackRef,
      amount: 5000000, // 50,000 NGN in kobo
      currency: 'NGN',
      status: 'success',
      customer: { customer_code: dvaRes.data.customerCode || 'CUS_test' },
    },
  });
  const paystackSecret = process.env.PAYSTACK_SECRET_KEY || 'fake';
  const sig = crypto.createHmac('sha512', paystackSecret).update(webhookBody).digest('hex');

  const webhookRes = await req({
    ...BASE,
    path: '/payments/webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': sig,
    },
  }, webhookBody);
  console.log(`   Webhook Response Code: ${webhookRes.status}`);
  console.log('   Webhook Data:', webhookRes.data);

  if (webhookRes.data.status !== 'success') {
    throw new Error(`Webhook did not succeed: ${JSON.stringify(webhookRes.data)}`);
  }

  // Verify escrow in DB is now FUNDS_LOCKED and fundedVia is ONLINE
  const escrowCheck = await pgClient.query(`SELECT "totalStatus", "fundedVia" FROM escrow_transaction WHERE id = $1`, [escrowId]);
  const row = escrowCheck.rows[0];
  console.log(`   DB Escrow totalStatus: ${row?.totalStatus}, fundedVia: ${row?.fundedVia}`);
  if (row?.totalStatus !== 'FUNDS_LOCKED') {
    throw new Error(`Escrow status is ${row?.totalStatus}, expected FUNDS_LOCKED!`);
  }
  if (row?.fundedVia !== 'ONLINE') {
    throw new Error(`Escrow fundedVia is ${row?.fundedVia}, expected ONLINE!`);
  }
  console.log('   ✅ Escrow successfully locked with fundedVia: ONLINE!');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 5: Replay of the SAME funding webhook must NOT credit the wallet.
  // Pay-For-Me (step 5) overwrote paystackReference with a newer checkout, so the
  // paying reference (paystackRef) no longer matches it. Replay detection must use
  // fundedReference, otherwise this replay is credited as a second payment.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6b Replaying the identical funding webhook (must be idempotent, no wallet credit)...');
  const replayRes = await req({
    ...BASE,
    path: '/payments/webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': sig,
    },
  }, webhookBody);
  console.log(`   Replay Response: ${replayRes.status}`, replayRes.data);

  const refCheck = await pgClient.query(`SELECT "fundedReference" FROM escrow_transaction WHERE id = $1`, [escrowId]);
  if (refCheck.rows[0]?.fundedReference !== paystackRef) {
    throw new Error(`fundedReference is ${refCheck.rows[0]?.fundedReference}, expected ${paystackRef}`);
  }
  const overpay = await pgClient.query(`SELECT 1 FROM wallet_ledgers WHERE reference = $1`, [`overpay-${paystackRef}`]);
  const walletRow = await pgClient.query(`SELECT "walletBalance" FROM "user" WHERE id = $1`, [clientId]);
  if (overpay.rowCount > 0 || Number(walletRow.rows[0]?.walletBalance) !== 0) {
    throw new Error(`REPLAY CREDITED THE WALLET! overpay rows: ${overpay.rowCount}, balance: ${walletRow.rows[0]?.walletBalance}`);
  }
  console.log('   ✅ Replay acknowledged idempotently; wallet balance still 0.');

  // A genuinely different reference on the same funded escrow MUST still be credited.
  console.log('\n6c Paying a DIFFERENT reference on the funded escrow (must credit wallet once)...');
  const dupRef = `tark-${escrowId}-${Date.now()}`;
  const dupBody = JSON.stringify({
    event: 'charge.success',
    data: { reference: dupRef, amount: 5000000, currency: 'NGN', status: 'success', customer: { customer_code: dvaRes.data.customerCode || 'CUS_test' } },
  });
  const dupSig = crypto.createHmac('sha512', paystackSecret).update(dupBody).digest('hex');
  const dupHeaders = { 'Content-Type': 'application/json', 'x-paystack-signature': dupSig };
  const dup1 = await req({ ...BASE, path: '/payments/webhook', method: 'POST', headers: dupHeaders }, dupBody);
  const dup2 = await req({ ...BASE, path: '/payments/webhook', method: 'POST', headers: dupHeaders }, dupBody);
  console.log('   First :', dup1.data);
  console.log('   Replay:', dup2.data);
  const walletAfter = await pgClient.query(`SELECT "walletBalance" FROM "user" WHERE id = $1`, [clientId]);
  if (Number(walletAfter.rows[0]?.walletBalance) !== 50000) {
    throw new Error(`Expected wallet 50000 after one genuine overpayment, got ${walletAfter.rows[0]?.walletBalance}`);
  }
  console.log('   ✅ Different reference credited exactly once (wallet = 50000), its own replay ignored.');

  // ─────────────────────────────────────────────────────────────────────────────
  // CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n7️⃣ Cleaning up test data from Supabase...');
  const ids = [clientId, artisanId];
  const idList = ids.map((_, i) => `$${i + 1}`).join(',');
  await pgClient.query(`DELETE FROM wallet_ledgers WHERE "userId"::text IN (${idList})`, ids);
  await pgClient.query(`DELETE FROM notifications WHERE "userId"::text IN (${idList})`, ids);
  await pgClient.query(`DELETE FROM escrow_transaction WHERE id = $1`, [escrowId]);
  await pgClient.query(`DELETE FROM bid WHERE id = $1`, [bidId]);
  await pgClient.query(`DELETE FROM job WHERE id = $1`, [jobId]);
  await pgClient.query(`DELETE FROM "user" WHERE id::text IN (${idList})`, ids);
  await pgClient.end();

  console.log('\n================================================================');
  console.log('✨ ALL DVA & CHECKOUT URL RAILS PASSED 100% LIVE VERIFICATION!');
  console.log('================================================================\n');
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err.message);
  process.exit(1);
});
