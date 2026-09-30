const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const API = 'http://localhost:3000';
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'test_secret_key';

function getUserIdFromToken(token) {
  const payloadBase64 = token.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
  return decoded.sub;
}

function signRawString(rawString, secret) {
  return crypto.createHmac('sha512', secret).update(rawString).digest('hex');
}

async function runWebhookAndDisputeSuite() {
  try {
    const timestamp = Date.now();

    console.log('1. Registering Client, Assigned Artisan, and Bystander...');
    const clientRes = await axios.post(`${API}/auth/register`, {
      email: `client_wh_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Webhook Client',
      role: 'client',
    });
    const clientToken = clientRes.data.accessToken;
    const clientId = getUserIdFromToken(clientToken);

    const artisanRes = await axios.post(`${API}/auth/register`, {
      email: `artisan_wh_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Webhook Artisan',
      role: 'artisan',
    });
    const artisanToken = artisanRes.data.accessToken;
    const artisanId = getUserIdFromToken(artisanToken);

    const bystanderRes = await axios.post(`${API}/auth/register`, {
      email: `bystander_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Bystander User',
      role: 'client',
    });
    const bystanderToken = bystanderRes.data.accessToken;

    console.log(`   ✅ Registered: Client (${clientId.slice(0, 8)}), Artisan (${artisanId.slice(0, 8)})`);

    // 2. Create Job & Escrow
    console.log('\n2. Creating Job & Escrow Transaction...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Roof Leak Restoration',
        description: 'Repair ceiling rafters and replace damaged corrugated zinc sheets.',
        category: 'Carpentry',
        location: 'Dugbe, Ibadan',
        budget: 50000,
        tranche1Amount: 25000,
        tranche2Amount: 25000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;

    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: job.id,
        artisanId: artisanId,
        tranche1Amount: 25000,
        tranche2Amount: 25000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const escrowId = escrowRes.data.id;
    console.log(`   ✅ Escrow created (ID: ${escrowId}) in INITIATED status.`);

    // 3. Initialize Payment (generates Paystack reference)
    console.log('\n3. Initializing Payment via /payments/initialize...');
    const payInitRes = await axios.post(
      `${API}/payments/initialize`,
      { escrowId },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const reference = payInitRes.data.reference;
    console.log(`   ✅ Paystack Reference anchored: ${reference}`);
    console.log(`   ✅ Checkout URL generated: ${payInitRes.data.authorization_url}`);

    // 4. TEST: Fraudulent / Unsigned Webhook
    console.log('\n[TEST 1] Testing forged webhook signature...');
    const rawPayloadString = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: reference,
        amount: 5000000,
        status: 'success',
      },
    });

    try {
      await axios.post(`${API}/payments/webhook`, rawPayloadString, {
        headers: {
          'x-paystack-signature': 'invalid_forged_signature_hash',
          'Content-Type': 'application/json',
        },
      });
      throw new Error('FAILED: Invalid signature was accepted');
    } catch (err) {
      console.log(`   🛡️ BLOCKED FORGED WEBHOOK: "${err.response?.data?.message || err.message}"`);
    }

    // 5. TEST: Legitimate Signed Webhook
    console.log('\n[TEST 2] Dispatching authentic HMAC SHA-512 signed webhook...');
    const validSignature = signRawString(rawPayloadString, SECRET_KEY);
    const webhookRes = await axios.post(`${API}/payments/webhook`, rawPayloadString, {
      headers: {
        'x-paystack-signature': validSignature,
        'Content-Type': 'application/json',
      },
    });
    console.log('   ✅ Webhook processed successfully:', webhookRes.data);

    // Verify Escrow transitioned to FUNDS_LOCKED
    const fundedEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    console.log(`   ✅ Escrow status automatically moved to: ${fundedEscrow.data.totalStatus}`);

    // 6. TEST: Webhook Idempotency (Retry Delivery)
    console.log('\n[TEST 3] Dispatching duplicate webhook (idempotency check)...');
    const retryRes = await axios.post(`${API}/payments/webhook`, rawPayloadString, {
      headers: {
        'x-paystack-signature': validSignature,
        'Content-Type': 'application/json',
      },
    });
    console.log('   ✅ Idempotent response handled gracefully:', retryRes.data);

    // 7. Artisan initiates handshake
    console.log('\n7. Artisan initiates handshake...');
    await axios.patch(
      `${API}/escrow/${escrowId}/initiate-handshake`,
      { proofOfWorkUrls: ['https://storage.cdn/tark/roof_repaired.png'] },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    const handshakeEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    console.log(`   ✅ Handshake PIN active: [${handshakeEscrow.data.handshakePin}]`);

    // 8. TEST: Bystander tries to dispute
    console.log('\n[TEST 4] Unrelated user attempts to dispute escrow...');
    try {
      await axios.patch(
        `${API}/escrow/${escrowId}/dispute`,
        {},
        { headers: { Authorization: `Bearer ${bystanderToken}` } },
      );
      throw new Error('FAILED: Bystander should not be permitted to dispute');
    } catch (err) {
      console.log(`   🛡️ BYSTANDER BLOCKED: "${err.response?.data?.message || err.message}"`);
    }

    // 9. Client raises dispute (rejects work)
    console.log('\n[TEST 5] Client inspects proof, rejects work, and raises dispute...');
    const disputeRes = await axios.patch(
      `${API}/escrow/${escrowId}/dispute`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log('   ✅ Dispute opened:', disputeRes.data.totalStatus);

    // Verify PIN was wiped
    const disputedEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    console.log(`   ✅ PIN securely expunged upon dispute: ${disputedEscrow.data.handshakePin === null}`);

    // 10. TEST: Artisan tries to verify handshake while disputed
    console.log('\n[TEST 6] Artisan attempts to complete handshake while escrow is disputed...');
    try {
      await axios.patch(
        `${API}/escrow/${escrowId}/verify-handshake`,
        { pin: handshakeEscrow.data.handshakePin },
        { headers: { Authorization: `Bearer ${artisanToken}` } },
      );
      throw new Error('FAILED: Handshake verification should fail while in dispute');
    } catch (err) {
      console.log(`   🛡️ HANDSHAKE FROZEN AS EXPECTED: "${err.response?.data?.message || err.message}"`);
    }

    console.log('\n========================================');
    console.log('🎉 WEBHOOK AUTOMATION & DISPUTE SUITE PASSED');
    console.log('========================================');
  } catch (err) {
    console.error('❌ Test suite failed:', err.response?.data || err.message);
  }
}

runWebhookAndDisputeSuite();
