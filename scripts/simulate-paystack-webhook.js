#!/usr/bin/env node
/**
 * Tark - local Paystack webhook simulator (development only).
 *
 * Sends a correctly SIGNED `charge.success` event to your LOCAL server, so you can
 * test escrow funding / wallet top-ups without a public tunnel.
 *
 * Fund an escrow (use the `reference` returned by POST /payments/initialize):
 *   node scripts/simulate-paystack-webhook.js --reference tark-<escrowId>-<timestamp>
 *
 * Credit a wallet (customer code from the user's paystackCustomerCode, amount in KOBO):
 *   node scripts/simulate-paystack-webhook.js --customer CUS_xxxx --amount 5000000
 *
 * Options:
 *   --url <url>       default http://localhost:<PORT or 3000>/payments/webhook
 *   --allow-remote    required to post anywhere other than localhost
 *
 * Signs with PAYSTACK_SECRET_KEY from .env (never printed). Refuses to run when
 * NODE_ENV=production.
 *
 * KNOWN ISSUE: the wallet-credit path does not yet ignore repeated events, so running it
 * twice credits twice. Use it to observe the bug; it is on the fix list.
 */
'use strict';

const crypto = require('crypto');
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

  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production.');
    process.exit(1);
  }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || secret.includes('placeholder')) {
    console.error('PAYSTACK_SECRET_KEY is missing or still a placeholder in .env.');
    process.exit(1);
  }

  const reference = arg('reference');
  const customer = arg('customer');
  const amount = arg('amount');
  if (!reference && !customer) {
    console.error('Provide --reference <escrow payment reference> or --customer <CUS_code> --amount <kobo>.');
    process.exit(1);
  }

  const url = arg('url') || `http://localhost:${process.env.PORT || 3000}/payments/webhook`;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error('Invalid --url.');
    process.exit(1);
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && !flag('allow-remote')) {
    console.error(`Refusing to post to ${host}. Add --allow-remote only if you really mean it.`);
    process.exit(1);
  }

  const event = {
    event: 'charge.success',
    data: {
      reference: reference || `sim-${Date.now()}`,
      status: 'success',
      currency: 'NGN',
      ...(amount ? { amount: Number(amount) } : {}),
      ...(customer ? { customer: { customer_code: customer } } : {}),
    },
  };

  const body = JSON.stringify(event);
  const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');

  console.log(`POST ${url}`);
  console.log(`event: ${event.event} | reference: ${event.data.reference}${customer ? ` | customer: ${customer}` : ''}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  console.log(`\nHTTP ${res.status}`);
  console.log(text);
}

main().catch((err) => {
  console.error('Fatal:', String(err && err.message).split(process.env.PAYSTACK_SECRET_KEY || '\u0000').join('***'));
  process.exit(1);
});
