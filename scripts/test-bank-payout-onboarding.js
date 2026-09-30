const axios = require('axios');

const API = 'http://localhost:3000';

function getUserIdFromToken(token) {
  const payloadBase64 = token.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
  return decoded.sub;
}

async function testBankPayoutLifecycle() {
  try {
    const timestamp = Date.now();

    // 1. Register Client and Artisan
    console.log('1. Registering Client and Artisan...');
    const clientRes = await axios.post(`${API}/auth/register`, {
      email: `client_payout_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Chief Client',
      role: 'client',
    });
    const clientToken = clientRes.data.accessToken;
    const clientId = getUserIdFromToken(clientToken);

    const artisanRes = await axios.post(`${API}/auth/register`, {
      email: `artisan_payout_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Samuel Adekunle',
      role: 'artisan',
    });
    const artisanToken = artisanRes.data.accessToken;
    const artisanId = getUserIdFromToken(artisanToken);

    console.log(`   ✅ Registered Client (${clientId.slice(0, 8)}) & Artisan (${artisanId.slice(0, 8)})`);

    // 2. Resolve Artisan NUBAN Account (e.g., GTBank: 058)
    console.log('\n2. Artisan resolving NUBAN bank account via Paystack directory...');
    const resolveRes = await axios.get(
      `${API}/payments/bank/resolve?accountNumber=0123456789&bankCode=058`,
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    console.log('   ✅ Bank Account Resolved:', resolveRes.data);

    // 3. Save Artisan Payout Details (generates Paystack Transfer Recipient)
    console.log('\n3. Artisan onboarding bank details to generate Paystack recipient code...');
    const saveBankRes = await axios.post(
      `${API}/payments/bank/save`,
      {
        accountNumber: '0123456789',
        bankCode: '058',
        currency: 'NGN',
      },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    const recipientCode = saveBankRes.data.recipientCode;
    console.log(`   ✅ Artisan Payout Recipient Code created: [${recipientCode}]`);

    // 4. Create Job & Escrow
    console.log('\n4. Client creating Job and initializing Escrow...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Security Gate Automation',
        description: 'Install sliding gate motor, gear racks, and infrared safety sensors.',
        category: 'Electrical',
        location: 'Oluyole, Ibadan',
        budget: 80000,
        tranche1Amount: 40000,
        tranche2Amount: 40000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;

    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: job.id,
        artisanId: artisanId,
        tranche1Amount: 40000,
        tranche2Amount: 40000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const escrowId = escrowRes.data.id;

    // Lock funds (simulating verified deposit)
    await axios.patch(
      `${API}/escrow/${escrowId}/lock-funds`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log(`   ✅ Escrow #${escrowId} status: FUNDS_LOCKED.`);

    // 5. Client releases Tranche 1 (Materials milestone) -> Automated payout triggers
    console.log('\n5. Client releasing Tranche 1 (Materials milestone)...');
    const tr1ReleaseRes = await axios.patch(
      `${API}/escrow/${escrowId}/release-tranche1`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log(`   ✅ Tranche 1 released! Escrow Status: ${tr1ReleaseRes.data.totalStatus}`);

    // 6. Artisan initiates handshake with proof
    console.log('\n6. Artisan initiates Handshake with proof of completion...');
    await axios.patch(
      `${API}/escrow/${escrowId}/initiate-handshake`,
      { proofOfWorkUrls: ['https://cdn.tark.africa/gate_motor_fitted.png'] },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    // Client reads PIN
    const pendingEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const pin = pendingEscrow.data.handshakePin;
    console.log(`   ✅ Handshake PIN received by Client: [${pin}]`);

    // 7. Artisan verifies PIN -> Automated final payout triggers
    console.log('\n7. Artisan enters PIN to complete handshake and trigger final settlement payout...');
    const verifyRes = await axios.patch(
      `${API}/escrow/${escrowId}/verify-handshake`,
      { pin },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    console.log('\n========================================');
    console.log('🎉 AUTOMATED PAYOUT & ONBOARDING VERIFIED:');
    console.log('Escrow ID:               ', verifyRes.data.id);
    console.log('Artisan Recipient Code:  ', recipientCode);
    console.log('Total Escrow Status:     ', verifyRes.data.totalStatus);
    console.log('Tranche 1 Status:        ', verifyRes.data.tranche1Status);
    console.log('Tranche 2 Status:        ', verifyRes.data.tranche2Status);
    console.log('PIN Expunged:            ', verifyRes.data.handshakePin === null);
    console.log('========================================');
  } catch (err) {
    console.error('❌ Bank payout test failed:', err.response?.data || err.message);
  }
}

testBankPayoutLifecycle();
