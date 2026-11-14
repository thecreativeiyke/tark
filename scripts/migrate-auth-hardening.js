/**
 * Migration: Auth Hardening
 * - Add tokenVersion (integer default 0) to "user" table
 * - Add passwordResetTokenHash (varchar null) to "user" table
 * - Add passwordResetExpiresAt (timestamptz null) to "user" table
 * - Normalize all existing user emails to lower case
 * - Add unique index on LOWER(email)
 */
require('dotenv').config();
const { Client } = require('pg');

async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to Supabase PostgreSQL for Auth Hardening migration...');

  try {
    // 1. tokenVersion column
    console.log('Adding tokenVersion column...');
    await client.query(`
      ALTER TABLE "user"
      ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
    `);
    console.log('✅ tokenVersion added.');

    // 2. passwordResetTokenHash column
    console.log('Adding passwordResetTokenHash column...');
    await client.query(`
      ALTER TABLE "user"
      ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" VARCHAR(128) NULL;
    `);
    console.log('✅ passwordResetTokenHash added.');

    // 3. passwordResetExpiresAt column
    console.log('Adding passwordResetExpiresAt column...');
    await client.query(`
      ALTER TABLE "user"
      ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMPTZ NULL;
    `);
    console.log('✅ passwordResetExpiresAt added.');

    // 4. Normalize all existing emails to lowercase
    console.log('Normalizing existing emails to lowercase...');
    await client.query(`
      UPDATE "user"
      SET email = LOWER(TRIM(email))
      WHERE email != LOWER(TRIM(email));
    `);
    console.log('✅ Emails normalized.');

    // 5. Unique index on lower(email) if not exists
    console.log('Creating unique index on LOWER(email)...');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_lower_email ON "user" (LOWER(email));
    `);
    console.log('✅ Unique index on LOWER(email) active.');

    console.log('\nMigration completed successfully!');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
