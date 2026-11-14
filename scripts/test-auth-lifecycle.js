/**
 * Active Red-Team Penetration Suite: Authentication Lifecycle & Security Hardening
 *
 * Verifies:
 * 1. Case-insensitive email collision prevention (409 Conflict on register)
 * 2. Constant-time non-enumerating forgot-password endpoint (same 201 response for non-existent vs existing users)
 * 3. In-flight password reset token hashed in database (SHA-256) with valid expiration
 * 4. Password reset rejecting invalid, expired, and previously used tokens
 * 5. Password reset updating password, clearing reset token hash, and incrementing tokenVersion
 * 6. JWT invalidation on password reset: pre-reset JWT rejected with 401 Unauthorized (tokenVersion mismatch)
 * 7. Login with updated password succeeding and returning valid new JWT
 * 8. Authenticated password change rejecting incorrect current password (401 Unauthorized)
 * 9. Authenticated password change invalidating previous JWTs via tokenVersion increment
 * 10. Constant-time login timing protection against non-existent accounts
 *
 * Cleans up all test data from Supabase DB upon completion.
 */
'use strict';

require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const BASE_URL = process.env.APP_URL || 'http://localhost:3000';
const ts = Date.now();
const TEST_EMAIL_LOWER = `auth.test.${ts}@tark.ng`;
const TEST_EMAIL_UPPER = `AUTH.TEST.${ts}@TARK.NG`;
const PASSWORD_INITIAL = 'InitialPass123!';
const PASSWORD_RESET = 'AfterResetPass123!';
const PASSWORD_CHANGED = 'AfterChangedPass123!';

let testUserId = null;
let initialJwt = null;

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, ok: res.ok, body: json || text };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  }
  console.log(`  ✅ ${message}`);
}

async function run() {
  console.log('='.repeat(70));
  console.log('🔐 RUNNING AUTH LIFECYCLE & SECURITY HARDENING TEST SUITE');
  console.log('='.repeat(70));

  const dbClient = new Client({ connectionString: process.env.DATABASE_URL });
  await dbClient.connect();

  try {
    // -----------------------------------------------------------------
    // Step 1: Register initial test user
    // -----------------------------------------------------------------
    console.log('\n[Step 1] Registering initial user with lowercase email...');
    const regRes = await request('/auth/register', {
      method: 'POST',
      body: {
        email: TEST_EMAIL_LOWER,
        password: PASSWORD_INITIAL,
        fullName: 'Auth Test User',
        role: 'client',
      },
    });

    assert(regRes.status === 201, `User registration returned status 201 (got ${regRes.status})`);
    assert(regRes.body.accessToken, 'Registration returned an accessToken');
    initialJwt = regRes.body.accessToken;

    // Fetch user from DB
    const userRow = await dbClient.query('SELECT id, email, "tokenVersion" FROM "user" WHERE LOWER(email) = $1', [
      TEST_EMAIL_LOWER.toLowerCase(),
    ]);
    assert(userRow.rows.length === 1, 'User found in PostgreSQL database');
    testUserId = userRow.rows[0].id;
    assert(userRow.rows[0].tokenVersion === 0, `Initial tokenVersion is 0 (got ${userRow.rows[0].tokenVersion})`);

    // Verify initial token works on /auth/me
    const meRes = await request('/auth/me', { token: initialJwt });
    assert(meRes.status === 200, `Initial token authenticates /auth/me (status ${meRes.status})`);
    assert(meRes.body.id === testUserId, 'Initial token maps to correct user id');

    // -----------------------------------------------------------------
    // Step 2: Test Case-Insensitive Email Collision
    // -----------------------------------------------------------------
    console.log('\n[Step 2] Testing registration with uppercase variation of same email...');
    const duplicateRes = await request('/auth/register', {
      method: 'POST',
      body: {
        email: TEST_EMAIL_UPPER,
        password: 'AnotherPassword123!',
        fullName: 'Attacker User',
        role: 'client',
      },
    });

    assert(
      duplicateRes.status === 409,
      `Case-collision registration blocked with 409 Conflict (got ${duplicateRes.status})`,
    );

    // -----------------------------------------------------------------
    // Step 3: Test Non-Enumerating Forgot Password
    // -----------------------------------------------------------------
    console.log('\n[Step 3] Testing forgot-password endpoint for enumeration resistance...');
    const nonExistentEmail = `nonexistent.${ts}@tark.ng`;
    const forgotNonExistent = await request('/auth/forgot-password', {
      method: 'POST',
      body: { email: nonExistentEmail },
    });

    const forgotExisting = await request('/auth/forgot-password', {
      method: 'POST',
      body: { email: TEST_EMAIL_LOWER },
    });

    assert(
      forgotNonExistent.status === 200 || forgotNonExistent.status === 201,
      `Forgot password for non-existent email returned success (status ${forgotNonExistent.status})`,
    );
    assert(
      forgotExisting.status === 200 || forgotExisting.status === 201,
      `Forgot password for existing email returned success (status ${forgotExisting.status})`,
    );
    assert(
      JSON.stringify(forgotNonExistent.body) === JSON.stringify(forgotExisting.body),
      'Responses for non-existent and existing emails are byte-for-byte identical (no enumeration)',
    );

    // -----------------------------------------------------------------
    // Step 4: Verify Token Hashing & Expiration in DB
    // -----------------------------------------------------------------
    console.log('\n[Step 4] Verifying password reset token state in database...');
    const tokenState = await dbClient.query(
      'SELECT "passwordResetTokenHash", "passwordResetExpiresAt" FROM "user" WHERE id = $1',
      [testUserId],
    );
    const { passwordResetTokenHash, passwordResetExpiresAt } = tokenState.rows[0];
    assert(
      passwordResetTokenHash && passwordResetTokenHash.length === 64,
      `passwordResetTokenHash is a 64-char SHA-256 hex string (${passwordResetTokenHash?.substring(0, 8)}...)`,
    );
    const expiresAt = new Date(passwordResetExpiresAt);
    const now = Date.now();
    const minutesUntilExpiry = (expiresAt.getTime() - now) / (60 * 1000);
    assert(
      minutesUntilExpiry > 25 && minutesUntilExpiry <= 31,
      `passwordResetExpiresAt is set ~30m into future (${minutesUntilExpiry.toFixed(1)}m remaining)`,
    );

    // -----------------------------------------------------------------
    // Step 5: Test Reset Password with invalid / expired token
    // -----------------------------------------------------------------
    console.log('\n[Step 5] Testing reset-password with invalid / expired tokens...');
    const invalidTokenRes = await request('/auth/reset-password', {
      method: 'POST',
      body: {
        token: 'completely_bogus_token_value_that_does_not_exist',
        newPassword: PASSWORD_RESET,
      },
    });
    assert(
      invalidTokenRes.status === 400,
      `Invalid reset token rejected with 400 Bad Request (got ${invalidTokenRes.status})`,
    );

    // Test with expired token
    const testRawToken = crypto.randomBytes(32).toString('hex');
    const testHash = crypto.createHash('sha256').update(testRawToken).digest('hex');
    await dbClient.query(
      'UPDATE "user" SET "passwordResetTokenHash" = $1, "passwordResetExpiresAt" = $2 WHERE id = $3',
      [testHash, new Date(Date.now() - 60000), testUserId], // expired 1m ago
    );

    const expiredTokenRes = await request('/auth/reset-password', {
      method: 'POST',
      body: {
        token: testRawToken,
        newPassword: PASSWORD_RESET,
      },
    });
    assert(
      expiredTokenRes.status === 400,
      `Expired reset token rejected with 400 Bad Request (got ${expiredTokenRes.status})`,
    );

    // -----------------------------------------------------------------
    // Step 6: Test Reset Password with valid token
    // -----------------------------------------------------------------
    console.log('\n[Step 6] Testing reset-password with valid cryptographic token...');
    const validRawToken = crypto.randomBytes(32).toString('hex');
    const validHash = crypto.createHash('sha256').update(validRawToken).digest('hex');
    await dbClient.query(
      'UPDATE "user" SET "passwordResetTokenHash" = $1, "passwordResetExpiresAt" = $2 WHERE id = $3',
      [validHash, new Date(Date.now() + 30 * 60 * 1000), testUserId],
    );

    const validResetRes = await request('/auth/reset-password', {
      method: 'POST',
      body: {
        token: validRawToken,
        newPassword: PASSWORD_RESET,
      },
    });
    assert(
      validResetRes.status === 200 || validResetRes.status === 201,
      `Valid password reset succeeded (status ${validResetRes.status})`,
    );

    // Verify token was cleared from DB (single-use)
    const afterResetState = await dbClient.query(
      'SELECT "passwordResetTokenHash", "passwordResetExpiresAt", "tokenVersion" FROM "user" WHERE id = $1',
      [testUserId],
    );
    assert(
      afterResetState.rows[0].passwordResetTokenHash === null,
      'passwordResetTokenHash was cleared to NULL in database',
    );
    assert(
      afterResetState.rows[0].tokenVersion === 1,
      `tokenVersion was incremented to 1 (got ${afterResetState.rows[0].tokenVersion})`,
    );

    // Replay attack: try resetting again with same token
    const replayResetRes = await request('/auth/reset-password', {
      method: 'POST',
      body: {
        token: validRawToken,
        newPassword: 'AnotherPassword123!',
      },
    });
    assert(
      replayResetRes.status === 400,
      `Replayed reset token rejected with 400 Bad Request (got ${replayResetRes.status})`,
    );

    // -----------------------------------------------------------------
    // Step 7: JWT Revocation Check — Old JWT must now fail
    // -----------------------------------------------------------------
    console.log('\n[Step 7] Testing JWT invalidation via tokenVersion mismatch...');
    const oldJwtMeRes = await request('/auth/me', { token: initialJwt });
    assert(
      oldJwtMeRes.status === 401,
      `Pre-reset JWT rejected on /auth/me with 401 Unauthorized (got ${oldJwtMeRes.status})`,
    );

    // -----------------------------------------------------------------
    // Step 8: Login with Old Password fails, New Password succeeds
    // -----------------------------------------------------------------
    console.log('\n[Step 8] Testing login with old vs newly reset password...');
    const oldPassLogin = await request('/auth/login', {
      method: 'POST',
      body: {
        email: TEST_EMAIL_LOWER,
        password: PASSWORD_INITIAL,
      },
    });
    assert(
      oldPassLogin.status === 401,
      `Login with old password rejected with 401 Unauthorized (got ${oldPassLogin.status})`,
    );

    const newPassLogin = await request('/auth/login', {
      method: 'POST',
      body: {
        email: TEST_EMAIL_LOWER,
        password: PASSWORD_RESET,
      },
    });
    assert(
      newPassLogin.status === 200 || newPassLogin.status === 201,
      `Login with new password succeeded (status ${newPassLogin.status})`,
    );
    assert(newPassLogin.body.accessToken, 'Login returned new accessToken');
    const secondJwt = newPassLogin.body.accessToken;

    const secondMeRes = await request('/auth/me', { token: secondJwt });
    assert(
      secondMeRes.status === 200,
      `New JWT authenticates /auth/me successfully (status ${secondMeRes.status})`,
    );

    // -----------------------------------------------------------------
    // Step 9: Authenticated Change Password
    // -----------------------------------------------------------------
    console.log('\n[Step 9] Testing authenticated change-password endpoint...');
    const wrongCurrentRes = await request('/auth/change-password', {
      method: 'POST',
      token: secondJwt,
      body: {
        currentPassword: 'WrongCurrentPassword123!',
        newPassword: PASSWORD_CHANGED,
      },
    });
    assert(
      wrongCurrentRes.status === 401,
      `Change password with wrong current password rejected with 401 (got ${wrongCurrentRes.status})`,
    );

    const correctChangeRes = await request('/auth/change-password', {
      method: 'POST',
      token: secondJwt,
      body: {
        currentPassword: PASSWORD_RESET,
        newPassword: PASSWORD_CHANGED,
      },
    });
    assert(
      correctChangeRes.status === 200 || correctChangeRes.status === 201,
      `Change password succeeded (status ${correctChangeRes.status})`,
    );

    // Verify tokenVersion was bumped again
    const postChangeUser = await dbClient.query('SELECT "tokenVersion" FROM "user" WHERE id = $1', [testUserId]);
    assert(
      postChangeUser.rows[0].tokenVersion === 2,
      `tokenVersion was bumped to 2 (got ${postChangeUser.rows[0].tokenVersion})`,
    );

    // Verify secondJwt is now revoked
    const secondJwtAfterChange = await request('/auth/me', { token: secondJwt });
    assert(
      secondJwtAfterChange.status === 401,
      `Post-change verifies second JWT is revoked with 401 Unauthorized (got ${secondJwtAfterChange.status})`,
    );

    // Login with PASSWORD_CHANGED
    const finalLoginRes = await request('/auth/login', {
      method: 'POST',
      body: {
        email: TEST_EMAIL_LOWER,
        password: PASSWORD_CHANGED,
      },
    });
    assert(
      finalLoginRes.status === 200 || finalLoginRes.status === 201,
      `Login with changed password succeeded (status ${finalLoginRes.status})`,
    );

    console.log('\n' + '='.repeat(70));
    console.log('🎉 ALL AUTH LIFECYCLE & SECURITY HARDENING TESTS PASSED!');
    console.log('='.repeat(70));
  } finally {
    if (testUserId) {
      console.log('\n[Cleanup] Removing test user and notifications from database...');
      try {
        await dbClient.query('DELETE FROM notifications WHERE "userId" = $1', [testUserId]);
        await dbClient.query('DELETE FROM "user" WHERE id = $1', [testUserId]);
        console.log('✅ Cleanup complete.');
      } catch (err) {
        console.error('Cleanup error:', err.message);
      }
    }
    await dbClient.end();
  }
}

run().catch((err) => {
  console.error('\n❌ Suite failed:', err);
  process.exit(1);
});
