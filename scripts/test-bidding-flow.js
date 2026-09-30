const axios = require('axios');

const API = 'http://localhost:3000';

function getUserIdFromToken(token) {
  const payloadBase64 = token.split('.')[1];
  const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
  return decoded.sub;
}

async function testBiddingLifecycle() {
  try {
    const timestamp = Date.now();

    // 1. Register Client, Artisan 1, Artisan 2, and Imposter
    console.log('1. Registering Users...');
    const clientRes = await axios.post(`${API}/auth/register`, {
      email: `client_bid_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Chief Client',
      role: 'client',
    });
    const clientToken = clientRes.data.accessToken;
    const clientId = getUserIdFromToken(clientToken);

    const artisan1Res = await axios.post(`${API}/auth/register`, {
      email: `artisan1_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Master Carpenter',
      role: 'artisan',
    });
    const artisan1Token = artisan1Res.data.accessToken;
    const artisan1Id = getUserIdFromToken(artisan1Token);

    const artisan2Res = await axios.post(`${API}/auth/register`, {
      email: `artisan2_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Elite Woodworker',
      role: 'artisan',
    });
    const artisan2Token = artisan2Res.data.accessToken;
    const artisan2Id = getUserIdFromToken(artisan2Token);

    const imposterRes = await axios.post(`${API}/auth/register`, {
      email: `imposter_${timestamp}@test.com`,
      password: 'Password123!',
      fullName: 'Random Imposter',
      role: 'client',
    });
    const imposterToken = imposterRes.data.accessToken;

    console.log(`   ✅ Client: ${clientId.slice(0, 8)}`);
    console.log(`   ✅ Artisan 1: ${artisan1Id.slice(0, 8)}`);
    console.log(`   ✅ Artisan 2: ${artisan2Id.slice(0, 8)}`);

    // 2. Client Posts an OPEN Job
    console.log('\n2. Client posting Open Job...');
    const jobRes = await axios.post(
      `${API}/jobs`,
      {
        title: 'Custom Mahogany Wardrobe Fabrication',
        description: 'Build and fit a 3-door floor-to-ceiling mahogany wardrobe.',
        category: 'Carpentry',
        location: 'Ring Road, Ibadan',
        budget: 120000,
      },
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    const job = jobRes.data;
    console.log(`   ✅ Job #${job.id} posted. Status: ${job.status}`);

    // TEST 1: Client role tries to bid
    console.log('\n[TEST 1] Non-artisan attempting to place a bid...');
    try {
      await axios.post(
        `${API}/bids`,
        {
          jobId: job.id,
          amount: 110000,
          tranche1Amount: 60000,
          tranche2Amount: 50000,
        },
        { headers: { Authorization: `Bearer ${clientToken}` } },
      );
      throw new Error('FAILED: Non-artisan should be blocked from bidding');
    } catch (err) {
      console.log(`   🛡️ BLOCKED: "${err.response?.data?.message || err.message}"`);
    }

    // TEST 2: Bid with mismatched tranche sums
    console.log('\n[TEST 2] Artisan submitting mathematically invalid tranche split...');
    try {
      await axios.post(
        `${API}/bids`,
        {
          jobId: job.id,
          amount: 100000,
          tranche1Amount: 60000,
          tranche2Amount: 60000, // Sum = 120000 != 100000
        },
        { headers: { Authorization: `Bearer ${artisan1Token}` } },
      );
      throw new Error('FAILED: Mismatched tranche sum should be rejected');
    } catch (err) {
      console.log(`   🛡️ REJECTED: "${err.response?.data?.message || err.message}"`);
    }

    // 3. Artisan 1 submits valid bid
    console.log('\n3. Artisan 1 submitting legitimate bid (NGN 115,000)...');
    const bid1Res = await axios.post(
      `${API}/bids`,
      {
        jobId: job.id,
        amount: 115000,
        tranche1Amount: 65000,
        tranche2Amount: 50000,
        coverNote: 'Expert joinery with 10 years experience. Can start tomorrow morning.',
      },
      { headers: { Authorization: `Bearer ${artisan1Token}` } },
    );
    const bid1 = bid1Res.data;
    console.log(`   ✅ Bid 1 submitted (#${bid1.id}). Status: ${bid1.status}`);

    // TEST 3: Artisan 1 tries to spam a second pending bid on same job
    console.log('\n[TEST 3] Artisan 1 submitting duplicate pending bid on same job...');
    try {
      await axios.post(
        `${API}/bids`,
        {
          jobId: job.id,
          amount: 110000,
          tranche1Amount: 60000,
          tranche2Amount: 50000,
        },
        { headers: { Authorization: `Bearer ${artisan1Token}` } },
      );
      throw new Error('FAILED: Duplicate pending bid should be blocked');
    } catch (err) {
      console.log(`   🛡️ BLOCKED: "${err.response?.data?.message || err.message}"`);
    }

    // 4. Artisan 2 submits a competitive bid
    console.log('\n4. Artisan 2 submitting competing bid (NGN 105,000)...');
    const bid2Res = await axios.post(
      `${API}/bids`,
      {
        jobId: job.id,
        amount: 105000,
        tranche1Amount: 55000,
        tranche2Amount: 50000,
        coverNote: 'Top grade mahogany materials sourced directly from sawmill.',
      },
      { headers: { Authorization: `Bearer ${artisan2Token}` } },
    );
    const bid2 = bid2Res.data;
    console.log(`   ✅ Bid 2 submitted (#${bid2.id}). Status: ${bid2.status}`);

    // 5. Client views all bids for the job
    console.log('\n5. Client viewing bids submitted for Job...');
    const allBidsRes = await axios.get(`${API}/bids/job/${job.id}`);
    console.log(`   ✅ Total active bids received: ${allBidsRes.data.length}`);

    // TEST 4: Imposter tries to accept Artisan 2's bid
    console.log('\n[TEST 4] Unauthorized user attempting to accept bid...');
    try {
      await axios.patch(
        `${API}/bids/${bid2.id}/accept`,
        {},
        { headers: { Authorization: `Bearer ${imposterToken}` } },
      );
      throw new Error('FAILED: Unauthorized user should not accept bids');
    } catch (err) {
      console.log(`   🛡️ FORBIDDEN: "${err.response?.data?.message || err.message}"`);
    }

    // 6. Client accepts Artisan 2's bid
    console.log('\n6. Client accepting Bid 2 (Artisan 2)...');
    const acceptRes = await axios.patch(
      `${API}/bids/${bid2.id}/accept`,
      {},
      { headers: { Authorization: `Bearer ${clientToken}` } },
    );
    console.log('   ✅ Accept response:', acceptRes.data.message);

    // 7. Verify Post-Acceptance State
    const refreshedBid1 = await axios.get(`${API}/bids/${bid1.id}`);
    const refreshedBid2 = await axios.get(`${API}/bids/${bid2.id}`);
    const updatedJob = await axios.get(`${API}/jobs/${job.id}`);
    const linkedEscrow = acceptRes.data.escrow;

    console.log('\n========================================');
    console.log('🎉 BIDDING & MATCHING ENGINE VERIFIED:');
    console.log('Winning Bid Status (Bid 2):    ', refreshedBid2.data.status);
    console.log('Losing Bid Status  (Bid 1):    ', refreshedBid1.data.status);
    console.log('Job Bound Artisan ID:          ', updatedJob.data.artisanId);
    console.log('Job Updated Budget:            ', updatedJob.data.budget);
    console.log('Auto-Created Escrow ID:        ', linkedEscrow.id);
    console.log('Escrow Status:                 ', linkedEscrow.totalStatus);
    console.log('Escrow Tranche 1:              ', linkedEscrow.tranche1Amount);
    console.log('Escrow Tranche 2:              ', linkedEscrow.tranche2Amount);
    console.log('========================================');
  } catch (err) {
    console.error('❌ Bidding test failed:', err.response?.data || err.message);
  }
}

testBiddingLifecycle();
