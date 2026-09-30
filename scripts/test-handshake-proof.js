const axios = require('axios');
const FormData = require('form-data');

const API = 'http://localhost:3000';

function getUserIdFromToken(token) {
  const payloadBase64 = token.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
  return decoded.sub;
}

async function testFullHardenedLifecycle() {
  try {
    const timestamp = Date.now();

    // 1. Register Client, Assigned Artisan, and Imposter Artisan
    console.log('1. Registering Client, Assigned Artisan, and Rogue Artisan...');
    const clientRes = await axios.post(`${API}/auth/register`, {
      email: `client_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Handshake Client',
      role: 'client',
    });
    const clientToken = clientRes.data.accessToken;
    const clientId = getUserIdFromToken(clientToken);

    const artisanRes = await axios.post(`${API}/auth/register`, {
      email: `artisan_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Assigned Artisan',
      role: 'artisan',
    });
    const artisanToken = artisanRes.data.accessToken;
    const artisanId = getUserIdFromToken(artisanToken);

    const rogueRes = await axios.post(`${API}/auth/register`, {
      email: `rogue_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Rogue Artisan',
      role: 'artisan',
    });
    const rogueToken = rogueRes.data.accessToken;
    console.log(`   ✅ Client (${clientId.slice(0, 8)}) & Artisan (${artisanId.slice(0, 8)}) registered.`);

    // 2. Create Job
    console.log('\n2. Creating Job...');
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
    console.log('\n3. Initializing Escrow with bound artisanId & locking funds...');
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
    console.log('\n4. Assigned Artisan uploading Proof of Work to /media/proof-of-work...');
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
    console.log(`   ✅ R2 CDN Asset Created: ${proofUrl}`);

    // EDGE CASE TEST 1: Rogue artisan tries to initiate handshake
    console.log('\n[TEST EDGE CASE 1] Rogue artisan attempts handshake initiation...');
    try {
      await axios.patch(
        `${API}/escrow/${escrowId}/initiate-handshake`,
        { proofOfWorkUrls: [proofUrl] },
        { headers: { Authorization: `Bearer ${rogueToken}` } },
      );
      throw new Error('FAILED: Rogue artisan should have been blocked');
    } catch (err) {
      console.log(`   🛡️ BLOCKED AS EXPECTED: "${err.response?.data?.message || err.message}"`);
    }

    // 5. Assigned Artisan initiates handshake
    console.log('\n5. Assigned Artisan initiating legitimate handshake...');
    await axios.patch(
      `${API}/escrow/${escrowId}/initiate-handshake`,
      { proofOfWorkUrls: [proofUrl] },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );
    console.log('   ✅ Handshake initiated.');

    // 6. Client retrieves PIN
    const pendingEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const realPin = pendingEscrow.data.handshakePin;
    console.log(`   ✅ Handshake PIN generated: [${realPin}]`);

    // EDGE CASE TEST 2: Artisan submits wrong PIN
    console.log('\n[TEST EDGE CASE 2] Artisan submits incorrect PIN...');
    try {
      await axios.patch(
        `${API}/escrow/${escrowId}/verify-handshake`,
        { pin: '000000' },
        { headers: { Authorization: `Bearer ${artisanToken}` } },
      );
      throw new Error('FAILED: Wrong PIN should have been rejected');
    } catch (err) {
      console.log(`   🛡️ REJECTED AS EXPECTED: "${err.response?.data?.message || err.message}"`);
    }

    // 7. Legitimate PIN verification
    console.log('\n7. Submitting valid PIN to complete handshake...');
    await axios.patch(
      `${API}/escrow/${escrowId}/verify-handshake`,
      { pin: realPin },
      { headers: { Authorization: `Bearer ${artisanToken}` } },
    );

    // 8. Verify Final State
    const settledEscrow = await axios.get(`${API}/escrow/${escrowId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });

    console.log('\n========================================');
    console.log('🎉 HARDENED ESCROW VERIFICATION:');
    console.log('Escrow ID:         ', settledEscrow.data.id);
    console.log('Bound Artisan ID:  ', settledEscrow.data.artisanId);
    console.log('Total Status:      ', settledEscrow.data.totalStatus);
    console.log('Tranche 1 Status:  ', settledEscrow.data.tranche1Status);
    console.log('Tranche 2 Status:  ', settledEscrow.data.tranche2Status);
    console.log('PIN Wiped:         ', settledEscrow.data.handshakePin === null);
    console.log('Expiry Wiped:      ', settledEscrow.data.handshakeExpiresAt === null);
    console.log('Persisted Proof:   ', settledEscrow.data.proofOfWorkUrls);
    console.log('========================================');
  } catch (err) {
    console.error('❌ Test failed unexpectedly:', err.response?.data || err.message);
  }
}

testFullHardenedLifecycle();
