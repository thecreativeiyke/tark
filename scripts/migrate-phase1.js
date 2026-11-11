const { Client } = require('pg');
require('dotenv').config();

async function migratePhase1() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to PostgreSQL for Phase 1 migrations...');

  try {
    console.log('Adding columns to "escrow_transaction"...');
    await client.query(`
      ALTER TABLE "escrow_transaction"
      ADD COLUMN IF NOT EXISTS "handshakeCycles" integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "handshakeLockedUntil" TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS "feeCollectedMinor" integer DEFAULT 0;
    `);

    console.log('Creating "wallet_ledgers" table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "wallet_ledgers" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "reference" character varying(128) NOT NULL,
        "userId" uuid NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "type" character varying(32) NOT NULL,
        "description" character varying(255),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_wallet_ledgers_ref" UNIQUE ("reference")
      );
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_wallet_ledgers_userId" ON "wallet_ledgers" ("userId");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_wallet_ledgers_reference" ON "wallet_ledgers" ("reference");`);

    console.log('✅ Phase 1 database migration complete!');
  } finally {
    await client.end();
  }
}

migratePhase1().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
