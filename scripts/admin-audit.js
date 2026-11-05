#!/usr/bin/env node
/**
 * Tark - admin account audit & role helper (safe by default).
 *
 * Shows every admin / super_admin account in the database. It changes NOTHING
 * unless you pass --yes together with --promote or --demote.
 *
 *   node scripts/admin-audit.js                                   list only
 *   node scripts/admin-audit.js --demote someone@mail.com         preview a change
 *   node scripts/admin-audit.js --demote someone@mail.com --yes   apply it (becomes "client")
 *   node scripts/admin-audit.js --promote you@mail.com --role super_admin --yes
 *
 * Never prints passwords or tokens. Reads DATABASE_URL and DB_SSL from .env.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* no .env */
  }
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

async function main() {
  loadEnv();

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('The "pg" package is missing. Run: npm install');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is missing from .env');
    process.exit(1);
  }
  const useSsl = (process.env.DB_SSL ?? 'true') === 'true';

  const demote = arg('demote');
  const promote = arg('promote');
  const role = arg('role') || 'admin';
  const apply = flag('yes');

  if (demote && promote) {
    console.error('Use either --demote or --promote, not both.');
    process.exit(1);
  }
  if (promote && !['admin', 'super_admin'].includes(role)) {
    console.error('--role must be "admin" or "super_admin".');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  try {
    const counts = await client.query(
      `SELECT role, COUNT(*)::int AS n FROM "user" GROUP BY role ORDER BY role`,
    );
    console.log('\nAccounts by role:');
    for (const r of counts.rows) console.log(`  ${String(r.role).padEnd(12)} ${r.n}`);

    const admins = await client.query(
      `SELECT id, email, "fullName", role, "createdAt"
         FROM "user"
        WHERE role IN ('admin', 'super_admin')
        ORDER BY "createdAt" ASC`,
    );
    console.log(`\nAdmin / super_admin accounts (${admins.rowCount}):`);
    if (!admins.rowCount) console.log('  (none)');
    for (const a of admins.rows) {
      console.log(
        `  ${String(a.role).padEnd(12)} ${a.email}  | ${a.fullName}  | created ${new Date(a.createdAt).toISOString()}`,
      );
    }

    const target = demote || promote;
    if (!target) {
      console.log('\nNothing changed (list only). See the top of this file to change a role.');
      return;
    }

    const newRole = demote ? 'client' : role;
    const found = await client.query(
      `SELECT id, email, role FROM "user" WHERE lower(email) = lower($1)`,
      [target],
    );
    if (found.rowCount !== 1) {
      console.error(`\nExpected exactly 1 account for "${target}" but found ${found.rowCount}. Nothing changed.`);
      process.exitCode = 1;
      return;
    }

    const user = found.rows[0];
    console.log(`\nPlanned change: ${user.email}   ${user.role}  ->  ${newRole}`);
    if (!apply) {
      console.log('Preview only. Add --yes to apply it.');
      return;
    }

    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE "user" SET role = $1 WHERE id = $2 RETURNING email, role`,
      [newRole, user.id],
    );
    if (upd.rowCount !== 1) {
      await client.query('ROLLBACK');
      console.error('Update did not affect exactly one row. Rolled back.');
      process.exitCode = 1;
      return;
    }
    await client.query('COMMIT');
    console.log(`Done: ${upd.rows[0].email} is now ${upd.rows[0].role}.`);
    console.log('Old login tokens keep their old role until they expire.');
    console.log('Run: node scripts/rotate-jwt-secret.js   then restart the server to log everyone out.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  const msg = String(err && err.message);
  console.error('Failed:', process.env.DATABASE_URL ? msg.split(process.env.DATABASE_URL).join('***') : msg);
  process.exit(1);
});
