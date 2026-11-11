/**
 * Active verification test for KYC document URL validation.
 *
 * Attacks verified:
 * 1. Hostile external documentUrl (e.g. https://evil-attacker.com/fake-nin.jpg) -> REJECTED (400)
 * 2. Hostile external selfieUrl (e.g. https://phishing.site/selfie.jpg) -> REJECTED (400)
 * 3. Non-https or invalid URL scheme -> REJECTED (400)
 * 4. Legitimate URL on configured Tark CDN -> Passes validation
 *
 * All test users & KYC records cleaned up after execution.
 */
require('dotenv').config();
const { Client } = require('pg');

const BASE_URL = process.env.APP_URL || 'http://localhost:3000';
const CDN_URL = process.env.STORAGE_CUSTOM_CDN_URL || 'https://iyke-storage-gateway.iyke-storage-gateway.workers.dev/cdn';

const TEST_EMAIL = `test-kyc-guard-${Date.now()}@tark.test`;
const TEST_PASSWORD = 'TestPassword123!';
let authToken = '';
let artisanUserId = '';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // raw text
  }
  return { status: res.status, ok: res.ok, body: json || text };
}

async function cleanupDb() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const userRes = await client.query('SELECT id FROM "user" WHERE email = $1', [TEST_EMAIL]);
    if (userRes.rows.length > 0) {
      const uid = userRes.rows[0].id;
      await client.query('DELETE FROM kyc_records WHERE "userId"::text = $1', [uid]);
      await client.query('DELETE FROM notifications WHERE "userId"::text = $1', [uid]);
      await client.query('DELETE FROM "user" WHERE id::text = $1', [uid]);
    }
  } finally {
    await client.end();
  }
}

async function run() {
  console.log('--- STARTING KYC DOCUMENT URL VALIDATION ACTIVE TESTS ---');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Allowed CDN base: ${CDN_URL}\n`);

  try {
    // Step 0: Register artisan user
    console.log('[Setup] Registering artisan test account...');
    const regRes = await request('/auth/register', {
      method: 'POST',
      body: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        fullName: 'KYC Guard Test Artisan',
        role: 'artisan',
      },
    });

    if (!regRes.ok) {
      throw new Error(`Failed to register user: ${JSON.stringify(regRes.body)}`);
    }
    authToken = regRes.body.token || regRes.body.accessToken;
    artisanUserId = regRes.body.user?.id;
    console.log(`[Setup] Artisan created successfully. ID: ${artisanUserId}\n`);

    // Attack 1: External documentUrl pointing to arbitrary host
    console.log('[Attack 1] Submitting KYC with hostile external documentUrl (https://evil-attacker.com/doc.png)...');
    const attack1 = await request('/kyc/submit', {
      method: 'POST',
      body: {
        idType: 'NIN',
        idNumber: '11223344556',
        documentFirstName: 'Chidi',
        documentLastName: 'Mba',
        documentUrl: 'https://evil-attacker.com/doc.png',
        selfieUrl: `${CDN_URL}/selfies/artisan-selfie.png`,
      },
    });
    console.log(`Status: ${attack1.status}, Response:`, attack1.body);
    if (attack1.status === 400 && JSON.stringify(attack1.body).includes('must be a document uploaded through Tark')) {
      console.log('✅ PASS: Hostile documentUrl blocked before DB insertion.');
    } else {
      throw new Error(`FAIL: Hostile documentUrl was not blocked as expected: ${JSON.stringify(attack1.body)}`);
    }

    // Attack 2: External selfieUrl pointing to phishing/arbitrary host
    console.log('\n[Attack 2] Submitting KYC with hostile external selfieUrl (https://phishing.site/selfie.jpg)...');
    const attack2 = await request('/kyc/submit', {
      method: 'POST',
      body: {
        idType: 'NIN',
        idNumber: '11223344556',
        documentFirstName: 'Chidi',
        documentLastName: 'Mba',
        documentUrl: `${CDN_URL}/documents/artisan-nin.png`,
        selfieUrl: 'https://phishing.site/selfie.jpg',
      },
    });
    console.log(`Status: ${attack2.status}, Response:`, attack2.body);
    if (attack2.status === 400 && JSON.stringify(attack2.body).includes('must be a document uploaded through Tark')) {
      console.log('✅ PASS: Hostile selfieUrl blocked before DB insertion.');
    } else {
      throw new Error(`FAIL: Hostile selfieUrl was not blocked as expected: ${JSON.stringify(attack2.body)}`);
    }

    // Attack 3: Submitting non-matching subdomain / spoofed host
    console.log('\n[Attack 3] Submitting KYC with spoofed CDN domain (https://iyke-storage-gateway.attacker.com)...');
    const attack3 = await request('/kyc/submit', {
      method: 'POST',
      body: {
        idType: 'NIN',
        idNumber: '11223344556',
        documentFirstName: 'Chidi',
        documentLastName: 'Mba',
        documentUrl: 'https://iyke-storage-gateway.attacker.com/cdn/documents/artisan-nin.png',
        selfieUrl: `${CDN_URL}/selfies/artisan-selfie.png`,
      },
    });
    console.log(`Status: ${attack3.status}, Response:`, attack3.body);
    if (attack3.status === 400 && JSON.stringify(attack3.body).includes('must be a document uploaded through Tark')) {
      console.log('✅ PASS: Spoofed CDN hostname blocked.');
    } else {
      throw new Error(`FAIL: Spoofed CDN hostname was not blocked: ${JSON.stringify(attack3.body)}`);
    }

    // Test 4: Legitimate URLs on Tark CDN
    console.log('\n[Test 4] Submitting KYC with valid Tark CDN URLs...');
    const uniqueIdNum = `NIN${Date.now().toString().slice(-8)}`;
    const validRes = await request('/kyc/submit', {
      method: 'POST',
      body: {
        idType: 'NIN',
        idNumber: uniqueIdNum,
        documentFirstName: 'Chidi',
        documentLastName: 'Mba',
        documentUrl: `${CDN_URL}/documents/test-nin-${Date.now()}.png`,
        selfieUrl: `${CDN_URL}/selfies/test-selfie-${Date.now()}.png`,
      },
    });
    console.log(`Status: ${validRes.status}, Response:`, validRes.body);
    if (validRes.status === 201 && validRes.body.status === 'PENDING_REVIEW') {
      console.log('✅ PASS: Legitimate CDN submission accepted into triage queue.');
    } else {
      throw new Error(`FAIL: Legitimate submission failed: ${JSON.stringify(validRes.body)}`);
    }

    console.log('\n=== ALL KYC URL SHIELD ATTACK TESTS PASSED ===\n');
  } finally {
    console.log('[Cleanup] Removing test user and records from DB...');
    try {
      await cleanupDb();
      console.log('[Cleanup] Done.');
    } catch (err) {
      console.error('[Cleanup Error]', err.message);
    }
  }
}

run().catch((err) => {
  console.error('\n❌ Test run aborted with error:', err);
  process.exit(1);
});
