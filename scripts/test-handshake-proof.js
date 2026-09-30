const axios = require('axios');
const FormData = require('form-data');

const API = 'http://localhost:3000';

async function testFullHandshakeLifecycle() {
  try {
    const timestamp = Date.now();

    // 1. Register Client and Artisan
    console.log('1. Registering Client and Artisan...');
    const clientRes = await axios.post(`${API}/auth/register`, {
      email: `client_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Handshake Client',
      role: 'client',
    });
    const clientToken = clientRes.data.accessToken;

    const artisanRes = await axios.post(`${API}/auth/register`, {
      email: `artisan_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Handshake Artisan',
      role: 'artisan',
    });
    const artisanToken = artisanRes.data.accessToken;
    const artisanId = artisanRes.data.user?.id || artisanRes.data.id;

    // 2. Create Job
    console.log('2. Creating Job...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Borehole Submersible Pump Repair',
        description: 'Pump motor hums but does not lift water.',
        category: 'Plumbing',
        location: 'Bodija, Ibadan',
        budget: 60000,
        tranche1Amount: 30000,
        tranche2Amount: 30000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;

    // 3. Create Escrow & Lock Funds
    console.log('3. Initializing Escrow & locking client deposit...');
    const escrowRes = await axios.post(
      `${API}/escrow`,
      {
        jobId: job.id,
        artisanId: artisanId,
        tranche1Amount: 30000,
        tranche2Amount: 30000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const escrowId = escrowRes.data.id;

    await axios.patch(
      `${API}/escrow/${escrowId}/lock-funds`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log(`   ✅ Escrow #${escrowId} status: FUNDS_LOCKED.`);

    // 4. Artisan uploads Proof of Work to R2
    console.log('4. Artisan uploading Proof of Work to /media/proof-of-work...');
    const dummyImage = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a7df77e80000000049454e44ae426082',
      'hex',
    );
    const form = new FormData();
    form.append('files', dummyImage, {
      filename: `pump_installation_${timestamp}.png`,
      contentType: 'image/png',
    });

    const powUpload = await axios.post(`${API}/media/proof-of-work`, form, {
      headers: {
        Authorization: `Bearer ${artisanToken}`,
        ...form.getHeaders(),
      },
    });
    const proofUrl = powUpload.data[0].cdnUrl;
    console.log(`   ✅ Proof uploaded to R2: ${proofUrl}`);

    // 5. Artisan initiates handshake with proof attached
    console.log('5. Artisan initiating handshake with proofOfWorkUrls...');
    await axios.patch(
      `${API}/escrow/${escrowId}/initiate-handshake`,
      {
        proofOfWorkUrls: [proofUrl],
      },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    console.log('   ✅ Handshake initiated. Status: HANDSHAKE_PENDING.');

    // 6. Client inspects Escrow, reviews proof, and reads PIN
    console.log('6. Client inspecting Escrow proof and retrieving PIN...');
    const pendingEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const pin = pendingEscrow.data.handshakePin;
    console.log(`   ✅ Client verified proof of work: ${pendingEscrow.data.proofOfWorkUrls[0]}`);
    console.log(`   ✅ Handshake PIN received by Client: [${pin}]`);

    // 7. Artisan inputs the client PIN to verify and settle
    console.log('7. Artisan submitting PIN to /escrow/:id/verify-handshake...');
    const verifyRes = await axios.patch(
      `${API}/escrow/${escrowId}/verify-handshake`,
      { pin },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    console.log('   ✅ Verification response:', verifyRes.data);

    // 8. Verify final settled state
    const settledEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });

    console.log('\n========================================');
    console.log('🎉 FULL ESCROW LIFECYCLE SETTLED:');
    console.log('Escrow ID:         ', settledEscrow.data.id);
    console.log('Total Status:      ', settledEscrow.data.totalStatus);
    console.log('Tranche 1 Status:  ', settledEscrow.data.tranche1Status);
    console.log('Tranche 2 Status:  ', settledEscrow.data.tranche2Status);
    console.log('PIN Cleared:       ', settledEscrow.data.handshakePin === null ? 'YES (Securely cleared)' : settledEscrow.data.handshakePin);
    console.log('Persisted Proof:   ', settledEscrow.data.proofOfWorkUrls);
    console.log('========================================');
  } catch (err) {
    console.error('❌ Lifecycle failed:', err.response?.data || err.message);
  }
}

testFullHandshakeLifecycle();
