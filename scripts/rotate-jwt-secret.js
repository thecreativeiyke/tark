#!/usr/bin/env node
/**
 * Tark - rotate JWT_SECRET in .env (development helper).
 *
 *   node scripts/rotate-jwt-secret.js
 *
 * Replaces the JWT_SECRET line with a new cryptographically random value and never
 * prints it. Every existing login token becomes invalid, so everyone must log in
 * again. Restart the server afterwards.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.resolve(__dirname, '..', '.env');

let text;
try {
  text = fs.readFileSync(envPath, 'utf8');
} catch {
  console.error('.env was not found in the project root.');
  process.exit(1);
}

const matches = (text.match(/^JWT_SECRET=/gm) || []).length;
const secret = crypto.randomBytes(48).toString('hex');

let next;
if (matches === 0) {
  next = `${text.replace(/\s*$/, '')}\nJWT_SECRET=${secret}\n`;
} else {
  // Replaces every JWT_SECRET line, so a duplicate cannot silently keep the old value.
  next = text.replace(/^JWT_SECRET=.*$/gm, `JWT_SECRET=${secret}`);
}

fs.writeFileSync(envPath, next);

console.log(`JWT_SECRET rotated (${matches === 0 ? 'added' : `${matches} line(s) replaced`}). The value was not printed.`);
console.log('Restart the server now. All existing logins are invalid and users must sign in again.');
