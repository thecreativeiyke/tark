const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let paystackSecret = 'test_secret_fallback';
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/PAYSTACK_SECRET_KEY=(.*)/);
  if (match && match[1]) {
    paystackSecret = match[1].trim();
  }
} catch (e) {}

const API = 'http://localhost:3000';

async function testFullPayoutCycle() {
  const timestamp = Date.now();
  console.log('🚀 Running Full Tark Financial Circuit & Payout Test...\n');

  try {
    // 1. Register Artisan
    const artisanEmail = `artisan_payout_${timestamp}@test.com`;
    console.log(`1. Registering Artisan (${artisanEmail})...`);
    const artReg = await axios.post(`${API}/auth/register`, {
      email: artisanEmail,
      password: 'Password123!',
      fullName: 'Babatunde Electrician',
      role: 'artisan',
    });
    const artisanToken = artReg.data.accessToken;

    const artisanProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${artisanToken}` },
    });
    const artisanId = artisanProfile.data.id;
    console.log(`   ✅ Artisan ID: ${artisanId}`);

    // 2. Artisan Saves Bank Account (e.g. OPay / Wema)
    console.log('2. Linking Artisan bank account for automated payouts...');
    const bankRes = await axios.post(
      `${API}/payments/bank/save`,
      {
        accountNumber: '9648838609',
        bankCode: '999992', // OPay / Paystack-Titan bank code
      },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    console.log(`   ✅ Bank linked: ${bankRes.data.accountName}`);
    console.log(`   ✅ Paystack Recipient Code: ${bankRes.data.recipientCode}`);

    // 3. Register Client & Provision DVA
    const clientEmail = `client_payout_${timestamp}@test.com`;
    console.log(`\n3. Registering Client (${clientEmail})...`);
    const clientReg = await axios.post(`${API}/auth/register`, {
      email: clientEmail,
      password: 'Password123!',
      fullName: 'Folake Ademola',
      role: 'client',
    });
    const clientToken = clientReg.data.accessToken;

    const dvaRes = await axios.post(
      `${API}/payments/dedicated-account`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const customerCode = dvaRes.data.customerCode;
    console.log(`   ✅ Client DVA provisioned. Customer: ${customerCode}`);

    // 4. Client Tops Up Wallet with ₦30,000 via Inbound Transfer Webhook
    console.log('4. Simulating bank transfer of ₦30,000 to Client DVA...');
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        amount: 30000 * 100, // ₦30,000 in kobo
        currency: 'NGN',
        reference: `TOPUP-${timestamp}`,
        customer: {
          customer_code: customerCode,
          email: clientEmail,
        },
      },
    });

    const signature = crypto
      .createHmac('sha512', paystackSecret)
      .update(Buffer.from(webhookPayload))
      .digest('hex');

    await axios.post(`${API}/payments/webhook`, JSON.parse(webhookPayload), {
      headers: { 'x-paystack-signature': signature },
    });

    const clientFunded = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    console.log(`   ✅ Client Wallet Balance: ₦${clientFunded.data.walletBalance}`);

    // 5. Client Creates Job & Initiates Escrow for ₦25,000
    console.log('\n5. Creating Job and Escrow (Tranche 1: ₦10,000 | Tranche 2: ₦15,000)...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Full Duplex Electrical Rewiring',
        description: 'Complete conduit piping and DB box installation',
        category: 'electrical',
        budget: 25000,
        tranche1Amount: 10000,
        tranche2Amount: 15000,
        location: 'Ring Road, Ibadan',
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;

    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: job.id,
        artisanId: artisanId,
        tranche1Amount: 10000,
        tranche2Amount: 15000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const escrowId = escrowRes.data.id;
    console.log(`   ✅ Escrow created: ${escrowId}`);

    // 6. Fund Escrow directly with Wallet
    console.log('6. Locking ₦25,000 into Escrow from Client Wallet...');
    const fundRes = await axios.post(
      `${API}/payments/fund-with-wallet`,
      { escrowId },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log(`   ✅ Escrow Status: ${fundRes.data.escrow.totalStatus}`);
    console.log(`   ✅ Client Wallet Remaining: ₦${fundRes.data.remainingBalance}`);

    // 7. Client Releases Tranche 1 -> Triggers Automated Transfer to Artisan
    console.log('\n7. Client releasing Tranche 1 (₦10,000 upfront materials fee)...');
    const tranche1Res = await axios.patch(
      `${API}/escrow/${escrowId}/release-tranche1`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log(`   ✅ Tranche 1 Status: ${tranche1Res.data.tranche1Status}`);
    console.log(`   ✅ Escrow State: ${tranche1Res.data.totalStatus}`);

    // 8. Work Completed -> Artisan Requests Handshake
    console.log('\n8. Artisan requesting completion handshake...');
    await axios.patch(
      `${API}/escrow/${escrowId}/initiate-handshake`,
      {},
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    // 9. Client receives PIN
    const clientEscrowView = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const pin = clientEscrowView.data.handshakePin;
    console.log(`   🔑 Client received completion verification PIN: [ ${pin} ]`);

    // 10. Artisan verifies PIN -> Triggers Tranche 2 Automated Payout & Job Completion
    console.log('10. Artisan submitting PIN to verify completion and claim Tranche 2...');
    const verifyRes = await axios.patch(
      `${API}/escrow/${escrowId}/verify-handshake`,
      { pin },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    const completedJob = await axios.get(`${API}/jobs/${job.id}`);

    console.log('\n========================================');
    console.log('🎉 FINAL TRANSACTION RESULTS:');
    console.log(`   Escrow Total Status: ${verifyRes.data.totalStatus}`);
    console.log(`   Tranche 1 Status:     ${verifyRes.data.tranche1Status}`);
    console.log(`   Tranche 2 Status:     ${verifyRes.data.tranche2Status}`);
    console.log(`   Job Status:           ${completedJob.data.status}`);
    console.log('========================================');
    console.log('✨ All payouts and state transitions executed cleanly.');
  } catch (err) {
    console.error('\n❌ Test failed:');
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error('Data:', err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

testFullPayoutCycle();
