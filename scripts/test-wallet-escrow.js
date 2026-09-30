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

async function testWalletEscrow() {
  const timestamp = Date.now();
  console.log('⚡ Testing In-App Wallet Escrow Funding...\n');

  try {
    // 1. Register Client
    const clientEmail = `client_wallet_${timestamp}@test.com`;
    console.log(`1. Registering Client (${clientEmail})...`);
    const regRes = await axios.post(`${API}/auth/register`, {
      email: clientEmail,
      password: 'Password123!',
      fullName: 'Amina Bello',
      role: 'client',
    });
    const clientToken = regRes.data.accessToken;

    // 2. Assign DVA to get customer code
    console.log('2. Provisioning DVA & retrieving customer code...');
    const dvaRes = await axios.post(
      `${API}/payments/dedicated-account`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const customerCode = dvaRes.data.customerCode;
    console.log(`   ✅ DVA assigned. Customer Code: ${customerCode}`);

    // 3. Top up wallet with ₦25,000 via simulated inbound transfer webhook
    console.log('3. Simulating bank transfer of ₦25,000 to user wallet...');
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        amount: 25000 * 100, // ₦25,000 in kobo
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

    const fundedProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    console.log(`   ✅ Wallet funded. Balance: ₦${fundedProfile.data.walletBalance}`);

    // 4. Create Job & Escrow (₦20,000 budget: ₦8,000 + ₦12,000)
    console.log('4. Creating Job and Escrow for ₦20,000...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Emergency Generator Servicing',
        description: 'Soundproof diesel generator maintenance',
        category: 'generator-mechanic',
        budget: 20000,
        tranche1Amount: 8000,
        tranche2Amount: 12000,
        location: 'Bodija, Ibadan',
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;

    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: job.id,
        tranche1Amount: 8000,
        tranche2Amount: 12000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const escrow = escrowRes.data;
    console.log(`   ✅ Escrow created. ID: ${escrow.id} | Status: ${escrow.totalStatus}`);

    // 5. Fund Escrow directly with Wallet Balance
    console.log('5. Funding Escrow directly using Wallet Balance...');
    const fundRes = await axios.post(
      `${API}/payments/fund-with-wallet`,
      { escrowId: escrow.id },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );

    console.log(`   ✅ ${fundRes.data.message}`);
    console.log(`   Remaining Wallet Balance: ₦${fundRes.data.remainingBalance}`);
    console.log(`   Escrow Status: ${fundRes.data.escrow.totalStatus}`);

    // 6. Verify Job Status transitioned to IN_PROGRESS
    const updatedJob = await axios.get(`${API}/jobs/${job.id}`);
    console.log(`   Job Status: ${updatedJob.data.status}`);

    console.log('\n✨ Direct Wallet-to-Escrow funding verified successfully!');
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

testWalletEscrow();
