/**
 * Migration: Phase 1 finish
 *  1. Dispute payout tracking (payoutStatus / payoutReference / payoutDispatchedAt + indexes)
 *  2. Sync notifications_type_enum with the NotificationType TS enum
 *     (fixes: invalid input value for enum notifications_type_enum: "KYC_SUBMITTED")
 *
 * Idempotent. Run once: node scripts/migrate-dispute-payout.js
 */
'use strict';

require('dotenv').config();
const { Client } = require('pg');

const NOTIFICATION_TYPES = [
  'BID_RECEIVED',
  'BID_ACCEPTED',
  'SAFE_LOCK_FUNDED',
  'TRANCHE1_RELEASED',
  'HANDSHAKE_READY',
  'PAYOUT_SETTLED',
  'DISPUTE_OPENED',
  'DISPUTE_RESOLVED',
  'SUPPORT_UPDATE',
  'SYSTEM_ALERT',
  'KYC_SUBMITTED',
  'KYC_APPROVED',
  'KYC_REJECTED',
  'PASSWORD_RESET',
];

async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('Connected to database for Phase 1 finish migration...');

  try {
    // ── 1. Notification enum values (ALTER TYPE ... ADD VALUE runs outside a transaction block) ──
    for (const value of NOTIFICATION_TYPES) {
      await client.query(`ALTER TYPE notifications_type_enum ADD VALUE IF NOT EXISTS '${value}'`);
    }
    console.log('✅ notifications_type_enum synced with NotificationType');

    // ── 2. Dispute payout tracking ──
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE dispute_payoutstatus_enum AS ENUM
          ('NOT_REQUIRED', 'PAYOUT_PENDING', 'RELEASED', 'PAYOUT_FAILED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await client.query(`
      ALTER TABLE "dispute"
        ADD COLUMN IF NOT EXISTS "payoutStatus" dispute_payoutstatus_enum NOT NULL DEFAULT 'NOT_REQUIRED',
        ADD COLUMN IF NOT EXISTS "payoutReference" character varying,
        ADD COLUMN IF NOT EXISTS "payoutDispatchedAt" TIMESTAMP WITH TIME ZONE
    `);

    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_dispute_payoutReference" ON "dispute" ("payoutReference")`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dispute_payout_pending" ON "dispute" ("payoutStatus") WHERE "payoutStatus" = 'PAYOUT_PENDING'`,
    );
    console.log('✅ dispute payout columns + indexes ready');

    // ── 3. Backfill: resolved disputes that owed the artisan money before this change ──
    // The old code used the same reference (tark-dispute-<id>) but never recorded the outcome, so we
    // do NOT assume they were paid. Mark them PAYOUT_PENDING; the reconciliation sweep (or
    // POST /escrow/admin/reconcile-payouts) asks the provider and records the truth.
    const backfill = await client.query(`
      UPDATE "dispute"
         SET "payoutStatus" = 'PAYOUT_PENDING',
             "payoutReference" = 'tark-dispute-' || "id"::text
       WHERE "status" = 'RESOLVED'
         AND "artisanPayoutAmount" > 0
         AND "payoutReference" IS NULL
         AND "payoutStatus" = 'NOT_REQUIRED'
    `);
    console.log(`ℹ️ Backfilled ${backfill.rowCount} legacy resolved dispute(s) as PAYOUT_PENDING for reconciliation`);

    console.log('\nMigration completed successfully!');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
