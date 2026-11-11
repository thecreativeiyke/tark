const http = require('http');
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function decodeJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

async function runActiveHacking() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run active hacking penetration script against NODE_ENV=production!');
  }
  console.log('================================================================');
  console.log('💥 RED-TEAM ACTIVE PENETRATION SUITE: FINANCIAL SINKS (C-1..C-3)');
  console.log('================================================================\n');

  const timestamp = Date.now();
  const artisanEmail = `hacker.artisan.${timestamp}@tark.ng`;
  const clientEmail = `hacker.client.${timestamp}@tark.ng`;
  const password = 'StrongPassword123!';

  // ─────────────────────────────────────────────────────────────────────────────
  // 0. SET UP TEST ACTORS & JOB
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('0️⃣ Setting up Certified Artisan and Client...');
  const regArtisan = await request(
    { hostname: 'localhost', port: 3000, path: '/auth/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { email: artisanEmail, password, fullName: 'Chidi Okonkwo', role: 'artisan' },
  );
  const artisanToken = regArtisan.data.accessToken;
  const artisanId = decodeJwt(artisanToken).sub;

  // Verify artisan via DB so they can bid
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query(`UPDATE "user" SET "isCertifiedByTark" = true, "certificationBadgeTitle" = 'Tark Certified Artisan' WHERE id = $1`, [artisanId]);

  const regClient = await request(
    { hostname: 'localhost', port: 3000, path: '/auth/register', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { email: clientEmail, password, fullName: 'Madam Ngozi', role: 'client' },
  );
  const clientToken = regClient.data.accessToken;

  // Post open job
  const jobRes = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/jobs',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
    },
    {
      title: 'Solar Inverter Failure in Ikeja GRA',
      description: 'Batteries not holding charge.',
      category: 'Solar & Inverter Systems',
      budget: 100000,
      tranche1Amount: 40000,
      tranche2Amount: 60000,
      location: 'Isaac John Street, Ikeja',
    },
  );
  const jobId = jobRes.data.id;
  console.log(`   ✅ Job created: ${jobId}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK C-3: TRANCHE SPLIT & FEE AVOIDANCE EXPLOIT
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️ ATTACK 1 (C-3): Malicious 100% Upfront Payout (0% Tranche 2)...');
  const attack100Upfront = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/bids',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    {
      jobId,
      amount: 100000,
      tranche1Amount: 100000, // 100% upfront
      tranche2Amount: 0,
      coverNote: 'Hacker attempting 100% upfront extraction',
    },
  );
  console.log(`   Response Code: ${attack100Upfront.status}`);
  console.log(`   Response Message: "${attack100Upfront.data.message}"`);
  if (attack100Upfront.status !== 400) {
    throw new Error('Exploit C-3 Succeeded! 100% upfront bid was accepted.');
  }
  console.log('   🛡️ SEALED: 100% upfront bid rejected with 400 Bad Request.');

  console.log('\n⚔️ ATTACK 2 (C-3): Skewed Tranche Split (20% Tranche 1 / 80% Tranche 2)...');
  const attackSkewedSplit = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/bids',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    {
      jobId,
      amount: 100000,
      tranche1Amount: 20000, // 20% < 30% lower bound
      tranche2Amount: 80000,
      coverNote: 'Hacker attempting non-standard split',
    },
  );
  console.log(`   Response Code: ${attackSkewedSplit.status}`);
  console.log(`   Response Message: "${attackSkewedSplit.data.message}"`);
  if (attackSkewedSplit.status !== 400) {
    throw new Error('Exploit C-3 Succeeded! Sub-30% tranche split was accepted.');
  }
  console.log('   🛡️ SEALED: Non-compliant tranche split rejected with 400 Bad Request.');

  console.log('\n⚔️ ATTACK 3 (C-3): Floating Point Decimal Slop (tranches do not sum to total)...');
  const attackFloatingSlop = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/bids',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    {
      jobId,
      amount: 100000,
      tranche1Amount: 40000.40,
      tranche2Amount: 59999.50, // Sum = 99999.90 != 100000
      coverNote: 'Hacker attempting rounding mismatch',
    },
  );
  console.log(`   Response Code: ${attackFloatingSlop.status}`);
  console.log(`   Response Message: "${attackFloatingSlop.data.message}"`);
  if (attackFloatingSlop.status !== 400) {
    throw new Error('Exploit C-3 Succeeded! Tranche rounding mismatch accepted.');
  }
  console.log('   🛡️ SEALED: Decimal rounding mismatch rejected with 400 Bad Request.');

  // Place valid 40/60 bid
  console.log('\n✅ Submitting Valid 40/60 Compliant Bid (NGN 40,000 / 60,000)...');
  const validBid = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/bids',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    {
      jobId,
      amount: 100000,
      tranche1Amount: 40000,
      tranche2Amount: 60000,
      coverNote: 'Proper ADR 001 compliant bid.',
    },
  );
  console.log(`   Bid Response Code: ${validBid.status}`);
  const bidId = validBid.data.id;

  // Accept bid & create escrow
  console.log('\n✅ Client accepting compliant bid...');
  const acceptRes = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: `/bids/${bidId}/accept`,
      method: 'PATCH',
      headers: { Authorization: `Bearer ${clientToken}` },
    },
  );
  console.log(`   Accept Bid Status: ${acceptRes.status}`, acceptRes.data);
  const escrowId = acceptRes.data?.escrow?.id;
  console.log(`   Safe-Lock Escrow Created: ${escrowId}`);

  // Lock escrow funds via DB for testing
  await pgClient.query(`UPDATE "escrow_transaction" SET "totalStatus" = 'FUNDS_LOCKED', "tranche1Status" = 'LOCKED', "tranche2Status" = 'LOCKED' WHERE id = $1`, [escrowId]);

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK C-2: PIN BRUTE-FORCE LOCKOUT & RESTART CYCLE ATTACK
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️ ATTACK 4 (C-2): Handshake PIN Brute-Force & Reset Lockout Loop...');
  const initHandshake = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: `/escrow/${escrowId}/initiate-handshake`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    {
      proofOfWorkUrls: ['https://iyke-storage-gateway.iyke-storage-gateway.workers.dev/cdn/escrow/proof-of-work/solar-proof.jpg'],
    },
  );
  console.log(`   Initiate Handshake: ${initHandshake.status} ("${initHandshake.data.message?.slice(0, 40)}...")`);
  if (initHandshake.status !== 200) {
    throw new Error(`Setup failed: initiate-handshake returned ${initHandshake.status} ${JSON.stringify(initHandshake.data)} (check the proof URL host matches STORAGE_CUSTOM_CDN_URL)`);
  }

  // Exhaust 5 attempts
  console.log('   Simulating 5 consecutive wrong PIN guesses...');
  for (let i = 1; i <= 5; i++) {
    const guess = await request(
      {
        hostname: 'localhost',
        port: 3000,
        path: `/escrow/${escrowId}/verify-handshake`,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
      },
      { pin: '000000' },
    );
    console.log(`   - Guess #${i}: Code ${guess.status} ("${guess.data.message}")`);
  }

  // Attempt 6th guess (must be locked!)
  console.log('   Attempting 6th guess on locked handshake...');
  const guess6 = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: `/escrow/${escrowId}/verify-handshake`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    { pin: '000000' },
  );
  console.log(`   Response Code: ${guess6.status}`);
  console.log(`   Lockout Message: "${guess6.data.message}"`);

  // Try to bypass lockout by immediately re-initiating handshake
  console.log('   Adversary attempts to bypass lockout by immediately calling initiate-handshake...');
  const bypassAttempt = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: `/escrow/${escrowId}/initiate-handshake`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${artisanToken}` },
    },
    {
      proofOfWorkUrls: ['https://iyke-storage-gateway.iyke-storage-gateway.workers.dev/cdn/escrow/proof-of-work/solar-proof.jpg'],
    },
  );
  console.log(`   Bypass Response Code: ${bypassAttempt.status}`);
  console.log(`   Bypass Message: "${bypassAttempt.data.message}"`);
  if (bypassAttempt.status === 200 || !String(bypassAttempt.data?.message).toLowerCase().includes('locked out')) {
    throw new Error('Exploit C-2 Succeeded! Handshake was allowed to restart immediately after lockout.');
  }
  console.log('   🛡️ SEALED: Immediate handshake restart blocked by exponential cooldown.');

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK C-1: PAYSTACK WEBHOOK REPLAY & WALLET CREDIT IDEMPOTENCY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️ ATTACK 5 (C-1): Webhook Replay Attack on Wallet Credit...');
  const paystackSecret = process.env.PAYSTACK_SECRET_KEY || 'sk_test_fake';
  const customerCode = `CUS_TEST_${timestamp}`;
  await pgClient.query(`UPDATE "user" SET "paystackCustomerCode" = $1, "walletBalance" = 5000 WHERE id = $2`, [customerCode, artisanId]);

  const webhookRef = `TARK_DEP_${timestamp}_REPLAY_TEST`;
  const webhookPayload = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: webhookRef,
      amount: 500000, // NGN 5,000 in minor kobo
      currency: 'NGN',
      status: 'success',
      customer: { customer_code: customerCode },
    },
  });

  const webhookSignature = crypto.createHmac('sha512', paystackSecret).update(webhookPayload).digest('hex');

  // Fire webhook delivery 1
  console.log('   Delivery 1: Firing initial signed webhook deposit...');
  const delivery1 = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/payments/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': webhookSignature,
      },
    },
    webhookPayload,
  );
  console.log(`   Delivery 1 Response:`, delivery1.data);

  // Fire replayed duplicate webhook delivery 2
  console.log('   Delivery 2: Firing REPLAYED duplicate signed webhook deposit...');
  const delivery2 = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/payments/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': webhookSignature,
      },
    },
    webhookPayload,
  );
  console.log(`   Delivery 2 Response:`, delivery2.data);

  // Check user balance in DB — MUST BE NGN 10,000 (5,000 original + 5,000 deposit), NOT 15,000!
  const userCheck = await pgClient.query(`SELECT "walletBalance" FROM "user" WHERE id = $1`, [artisanId]);
  const finalBalance = Number(userCheck.rows[0].walletBalance);
  console.log(`   Final Wallet Balance in DB: NGN ${finalBalance}`);
  if (finalBalance !== 10000) {
    throw new Error(`Exploit C-1 Succeeded! Wallet balance was credited twice: NGN ${finalBalance}`);
  }
  console.log('   🛡️ SEALED: Webhook replay successfully deduplicated. Wallet credited exactly once!');

  // CLEANUP: remove every row this run created so the shared DB stays clean
  const ids = [artisanId, decodeJwt(clientToken).sub];
  await pgClient.query(`DELETE FROM wallet_ledgers WHERE "userId"::text = ANY($1::text[])`, [ids]);
  await pgClient.query(`DELETE FROM notifications WHERE "userId"::text = ANY($1::text[])`, [ids]);
  await pgClient.query(`DELETE FROM escrow_transaction WHERE "jobId"::text = $1`, [jobId]);
  await pgClient.query(`DELETE FROM bid WHERE "jobId"::text = $1`, [jobId]);
  await pgClient.query(`DELETE FROM job WHERE id::text = $1`, [jobId]);
  await pgClient.query(`DELETE FROM "user" WHERE id::text = ANY($1::text[])`, [ids]);

  await pgClient.end();
  console.log('\n================================================================');
  console.log('✨ ALL ACTIVE RED-TEAM PENETRATION ATTACKS WERE 100% REPELLED!');
  console.log('================================================================\n');
}

runActiveHacking().catch((err) => {
  console.error('\n❌ RED-TEAM TEST FAILED:', err);
  process.exit(1);
});
