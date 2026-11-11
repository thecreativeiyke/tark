/**
 * UPLOAD MAGIC-BYTE TEST SUITE
 *
 * Part A (offline): exercises the compiled detector in dist/media/file-signature.js
 *   -> run `npm run build` first.
 * Part B (live, needs the server on :3000): sends hostile uploads to /media/*.
 *   Every hostile case must be rejected with 400 BEFORE anything reaches storage, so this
 *   part leaves nothing behind in R2.
 *
 * Optional: `node scripts/test-upload-magic-bytes.js --with-upload` also uploads ONE genuine
 * 1x1 PNG to confirm the happy path. That object is real and stays in your bucket.
 */
require('dotenv').config();
const { Client } = require('pg');

const WITH_UPLOAD = process.argv.includes('--with-upload');
const BASE = 'http://localhost:3000';
const ts = Date.now();

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`   \u2705 ${name}`);
  } else {
    failed++;
    console.log(`   \u274c ${name} ${detail}`);
  }
}

// A genuine 1x1 PNG (67 bytes).
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const pad = (b, n = 32) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
const ftyp = (brand, size = 24) => {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(size, 0);
  head.write('ftyp', 4, 'ascii');
  head.write(brand, 8, 'ascii');
  return pad(head, size);
};

// -- PART A: detector --
function partA() {
  console.log('\n\u2554 PART A \u2014 detector (offline)');
  const { detectFileType, claimedKind, safeFilename } = require('../dist/media/file-signature');

  const accept = [
    ['JPEG', pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg'],
    ['PNG', VALID_PNG, 'image/png'],
    ['WebP', pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp'],
    ['HEIC (heic)', ftyp('heic'), 'image/heic'],
    ['HEIC (mif1)', ftyp('mif1'), 'image/heic'],
    ['MP4 (isom)', ftyp('isom'), 'video/mp4'],
    ['MP4 (mp42)', ftyp('mp42'), 'video/mp4'],
    ['MOV (qt)', ftyp('qt  '), 'video/quicktime'],
    ['WebM', pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8), Buffer.from('webm')])), 'video/webm'],
  ];
  for (const [name, buf, mime] of accept) {
    const d = detectFileType(buf);
    check(`accepts ${name} -> ${mime}`, d && d.mime === mime, `got ${JSON.stringify(d)}`);
  }

  const reject = [
    ['HTML with script', Buffer.from('<html><script>alert(1)</script></html>')],
    ['SVG (script-capable)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')],
    ['PHP', Buffer.from('<?php system($_GET["c"]); ?>')],
    ['Windows executable (MZ)', pad(Buffer.from('MZ'))],
    ['ELF executable', pad(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))],
    ['ZIP / APK / DOCX', pad(Buffer.from([0x50, 0x4b, 0x03, 0x04]))],
    ['PDF', Buffer.from('%PDF-1.7 ................')],
    ['GIF (not accepted)', pad(Buffer.from('GIF89a'))],
    ['AVIF (not accepted)', ftyp('avif')],
    ['3GP (not accepted)', ftyp('3gp4')],
    ['Matroska (not WebM)', pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8), Buffer.from('matroska')]))],
    ['ftyp with absurd box size', ftyp('isom', 24).fill(0xff, 0, 4)],
    ['too short (<12 bytes)', Buffer.from([0xff, 0xd8, 0xff])],
    ['empty', Buffer.alloc(0)],
  ];
  for (const [name, buf] of reject) {
    check(`rejects ${name}`, detectFileType(buf) === null);
  }

  check('claimedKind image/png -> image', claimedKind('image/png') === 'image');
  check('claimedKind video/mp4 -> video', claimedKind('video/mp4') === 'video');
  check('claimedKind text/html -> null', claimedKind('text/html') === null);

  check('safeFilename strips traversal', safeFilename('../../etc/passwd.png', 'png') === 'passwd.png');
  check('safeFilename neutralises double extension', safeFilename('shell.php.png', 'png') === 'shell-php.png');
  check('safeFilename forces detected extension', safeFilename('evil.html', 'png') === 'evil.png');
  check('safeFilename survives empty name', safeFilename('', 'jpg') === 'upload.jpg');
}

// -- PART B: live server --
async function post(path, token, field, parts) {
  const fd = new FormData();
  for (const p of parts) fd.append(field, new Blob([p.buf], { type: p.type }), p.name);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function partB() {
  console.log('\n\u2554 PART B \u2014 live endpoints (hostile uploads must be rejected before storage)');

  const reg = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `upload.test.${ts}@tark.ng`,
      password: 'SecurePass1!',
      fullName: 'Upload Test',
      role: 'client',
    }),
  });
  const regBody = await reg.json();
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(regBody)}`);
  const token = regBody.accessToken;
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;

  try {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    const php = Buffer.from('<?php system($_GET["c"]); ?>');
    const exe = pad(Buffer.from('MZ'), 64);
    const gif = pad(Buffer.from('GIF89a'), 64);
    const mp4 = ftyp('isom');

    const cases = [
      ['HTML disguised as image/png', 'image/png', 'avatar.png', html],
      ['PHP disguised as image/jpeg', 'image/jpeg', 'photo.jpg', php],
      ['EXE disguised as image/png', 'image/png', 'work.png', exe],
      ['GIF (unsupported) claiming image/png', 'image/png', 'a.png', gif],
      ['real MP4 claiming image/png (family mismatch)', 'image/png', 'a.png', mp4],
      ['real PNG claiming video/mp4 (family mismatch)', 'video/mp4', 'a.mp4', VALID_PNG],
      ['text/html claimed type (existing filter layer)', 'text/html', 'a.html', html],
    ];
    for (const [name, type, filename, buf] of cases) {
      const r = await post('/media/upload', token, 'file', [{ buf, type, name: filename }]);
      check(`/media/upload rejects ${name} (got ${r.status})`, r.status === 400, JSON.stringify(r.body));
    }

    const r1 = await post('/media/proof-of-work', token, 'files', [
      { buf: VALID_PNG, type: 'image/png', name: 'ok.png' },
      { buf: html, type: 'image/png', name: 'bad.png' },
    ]);
    check(`/media/proof-of-work rejects a batch containing one fake (got ${r1.status})`, r1.status === 400, JSON.stringify(r1.body));

    const r2 = await post('/media/job-diagnostics', token, 'files', [
      { buf: php, type: 'image/jpeg', name: 'x.jpg' },
    ]);
    check(`/media/job-diagnostics rejects PHP (got ${r2.status})`, r2.status === 400, JSON.stringify(r2.body));

    const r3 = await post('/media/upload', null, 'file', [{ buf: VALID_PNG, type: 'image/png', name: 'a.png' }]);
    check(`/media/upload requires auth (got ${r3.status})`, r3.status === 401);

    const r4 = await post('/media/upload', token, 'nofile', [{ buf: VALID_PNG, type: 'image/png', name: 'a.png' }]);
    check(`/media/upload with no 'file' field is rejected (got ${r4.status})`, r4.status === 400, JSON.stringify(r4.body));

    if (WITH_UPLOAD) {
      console.log('\n   --with-upload: sending ONE genuine 1x1 PNG (stays in your bucket)...');
      const ok = await post('/media/upload', token, 'file', [
        { buf: VALID_PNG, type: 'image/png', name: 'weird name.PNG' },
      ]);
      check(`genuine PNG accepted (got ${ok.status})`, ok.status === 201, JSON.stringify(ok.body));
      if (ok.status === 201) {
        check('response mimeType is the DETECTED type', ok.body.mimeType === 'image/png');
        check('response keeps the original name for display', ok.body.originalName === 'weird name.PNG');
        check('response has a cdnUrl', typeof ok.body.cdnUrl === 'string' && ok.body.cdnUrl.startsWith('http'));
        check('stored URL has no spaces (name was sanitised before storage)', !/%20| /.test(ok.body.cdnUrl));
      }
    } else {
      console.log('\n   (happy path skipped \u2014 add --with-upload to upload one real 1x1 PNG)');
    }
  } finally {
    if (process.env.DATABASE_URL) {
      const pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pg.connect();
      try {
        await pg.query(`DELETE FROM notifications WHERE "userId"::text = $1`, [userId]);
        await pg.query(`DELETE FROM wallet_ledgers WHERE "userId"::text = $1`, [userId]);
        await pg.query(`DELETE FROM "user" WHERE id::text = $1`, [userId]);
        console.log('\n   \ud83e\uddf9 Test user cleaned up.');
      } finally {
        await pg.end();
      }
    }
  }
}

(async () => {
  console.log('================================================================');
  console.log('\ud83d\udcf8 UPLOAD MAGIC-BYTE VALIDATION SUITE');
  console.log('================================================================');
  try {
    partA();
    await partB();
  } catch (err) {
    failed++;
    console.error('\n\u274c SUITE ERROR:', err.message);
  }
  console.log('\n================================================================');
  console.log(failed === 0 ? `\u2728 ALL ${passed} CHECKS PASSED` : `\u274c ${failed} FAILED, ${passed} passed`);
  console.log('================================================================\n');
  process.exit(failed === 0 ? 0 : 1);
})();
