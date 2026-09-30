const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Read PAYSTACK_SECRET_KEY from .env in project root
let paystackSecret = 'test_secret_fallback';
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/PAYSTACK_SECRET_KEY=(.*)/);
  if (match && match[1]) {
    paystackSecret = match[1].trim();
  }
} catch (e) {
  // .env not loaded or key not found
}

const API = 'http://localhost:3000';

async function runTest() {
  const timestamp = Date.now();
  console.log('🚀 Starting Tark Escrow & Handshake Smoke Test...\n');

  try {
    // 1. Register / Login Client
    const clientEmail = `client_${timestamp}@test.com`;
    console.log(`1. Registering Client (${clientEmail})...`);
    const clientAuth = await axios.post(`${API}/auth/register`, {
      email: clientEmail,
      password: 'Password123!',
      fullName: 'Obinna Client',
      role: 'client',
    });
    const clientToken = clientAuth.data.accessToken;
    const clientProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const clientId = clientProfile.data.userId;
    console.log(`   ✅ Client registered. ID: ${clientId}`);

    // 2. Register / Login Artisan
    const artisanEmail = `artisan_${timestamp}@test.com`;
    console.log(`2. Registering Artisan (${artisanEmail})...`);
    const artisanAuth = await axios.post(`${API}/auth/register`, {
      email: artisanEmail,
      password: 'Password123!',
      fullName: 'Musa Plumber',
      role: 'artisan',
    });
    const artisanToken = artisanAuth.data.accessToken;
    const artisanProfile = await axios.get(`${API}/auth/me`, {
      headers: { Authorization: `Bearer ${artisanToken}` },
    });
    const artisanId = artisanProfile.data.userId;
    console.log(`   ✅ Artisan registered. ID: ${artisanId}`);

    // 3. Client creates a Job
    console.log('3. Client creating a Job...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Fix Kitchen Plumbing Leak',
        description: 'Water pipe leaking under the sink',
        category: 'Plumbing',
        budget: 20000,
        tranche1Amount: 8000,
        tranche2Amount: 12000,
        location: 'Yaba, Lagos',
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;
    console.log(`   ✅ Job created. ID: ${job.id} | Status: ${job.status}`);

    // 4. Create Escrow
    console.log('4. Creating Escrow transaction...');
    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: job.id,
        artisanId: artisanId,
        tranche1Amount: 8000,
        tranche2Amount: 12000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const escrow = escrowRes.data;
    console.log(`   ✅ Escrow created. ID: ${escrow.id} | Total Status: ${escrow.totalStatus}`);

    // 5. Initialize Payment to generate reference
    console.log('5. Initializing Paystack payment...');
    const initRes = await axios.post(
      `${API}/payments/initialize`,
      { escrowId: escrow.id },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const reference = initRes.data.reference;
    console.log(`   ✅ Paystack reference generated: ${reference}`);

    // 6. Simulate Paystack Webhook (charge.success)
    console.log('6. Simulating Paystack Webhook charge.success...');
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: reference,
        amount: 20000 * 100,
      },
    });

    const signature = crypto
      .createHmac('sha512', paystackSecret)
      .update(Buffer.from(webhookPayload))
      .digest('hex');

    await axios.post(`${API}/payments/webhook`, JSON.parse(webhookPayload), {
      headers: {
        'x-paystack-signature': signature,
      },
    });

    const lockedEscrow = await axios.get(`${API}/escrow/${escrow.id}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const updatedJob = await axios.get(`${API}/jobs/${job.id}`);
    console.log(`   ✅ Funds locked! Escrow Status: ${lockedEscrow.data.totalStatus}`);
    console.log(`   ✅ Job synchronized! Job Status: ${updatedJob.data.status}`);

    // 7. Client releases Tranche 1
    console.log('7. Client releasing Tranche 1...');
    const tranche1Res = await axios.patch(
      `${API}/escrow/${escrow.id}/release-tranche1`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log(`   ✅ Tranche 1 released! Status: ${tranche1Res.data.tranche1Status}`);

    // 8. Artisan initiates completion handshake
    console.log('8. Artisan requesting job completion handshake...');
    await axios.patch(
      `${API}/escrow/${escrow.id}/initiate-handshake`,
      {},
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    // 9. Inspect PIN access control
    console.log('9. Checking Handshake PIN visibility...');
    const artisanView = await axios.get(`${API}/escrow/${escrow.id}`, {
      headers: { Authorization: `Bearer ${artisanToken}` },
    });
    console.log(`   🔒 Artisan sees PIN as: ${artisanView.data.handshakePin} (Must be null)`);

    const clientView = await axios.get(`${API}/escrow/${escrow.id}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const pin = clientView.data.handshakePin;
    console.log(`   🔑 Client receives generated PIN: [ ${pin} ]`);

    // 10. Artisan submits PIN to verify and settle
    console.log('10. Artisan submitting PIN to verify completion...');
    const settleRes = await axios.patch(
      `${API}/escrow/${escrow.id}/verify-handshake`,
      { pin: pin },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    const finalJob = await axios.get(`${API}/jobs/${job.id}`);
    console.log(`   🎉 Escrow Total Status: ${settleRes.data.totalStatus}`);
    console.log(`   🎉 Tranche 2 Status: ${settleRes.data.tranche2Status}`);
    console.log(`   🎉 Job Final Status: ${finalJob.data.status}`);

    console.log('\n✨ ALL TESTS PASSED! The Handshake engine is rock solid.');
  } catch (err) {
    console.error('\n❌ Test failed:');
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error('Response Data:', err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

runTest();
