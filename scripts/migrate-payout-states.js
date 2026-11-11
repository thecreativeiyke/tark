/**
 * Migration script: Add PAYOUT_PENDING and PAYOUT_FAILED to PostgreSQL enums
 * - escrow_transaction_tranche1status_enum
 * - escrow_transaction_tranche2status_enum
 */
require('dotenv').config();
const { Client } = require('pg');

async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to Supabase PostgreSQL for payout state migration...');

  try {
    const enums = [
      'escrow_transaction_tranche1status_enum',
      'escrow_transaction_tranche2status_enum',
    ];

    for (const enumName of enums) {
      console.log(`Checking values for enum: ${enumName}...`);
      const existing = await client.query(
        `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE typname = $1`,
        [enumName],
      );
      const labels = existing.rows.map((r) => r.enumlabel);

      if (!labels.includes('PAYOUT_PENDING')) {
        console.log(`Adding PAYOUT_PENDING to ${enumName}...`);
        await client.query(`ALTER TYPE ${enumName} ADD VALUE 'PAYOUT_PENDING'`);
        console.log(`✅ PAYOUT_PENDING added to ${enumName}`);
      } else {
        console.log(`ℹ️ PAYOUT_PENDING already present in ${enumName}`);
      }

      if (!labels.includes('PAYOUT_FAILED')) {
        console.log(`Adding PAYOUT_FAILED to ${enumName}...`);
        await client.query(`ALTER TYPE ${enumName} ADD VALUE 'PAYOUT_FAILED'`);
        console.log(`✅ PAYOUT_FAILED added to ${enumName}`);
      } else {
        console.log(`ℹ️ PAYOUT_FAILED already present in ${enumName}`);
      }
    }

    console.log('\nMigration completed successfully!');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
