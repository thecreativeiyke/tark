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
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
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

async function promoteUserToAdmin(email) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query(`UPDATE "user" SET role = 'admin' WHERE email = $1`, [email]);
  await client.end();
}

async function run() {
  console.log('====================================================');
  console.log('🚀 TARK PROTOCOL: ARTISAN KYC & VERIFICATION DESK TEST');
  console.log('====================================================\n');

  const timestamp = Date.now();
  const artisanEmail = `artisan.kyc.${timestamp}@tark.ng`;
  const adminEmail = `admin.kyc.${timestamp}@tark.ng`;
  const sybilEmail = `sybil.kyc.${timestamp}@tark.ng`;
  const password = 'StrongPassword123!';

  // Unique document & selfie hashes per test execution
  const testDocSha = crypto.createHash('sha256').update(`${timestamp}-artisan-doc`).digest('hex');
  const testSelfieSha = crypto.createHash('sha256').update(`${timestamp}-artisan-selfie`).digest('hex');

  // 1. Register Artisan
  console.log('1️⃣ Registering Artisan (Observation Mode)...');
  const regArtisan = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/auth/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    {
      email: artisanEmail,
      password,
      fullName: 'Ikechukwu Alaeto',
      role: 'artisan',
    },
  );

  if (!regArtisan.data.accessToken) {
    throw new Error(`Artisan register failed: ${JSON.stringify(regArtisan.data)}`);
  }

  const artisanToken = regArtisan.data.accessToken;
  const artisanId = decodeJwt(artisanToken).sub;
  console.log(`   ✅ Artisan created: ${artisanId} (Role: artisan)`);

  // 2. Check initial KYC status (should be NOT_SUBMITTED)
  console.log('\n2️⃣ Checking initial KYC status via GET /kyc/my-status...');
  const initStatus = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/kyc/my-status',
    method: 'GET',
    headers: { Authorization: `Bearer ${artisanToken}` },
  });
  console.log('   Status:', initStatus.data.kycStatus, '| Can Bid:', initStatus.data.canBid);
  if (initStatus.data.canBid !== false) {
    throw new Error('Artisan should NOT be able to bid before KYC!');
  }

  // 3. Register a Client and post a Job to test the Bidding Gate
  console.log('\n3️⃣ Registering Client and creating an open job...');
  const regClient = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/auth/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    {
      email: `client.kyc.${timestamp}@tark.ng`,
      password,
      fullName: 'Chief Obinna',
      role: 'client',
    },
  );
  const clientToken = regClient.data.accessToken;

  // Fetch a category name
  const categories = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/categories',
    method: 'GET',
  });
  const catName = categories.data[0]?.name || 'Plumbing';

  const jobRes = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/jobs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientToken}`,
      },
    },
    {
      title: 'Fix AC Compressor in Lekki Phase 1',
      description: 'The split AC unit is blowing warm air.',
      category: catName,
      budget: 45000,
      tranche1Amount: 20000,
      tranche2Amount: 25000,
      location: 'Admiralty Way, Lekki',
    },
  );

  const jobId = jobRes.data.id;
  if (!jobId) {
    throw new Error(`Job creation failed: ${JSON.stringify(jobRes.data)}`);
  }
  console.log(`   ✅ Job created: ${jobId}`);

  // 4. Attempt to place bid WITHOUT KYC certification (Gate enforcement)
  console.log('\n4️⃣ Testing Read-Only Observation Gate: Unverified Artisan attempts to bid...');
  const blockedBid = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/bids',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${artisanToken}`,
      },
    },
    {
      jobId,
      amount: 45000,
      tranche1Amount: 20000,
      tranche2Amount: 25000,
      coverNote: 'I can fix this AC within 2 hours.',
    },
  );
  console.log(`   Response Code: ${blockedBid.status}`);
  console.log(`   Response Message: "${blockedBid.data.message}"`);
  if (blockedBid.status !== 403) {
    throw new Error(`Observation gate failed! Expected 403, got ${blockedBid.status}`);
  }
  console.log('   🛡️ Gate verified: Uncertified artisan was cleanly blocked from bidding.');

  // 5. Submit KYC Credentials
  console.log('\n5️⃣ Submitting KYC Credentials via POST /kyc/submit...');
  const testNin = `12345${Math.floor(100000 + Math.random() * 900000)}`;
  const submitRes = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/kyc/submit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${artisanToken}`,
      },
    },
    {
      idType: 'NIN',
      idNumber: testNin,
      documentFirstName: 'Ikechukwu',
      documentLastName: 'Alaeto',
      documentUrl: 'https://iyke-storage.workers.dev/kyc/v1/ikechukwu-nin.pdf',
      documentSha256: testDocSha,
      selfieUrl: 'https://iyke-storage.workers.dev/kyc/v1/ikechukwu-portrait.jpg',
      selfieSha256: testSelfieSha,
    },
  );
  console.log(`   Response Code: ${submitRes.status}`);
  console.log(`   Record ID: ${submitRes.data.recordId}`);
  console.log(`   Status: ${submitRes.data.status}`);
  const recordId = submitRes.data.recordId;
  if (!recordId) {
    throw new Error(`KYC Submit failed: ${JSON.stringify(submitRes.data)}`);
  }

  // 6. Register Admin user & promote via DB (enforcing Three-Ring Security)
  console.log('\n6️⃣ Creating and Authenticating Admin Compliance Officer...');
  await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/auth/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    {
      email: adminEmail,
      password,
      fullName: 'Tark Head of Compliance',
      role: 'client',
    },
  );
  await promoteUserToAdmin(adminEmail);

  // Login as admin to get real Admin JWT
  const adminLogin = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    {
      email: adminEmail,
      password,
    },
  );
  const adminToken = adminLogin.data.accessToken;
  console.log('   ✅ Admin authenticated with verified admin role.');

  // 7. Admin views KYC Queue
  console.log('\n7️⃣ Admin inspecting KYC Queue (GET /kyc/admin/queue)...');
  const queueRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/kyc/admin/queue',
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  console.log(`   Response Status: ${queueRes.status}`);
  console.log(`   Queue Count: ${queueRes.data.meta.total}`);
  const queuedItem = queueRes.data.data.find((item) => item.id === recordId);
  if (!queuedItem) {
    throw new Error(`Record ${recordId} not found in admin queue`);
  }
  console.log('   Found Item in Queue:');
  console.log('   - Artisan:', queuedItem.artisan.fullName);
  console.log('   - Triage Confidence:', queuedItem.triageConfidence);
  console.log('   - Triage Summary:', queuedItem.triageSummary);

  // 8. Admin reviews specific record dossier
  console.log('\n8️⃣ Admin fetching full dossier (GET /kyc/admin/:id)...');
  const dossierRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/kyc/admin/${recordId}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  console.log('   Tark Intelligence Engine Version:', dossierRes.data.record.triageResult.engineVersion);
  console.log('   Name Alignment Verdict:', dossierRes.data.record.triageResult.nameAlignment.verdict);
  console.log('   Face Match Assessment Score:', dossierRes.data.record.triageResult.faceMatchScore);

  // 9. Test Secure Document Access Token
  console.log('\n9️⃣ Testing Secure Document Access (GET /kyc/document/:id/document)...');
  const docAccess = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/kyc/document/${recordId}/document`,
    method: 'GET',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  console.log('   Signed Access Token Generated:', docAccess.data.accessToken.slice(0, 16) + '...');
  console.log('   Expires In (Seconds):', docAccess.data.expiresInSeconds);

  // 10. Admin approves KYC
  console.log('\n🔟 Admin 1-Click Approval (PATCH /kyc/admin/:id/approve)...');
  const approveRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/kyc/admin/${recordId}/approve`,
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  console.log(`   Approval Result: "${approveRes.data.message}"`);
  console.log(`   isCertifiedByTark: ${approveRes.data.isCertifiedByTark}`);

  // 11. Artisan checks updated status
  console.log('\n1️⃣1️⃣ Checking updated Artisan status (GET /kyc/my-status)...');
  const updatedStatus = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/kyc/my-status',
    method: 'GET',
    headers: { Authorization: `Bearer ${artisanToken}` },
  });
  console.log('   KYC Status:', updatedStatus.data.kycStatus);
  console.log('   Tark Certified:', updatedStatus.data.isCertifiedByTark);
  console.log('   Badge Title:', updatedStatus.data.certificationBadgeTitle);
  console.log('   Can Bid:', updatedStatus.data.canBid);

  // 12. Artisan places bid on Job (Now Unlocked!)
  console.log('\n1️⃣2️⃣ Verified Artisan places bid on Job (Unlocked!)...');
  const allowedBid = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/bids',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${artisanToken}`,
      },
    },
    {
      jobId,
      amount: 45000,
      tranche1Amount: 20000,
      tranche2Amount: 25000,
      coverNote: 'I can fix this AC today. Fully certified on Tark.',
    },
  );
  console.log(`   Bid Response Code: ${allowedBid.status}`);
  console.log(`   Bid ID: ${allowedBid.data.id} (Status: ${allowedBid.data.status})`);
  if (allowedBid.status !== 201) {
    throw new Error(`Certified artisan was unable to place a bid! Response: ${JSON.stringify(allowedBid.data)}`);
  }
  console.log('   🎉 Bid successfully placed by certified artisan!');

  // 13. Test Anti-Sybil Duplicate NIN Prevention
  console.log('\n1️⃣3️⃣ Testing Anti-Sybil Duplicate NIN Prevention...');
  const regSybil = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/auth/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    {
      email: sybilEmail,
      password,
      fullName: 'Sybil Imposter',
      role: 'artisan',
    },
  );
  const sybilToken = regSybil.data.accessToken;

  const sybilAttempt = await request(
    {
      hostname: 'localhost',
      port: 3000,
      path: '/kyc/submit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sybilToken}`,
      },
    },
    {
      idType: 'NIN',
      idNumber: testNin, // Duplicate NIN from verified artisan!
      documentFirstName: 'Sybil',
      documentLastName: 'Imposter',
      documentUrl: 'https://iyke-storage.workers.dev/kyc/v1/fake.pdf',
      documentSha256: crypto.createHash('sha256').update(`${timestamp}-fake-doc`).digest('hex'),
      selfieUrl: 'https://iyke-storage.workers.dev/kyc/v1/fake-selfie.jpg',
      selfieSha256: crypto.createHash('sha256').update(`${timestamp}-fake-selfie`).digest('hex'),
    },
  );
  console.log(`   Sybil Response Code: ${sybilAttempt.status}`);
  console.log(`   Sybil Message: "${sybilAttempt.data.message}"`);
  if (sybilAttempt.status !== 409) {
    throw new Error('Anti-Sybil check failed! Duplicate NIN was accepted.');
  }
  console.log('   🛡️ Anti-Sybil Shield verified: Duplicate NIN blocked with 409 Conflict.');

  console.log('\n====================================================');
  console.log('✨ ALL 13 ARTISAN KYC VERIFICATION TESTS PASSED 100%!');
  console.log('====================================================\n');
}

run().catch((err) => {
  console.error('❌ KYC Test Failed:', err);
  process.exit(1);
});
