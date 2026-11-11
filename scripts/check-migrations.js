// Check which migration columns exist in DB
require('dotenv').config();
const { Client } = require('pg');

const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();

  // Check escrow_transaction columns
  const escrowCols = await c.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'escrow_transaction'
      AND column_name IN (
        'fundedReference','funded_reference',
        'fundedVia','funded_via',
        'feeCollectedMinor','fee_collected_minor'
      )
  `);
  console.log('escrow_transaction columns found:', escrowCols.rows.map(r => r.column_name));

  // Check wallet_ledgers table
  const walletTable = await c.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'wallet_ledgers'
  `);
  console.log('wallet_ledgers table exists:', walletTable.rows.length > 0);

  // Check handshakeCycles
  const escrowExtra = await c.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'escrow_transaction'
      AND column_name IN ('handshakeCycles','handshake_cycles','handshakeLockedUntil','handshake_locked_until')
  `);
  console.log('handshake columns found:', escrowExtra.rows.map(r => r.column_name));

  await c.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
