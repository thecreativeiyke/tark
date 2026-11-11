const { Client } = require('pg');
require('dotenv').config();

// Phase 4: replay-proof online funding.
//  - escrow_transaction.fundedReference: the exact payment reference that funded the escrow.
//    paystackReference only holds the LAST checkout started (Pay-For-Me overwrites it), so a
//    replayed webhook for the paying reference used to look like a second payment and got
//    credited to the client's wallet. Replay detection now compares against this column.
// Existing rows are left NULL on purpose: the code falls back to paystackReference for them.
// Safe to run more than once.
async function migratePhase4() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to PostgreSQL for Phase 4 migrations...');

  try {
    console.log('Adding "fundedReference" to "escrow_transaction"...');
    await client.query(`
      ALTER TABLE "escrow_transaction"
      ADD COLUMN IF NOT EXISTS "fundedReference" character varying;
    `);

    console.log('✅ Phase 4 database migration complete!');
  } finally {
    await client.end();
  }
}

migratePhase4().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
