const { Client } = require('pg');
require('dotenv').config();

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set in .env');
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to PostgreSQL database for KYC migration...');

  try {
    // 1. Add missing columns to "user" table
    console.log('Migrating "user" table columns...');
    await client.query(`
      ALTER TABLE "user" 
      ADD COLUMN IF NOT EXISTS "firstName" character varying,
      ADD COLUMN IF NOT EXISTS "middleName" character varying,
      ADD COLUMN IF NOT EXISTS "lastName" character varying,
      ADD COLUMN IF NOT EXISTS "kycStatus" character varying DEFAULT 'NOT_SUBMITTED';
    `);

    // 2. Add 'developer' to enum if user_role_enum exists
    try {
      await client.query(`ALTER TYPE user_role_enum ADD VALUE IF NOT EXISTS 'developer';`);
      console.log('Added developer to user_role_enum (if enum type exists).');
    } catch (enumErr) {
      console.log('user_role_enum update notice:', enumErr.message);
    }

    // 3. Create KycIdType & KycStatus enums or use check constraints
    try {
      await client.query(`
        DO $$ BEGIN
          CREATE TYPE kyc_id_type_enum AS ENUM ('NIN', 'VOTERS_CARD', 'DRIVERS_LICENSE', 'PASSPORT');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `);
      await client.query(`
        DO $$ BEGIN
          CREATE TYPE kyc_status_enum AS ENUM ('NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'RESUBMITTED', 'SUPERSEDED', 'EXPIRED', 'ARCHIVED');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `);
    } catch (e) {
      console.log('Enum creation notice:', e.message);
    }

    // 4. Create kyc_records table
    console.log('Creating "kyc_records" table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "kyc_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "idType" kyc_id_type_enum NOT NULL DEFAULT 'NIN',
        "idNumber" character varying(128) NOT NULL,
        "documentFirstName" character varying(120) NOT NULL,
        "documentMiddleName" character varying(120),
        "documentLastName" character varying(120) NOT NULL,
        "documentUrl" character varying(1024) NOT NULL,
        "documentSha256" character varying(64) NOT NULL,
        "selfieUrl" character varying(1024) NOT NULL,
        "selfieSha256" character varying(64) NOT NULL,
        "status" kyc_status_enum NOT NULL DEFAULT 'PENDING_REVIEW',
        "rejectionReason" text,
        "reviewedByAdminId" uuid,
        "reviewedAt" TIMESTAMP WITH TIME ZONE,
        "submittedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "triageResult" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE
      );
    `);

    // 5. Create indices
    console.log('Ensuring indexes on "kyc_records"...');
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_kyc_userId" ON "kyc_records" ("userId");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_kyc_idNumber" ON "kyc_records" ("idNumber");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_kyc_docSha" ON "kyc_records" ("documentSha256");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_kyc_selfieSha" ON "kyc_records" ("selfieSha256");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_kyc_status" ON "kyc_records" ("status");`);

    console.log('✅ KYC database migration completed successfully!');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
