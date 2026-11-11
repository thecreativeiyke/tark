const { Client } = require('pg');
require('dotenv').config();

// Phase 3: wallet/escrow funding hardening.
//  - escrow_transaction.fundedVia: which channel funded the escrow (WALLET | ONLINE)
//  - escrow_transaction.feeCollectedMinor: platform fee retained at settlement (kobo)
//  - "user".walletBalance sanity CHECK (never negative, never NaN)
// Safe to run more than once.
async function migratePhase3() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to PostgreSQL for Phase 3 migrations...');

  try {
    console.log('Adding columns to "escrow_transaction"...');
    await client.query(`
      ALTER TABLE "escrow_transaction"
      ADD COLUMN IF NOT EXISTS "fundedVia" character varying(16),
      ADD COLUMN IF NOT EXISTS "feeCollectedMinor" integer DEFAULT 0;
    `);
    await client.query(`UPDATE "escrow_transaction" SET "feeCollectedMinor" = 0 WHERE "feeCollectedMinor" IS NULL;`);
    await client.query(`
      ALTER TABLE "escrow_transaction"
      ALTER COLUMN "feeCollectedMinor" SET DEFAULT 0,
      ALTER COLUMN "feeCollectedMinor" SET NOT NULL;
    `);

    console.log('Ensuring wallet_sane CHECK constraint on "user"...');
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_sane') THEN
          ALTER TABLE "user"
          ADD CONSTRAINT wallet_sane
          CHECK ("walletBalance" >= 0 AND "walletBalance" <> 'NaN'::numeric);
        END IF;
      END
      $$;
    `);

    console.log('✅ Phase 3 database migration complete!');
  } finally {
    await client.end();
  }
}

migratePhase3().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
