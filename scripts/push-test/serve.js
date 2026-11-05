#!/usr/bin/env node
/**
 * Tark - local Web Push test harness (development only).
 *
 *   1. Start the API:      npm run start:dev
 *   2. Start this page:    node scripts/push-test/serve.js
 *   3. Open Chrome/Edge:   http://localhost:5173
 *
 * Why this exists: Web Push can only be received by a real browser that has a service
 * worker and a subscription. There is no Tark frontend yet, so this tiny page plays that
 * role. "localhost" counts as a secure context, so no HTTPS is needed here.
 *
 * It serves ONLY the whitelisted paths below (no directory access) and generates
 * placeholder icon/badge PNGs in memory (emerald square with a white "T").
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PUSH_TEST_PORT || 5173);
const DIR = __dirname;

// ---- minimal PNG encoder (no dependencies) ------------------------------------------
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const isT = (u, v) =>
  (u >= 0.22 && u <= 0.78 && v >= 0.22 && v <= 0.38) || // top bar
  (u >= 0.43 && u <= 0.57 && v >= 0.22 && v <= 0.78); // stem

// icon: emerald square, white T.  badge: transparent, white T (Android wants alpha-only).
const ICON = makePng(192, (u, v) => (isT(u, v) ? [255, 255, 255, 255] : [16, 185, 129, 255]));
const BADGE = makePng(72, (u, v) => (isT(u, v) ? [255, 255, 255, 255] : [0, 0, 0, 0]));

const FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' },
};

http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const headers = { 'Cache-Control': 'no-store' };

    if (url === '/icon-192.png') {
      res.writeHead(200, { ...headers, 'Content-Type': 'image/png' });
      return res.end(ICON);
    }
    if (url === '/badge-72.png') {
      res.writeHead(200, { ...headers, 'Content-Type': 'image/png' });
      return res.end(BADGE);
    }

    const entry = FILES[url];
    if (!entry) {
      res.writeHead(404, headers);
      return res.end('Not found');
    }
    fs.readFile(path.join(DIR, entry.file), (err, data) => {
      if (err) {
        res.writeHead(500, headers);
        return res.end('Could not read file');
      }
      res.writeHead(200, { ...headers, 'Content-Type': entry.type });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Tark push test page:  http://localhost:${PORT}`);
    console.log('Make sure the API is running (npm run start:dev). Press Ctrl+C to stop.');
  });
