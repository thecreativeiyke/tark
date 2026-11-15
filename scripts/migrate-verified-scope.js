/**
 * Migration: Phase 2 Part A
 *  1. User: verifiedCategories (admin-controlled trade scope) + areaCode
 *  2. Job: areaCode (+ backfill from the last comma segment of "location")
 *  3. Job indexes: clientId, artisanId, (status, category, createdAt)
 *
 * Idempotent. Run once: node scripts/migrate-verified-scope.js
 *
 * NOTE: existing certified artisans start with an EMPTY verifiedCategories/areaCode, so they
 * see no jobs in GET /jobs until an admin sets their scope
 * (PATCH /kyc/admin/artisans/:userId/scope).
 */
'use strict';

require('dotenv').config();
const { Client } = require('pg');

async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('Connected to database for Phase 2 Part A migration...');

  try {
    await client.query('BEGIN');

    // ── 1. User verified scope ──
    await client.query(`
      ALTER TABLE "user"
        ADD COLUMN IF NOT EXISTS "verifiedCategories" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS "areaCode" character varying(64)
    `);
    console.log('✅ user.verifiedCategories + user.areaCode ready');

    // ── 2. Job area code ──
    await client.query(`
      ALTER TABLE "job"
        ADD COLUMN IF NOT EXISTS "areaCode" character varying(64)
    `);

    // Mirrors deriveAreaCodeFromLocation(): last comma segment, lowercased, non-alnum -> '-'.
    const backfill = await client.query(`
      UPDATE "job"
         SET "areaCode" = NULLIF(
               left(
                 btrim(
                   regexp_replace(lower(btrim(regexp_replace("location", '^.*,', ''))), '[^a-z0-9]+', '-', 'g'),
                   '-'
                 ),
                 64
               ),
               ''
             )
       WHERE "areaCode" IS NULL
         AND "location" LIKE '%,%'
    `);
    console.log(`✅ job.areaCode ready (backfilled ${backfill.rowCount} row(s))`);

    // ── 3. Job indexes (names match the @Index decorators in job.entity.ts) ──
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_job_clientId" ON "job" ("clientId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_job_artisanId" ON "job" ("artisanId")`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS "IDX_job_status_category_createdAt" ON "job" ("status", "category", "createdAt")`,
    );
    console.log('✅ job indexes ready');

    await client.query('COMMIT');
    console.log('\nMigration completed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
