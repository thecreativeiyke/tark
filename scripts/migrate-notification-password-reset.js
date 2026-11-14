/**
 * Migration: add PASSWORD_RESET to notifications_type_enum
 * Run once: node scripts/migrate-notification-password-reset.js
 */
'use strict';

require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to database.');

  try {
    // PostgreSQL ALTER TYPE ... ADD VALUE is non-transactional; run outside a transaction block.
    await client.query(`
      ALTER TYPE notifications_type_enum
      ADD VALUE IF NOT EXISTS 'PASSWORD_RESET'
    `);
    console.log("✅  notifications_type_enum now includes 'PASSWORD_RESET'");
  } finally {
    await client.end();
    console.log('Done.');
  }
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
