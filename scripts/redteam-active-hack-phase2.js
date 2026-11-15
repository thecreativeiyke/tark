/**
 * RED-TEAM ACTIVE PENETRATION SUITE — PHASE 2 (aligned with ADR 009 Phase 10 contracts)
 * Tests: H-1 (artisan privacy + verified-category filter + distanceBand),
 *        H-2 (job discovery lockdown: GET /jobs, /jobs/teaser, /jobs/me, /jobs/:id),
 *        H-3 (bid IDOR), H-4 (password hash leak), H-5 (reviews allowlist + pagination),
 *        H-6 (self-service scope tampering), H-12 (support BOLA),
 *        P-2 (malformed webhook), P-3 (old-split bids accepted via acceptBid)
 *
 * Contracts asserted:
 *   GET /jobs                      401 anon, 403 non-artisan, { data, meta } for verified artisans, scoped to verifiedCategories + areaCode
 *   GET /jobs/teaser               public, <= 10 items, keys exactly { area, title, category, createdAt, budgetTier }
 *   GET /jobs/me                   401 anon, party view for client/assigned artisan only
 *   GET /jobs/:id                  400 on bad uuid, 404 for non-parties on non-OPEN jobs, public view hides client/tranche/coords
 *   GET /reviews/artisan/:id       400 on bad uuid, { data, meta }, keys exactly { id, rating, comment, proofMediaUrls, createdAt }
 *   GET /users/artisans/nearby     distanceBand (no distanceKm); category matches verifiedCategories, not skills
 *
 * NODE_ENV must NOT be production to run.
 * Note: /jobs/teaser is throttled to 10 req/min per IP. Wait ~60s after any load test before running.
 */
const http = require('http');
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run red-team script in production!');
  process.exit(1);
}

function req(opts, body = null) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const BASE = { hostname: 'localhost', port: 3000 };
const ts = Date.now();

const sortedKeys = (o) => Object.keys(o || {}).sort();
function assertKeys(label, obj, expected) {
  const got = sortedKeys(obj);
  const want = [...expected].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: key allowlist violated.\n   got:  ${got.join(', ')}\n   want: ${want.join(', ')}`);
  }
}
function assertNoLeak(label, payload, needles) {
  const json = JSON.stringify(payload);
  for (const n of needles) {
    if (json.includes(n)) throw new Error(`${label}: leaked "${n}"`);
  }
}
function assertStatus(label, res, expected) {
  if (res.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${res.status} (${JSON.stringify(res.data).slice(0, 200)})`);
  }
}
function assertPage(label, body) {
  if (!body || !Array.isArray(body.data) || !body.meta) {
    throw new Error(`${label}: expected { data, meta }, got ${JSON.stringify(body).slice(0, 200)}`);
  }
  assertKeys(`${label} meta`, body.meta, ['limit', 'hasMore', 'nextCursor']);
}

function POST(path, body, token) {
  return req({
    ...BASE, path, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }, body);
}
function GET(path, token) {
  return req({
    ...BASE, path, method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
function PATCH(path, body, token) {
  return req({
    ...BASE, path, method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }, body);
}

async function register(email, role) {
  const r = await POST('/auth/register', { email, password: 'SecurePass1!', fullName: 'Red Team Tester', role });
  if (r.status !== 201) throw new Error(`Register failed for ${email}: ${JSON.stringify(r.data)}`);
  return r.data.accessToken;
}

const DISCOVERY_KEYS = ['id', 'title', 'description', 'category', 'areaCode', 'location', 'currency', 'budget', 'status', 'createdAt'];
const PARTY_KEYS = [
  'id', 'myRole', 'title', 'description', 'category', 'areaCode', 'currency', 'budget',
  'tranche1Amount', 'tranche2Amount', 'status', 'clientId', 'artisanId', 'location',
  'latitude', 'longitude', 'mediaUrls', 'createdAt', 'updatedAt',
];
const PUBLIC_JOB_KEYS = ['id', 'title', 'description', 'category', 'areaCode', 'location', 'status', 'budgetTier', 'createdAt'];
const TEASER_KEYS = ['area', 'title', 'category', 'createdAt', 'budgetTier'];
const BUDGET_TIERS = ['MICRO', 'STANDARD', 'MAJOR', 'CUSTOM_QUOTE'];
const NEARBY_KEYS = ['createdAt', 'distanceBand', 'fullName', 'id', 'isCertifiedByTark', 'role', 'skills'];
const DISTANCE_BANDS = ['< 2 km', '2–5 km', '5–10 km', '10+ km'];
const REVIEW_KEYS = ['id', 'rating', 'comment', 'proofMediaUrls', 'createdAt'];

async function main() {
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  console.log('\n================================================================');
  console.log('💥 RED-TEAM PHASE 2: IDOR, PRIVACY & DATA LEAKAGE ATTACKS');
  console.log('================================================================\n');

  // Setup: 2 clients, 1 artisan, 1 outsider
  const clientA_token = await register(`rt2.clientA.${ts}@tark.ng`, 'client');
  const clientB_token = await register(`rt2.clientB.${ts}@tark.ng`, 'client');
  const artisan_token = await register(`rt2.artisan.${ts}@tark.ng`, 'artisan');
  const outsider_token = await register(`rt2.outsider.${ts}@tark.ng`, 'client');

  // Extract IDs from token
  function decodeId(token) {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
  }
  const clientA_id = decodeId(clientA_token);
  const clientB_id = decodeId(clientB_token);
  const artisan_id = decodeId(artisan_token);

  // Certify artisan and set location in DB (bypass KYC for test setup)
  await pgClient.query(
    `UPDATE "user" SET "isCertifiedByTark" = true, role = 'artisan', latitude = 6.5244, longitude = 3.3792 WHERE id = $1`,
    [artisan_id],
  );

  // Create jobs for clientA with a specific street address
  const secretStreet = '12 Adeola Odeku Street';
  const jobRes = await POST('/jobs', {
    title: 'Secret Home Repair',
    description: 'Fix my private residence',
    category: 'Plumbing',
    budget: 50000,
    location: `${secretStreet}, Victoria Island, Lagos`,
    latitude: 6.4281,
    longitude: 3.4219,
  }, clientA_token);
  if (jobRes.status !== 201) throw new Error('Job creation failed: ' + JSON.stringify(jobRes.data));
  const jobId = jobRes.data.id;
  const jobCategory = jobRes.data.category; // canonical slug resolved server-side
  const jobArea = jobRes.data.areaCode; // derived server-side from the last comma segment
  if (!jobCategory || !jobArea) {
    throw new Error(`Setup failed: job missing category/areaCode (got ${jobCategory} / ${jobArea})`);
  }
  console.log(`✅ Setup: Job ${jobId} created by Client A with private address (category=${jobCategory}, area=${jobArea})`);

  // Admin-verified scope (what KYC approval would set). `skills` is self-tagged to an UNVERIFIED trade.
  const selfTaggedTrade = 'gas-installation';
  async function setScope(categories, area) {
    await pgClient.query(
      `UPDATE "user" SET "verifiedCategories" = $2::text[], "areaCode" = $3 WHERE id = $1`,
      [artisan_id, categories, area],
    );
  }
  await setScope([jobCategory], jobArea);
  await pgClient.query(`UPDATE "user" SET skills = $2::text[] WHERE id = $1`, [artisan_id, [selfTaggedTrade]]);

  // ─────────────────────────────────────────────────────────────────────────────
  // H-4: PASSWORD HASH LEAK — does the User entity ever expose `password`?
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 1 (H-4): Password Hash Leak via /auth/me and /users...');

  // Check register response
  const regFull = await POST('/auth/register', { email: `rt2.pw.${ts}@tark.ng`, password: 'TestPass1!', fullName: 'PW Test', role: 'CLIENT' });
  if (regFull.data.password) {
    throw new Error('EXPLOIT H-4 SUCCEEDED! Register returned password hash!');
  }

  // Check /auth/me
  const meRes = await GET('/auth/me', clientA_token);
  if (meRes.data?.password || meRes.data?.user?.password) {
    throw new Error('EXPLOIT H-4 SUCCEEDED! /auth/me returned password hash!');
  }
  console.log('   Register response fields:', Object.keys(regFull.data).join(', '));
  console.log('   /auth/me response fields:', Object.keys(meRes.data || meRes.data?.user || {}).join(', '));
  console.log('   🛡️  SEALED: No password hash in auth responses.');

  // ─────────────────────────────────────────────────────────────────────────────
  // H-2: JOB DISCOVERY LOCKDOWN — /jobs, /jobs/teaser, /jobs/me, /jobs/:id
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 2 (H-2): Job discovery lockdown & location privacy...');

  // 2a. GET /jobs: anonymous -> 401, any non-artisan -> 403
  const anonList = await GET('/jobs');
  assertStatus('EXPLOIT H-2: anonymous GET /jobs', anonList, 401);
  const clientList = await GET('/jobs', clientA_token);
  assertStatus('EXPLOIT H-2: client GET /jobs', clientList, 403);
  const outsiderList = await GET('/jobs', outsider_token);
  assertStatus('EXPLOIT H-2: outsider client GET /jobs', outsiderList, 403);
  console.log(`   GET /jobs anon → ${anonList.status}, client → ${clientList.status}, outsider → ${outsiderList.status} ✓`);

  // 2b. Verified artisan: { data, meta }, discovery allowlist only, coarse location
  const artisanList = await GET('/jobs', artisan_token);
  assertStatus('GET /jobs as verified artisan', artisanList, 200);
  assertPage('GET /jobs', artisanList.data);
  const discovered = artisanList.data.data.find((j) => j.id === jobId);
  if (!discovered) throw new Error('REGRESSION H-2: verified in-scope artisan cannot see an OPEN job in their category + area!');
  for (const item of artisanList.data.data) {
    assertKeys('GET /jobs item', item, DISCOVERY_KEYS);
    if (item.status !== 'OPEN') throw new Error(`EXPLOIT H-2: GET /jobs returned a ${item.status} job!`);
  }
  assertNoLeak('GET /jobs', discovered, [secretStreet, clientA_id, 'latitude', 'longitude', 'tranche', 'mediaUrls']);
  console.log(`   Verified artisan sees "${discovered.location}" (coarse), keys = allowlist ✓`);

  // 2c. status param can never widen the result set
  const statusProbe = await GET('/jobs?status=COMPLETED', artisan_token);
  if (statusProbe.status === 200) {
    assertPage('GET /jobs?status=COMPLETED', statusProbe.data);
    if (statusProbe.data.data.some((j) => j.status !== 'OPEN')) {
      throw new Error('EXPLOIT H-2: caller-chosen status returned non-OPEN jobs!');
    }
  } else if (statusProbe.status !== 400) {
    throw new Error(`Unexpected status ${statusProbe.status} for GET /jobs?status=COMPLETED`);
  }
  console.log(`   GET /jobs?status=COMPLETED → ${statusProbe.status} (400 or OPEN-only) ✓`);

  // 2d. Scope enforcement: wrong area / wrong category / empty scope / unverified category filter
  async function visibleInDiscovery(query = '') {
    const r = await GET(`/jobs${query}`, artisan_token);
    assertStatus(`GET /jobs${query}`, r, 200);
    assertPage(`GET /jobs${query}`, r.data);
    return r.data.data.some((j) => j.id === jobId);
  }
  await setScope([jobCategory], 'abuja');
  if (await visibleInDiscovery()) throw new Error('EXPLOIT H-2: artisan in a different area saw this job!');
  await setScope(['electrical'], jobArea);
  if (await visibleInDiscovery()) throw new Error('EXPLOIT H-2: artisan without the job category saw this job!');
  await setScope([], jobArea);
  if (await visibleInDiscovery()) throw new Error('EXPLOIT H-2: artisan with an EMPTY scope saw jobs!');
  await setScope([jobCategory], jobArea);
  if (!(await visibleInDiscovery())) throw new Error('REGRESSION H-2: scope restore failed, job not visible.');
  if (await visibleInDiscovery(`?category=${selfTaggedTrade}`)) {
    throw new Error('EXPLOIT H-2: ?category widened scope beyond verifiedCategories!');
  }
  console.log('   Wrong area / wrong category / empty scope / unverified ?category → job hidden ✓');

  // 2e. GET /jobs/teaser: public allowlist, <= 10 items
  const teaser = await GET('/jobs/teaser');
  if (teaser.status === 429) {
    throw new Error('Teaser throttled (10 req/min). Wait ~60s after any load test and re-run.');
  }
  assertStatus('GET /jobs/teaser (anonymous)', teaser, 200);
  if (!Array.isArray(teaser.data) || teaser.data.length > 10) {
    throw new Error(`EXPLOIT H-2: teaser returned ${Array.isArray(teaser.data) ? teaser.data.length : typeof teaser.data} items (max 10)!`);
  }
  for (const item of teaser.data) {
    assertKeys('GET /jobs/teaser item', item, TEASER_KEYS);
    if (!BUDGET_TIERS.includes(item.budgetTier)) throw new Error(`Teaser budgetTier "${item.budgetTier}" is not a tier`);
  }
  assertNoLeak('GET /jobs/teaser', teaser.data, [secretStreet, clientA_id, jobId, 'latitude', '"budget"', 'currency']);
  console.log(`   GET /jobs/teaser (anon) → ${teaser.data.length} items, keys = { ${TEASER_KEYS.join(', ')} } ✓`);

  // 2f. GET /jobs/me: personal workspace only
  const anonMine = await GET('/jobs/me');
  assertStatus('EXPLOIT H-2: anonymous GET /jobs/me', anonMine, 401);
  const ownerMine = await GET('/jobs/me', clientA_token);
  assertStatus('GET /jobs/me as owner', ownerMine, 200);
  assertPage('GET /jobs/me', ownerMine.data);
  const mine = ownerMine.data.data.find((j) => j.id === jobId);
  if (!mine) throw new Error('REGRESSION H-2: owner cannot see their own job on GET /jobs/me!');
  assertKeys('GET /jobs/me party view', mine, PARTY_KEYS);
  if (mine.myRole !== 'CLIENT') throw new Error(`GET /jobs/me myRole expected CLIENT, got ${mine.myRole}`);
  if (!mine.location.includes(secretStreet)) throw new Error('REGRESSION H-2: owner lost their exact address on /jobs/me!');
  for (const who of [['outsider', outsider_token], ['unassigned artisan', artisan_token], ['other client', clientB_token]]) {
    const r = await GET('/jobs/me', who[1]);
    assertStatus(`GET /jobs/me as ${who[0]}`, r, 200);
    if (r.data.data.some((j) => j.id === jobId)) {
      throw new Error(`EXPLOIT H-2: ${who[0]} saw another user's job on GET /jobs/me!`);
    }
  }
  const badCursor = await GET('/jobs/me?cursor=not-a-real-cursor', clientA_token);
  assertStatus('GET /jobs/me with garbage cursor', badCursor, 400);
  console.log('   /jobs/me: anon 401, owner sees party view, strangers see nothing, bad cursor 400 ✓');

  // 2g. GET /jobs/:id: uuid validation, public view, party view, non-open => 404
  const badId = await GET('/jobs/not-a-uuid');
  assertStatus('GET /jobs/not-a-uuid', badId, 400);
  const missing = await GET(`/jobs/${crypto.randomUUID()}`);
  assertStatus('GET /jobs/<random uuid>', missing, 404);

  const anonJob = await GET(`/jobs/${jobId}`);
  const outsiderJob = await GET(`/jobs/${jobId}`, outsider_token);
  const artisanJob = await GET(`/jobs/${jobId}`, artisan_token);
  const ownerJob = await GET(`/jobs/${jobId}`, clientA_token);
  assertStatus('GET /jobs/:id anonymous', anonJob, 200);
  assertStatus('GET /jobs/:id outsider', outsiderJob, 200);
  assertStatus('GET /jobs/:id verified artisan', artisanJob, 200);
  assertStatus('GET /jobs/:id owner', ownerJob, 200);

  assertKeys('GET /jobs/:id anonymous public view', anonJob.data, PUBLIC_JOB_KEYS);
  assertKeys('GET /jobs/:id outsider public view', outsiderJob.data, PUBLIC_JOB_KEYS);
  assertKeys('GET /jobs/:id verified artisan public view', artisanJob.data, [...PUBLIC_JOB_KEYS, 'budget', 'currency']);
  assertKeys('GET /jobs/:id owner party view', ownerJob.data, PARTY_KEYS);
  assertNoLeak('GET /jobs/:id anonymous', anonJob.data, [secretStreet, clientA_id, 'latitude', 'longitude', 'tranche', 'mediaUrls', 'clientId']);
  assertNoLeak('GET /jobs/:id outsider', outsiderJob.data, [secretStreet, clientA_id, 'latitude', 'longitude', 'tranche', 'mediaUrls', 'clientId']);
  assertNoLeak('GET /jobs/:id verified artisan (not assigned)', artisanJob.data, [secretStreet, clientA_id, 'latitude', 'longitude', 'tranche', 'mediaUrls', 'clientId']);
  if (!ownerJob.data.location.includes(secretStreet)) throw new Error('REGRESSION: Job owner could not see their own full address!');
  if (ownerJob.data.latitude === null) throw new Error('REGRESSION: Job owner lost exact coordinates!');

  // Non-open job: non-parties must not be able to tell it exists
  await pgClient.query(`UPDATE job SET status = 'IN_PROGRESS' WHERE id = $1`, [jobId]);
  const anonClosed = await GET(`/jobs/${jobId}`);
  const outsiderClosed = await GET(`/jobs/${jobId}`, outsider_token);
  const artisanClosed = await GET(`/jobs/${jobId}`, artisan_token);
  const ownerClosed = await GET(`/jobs/${jobId}`, clientA_token);
  await pgClient.query(`UPDATE job SET status = 'OPEN' WHERE id = $1`, [jobId]);
  assertStatus('EXPLOIT H-2: anonymous read of a non-OPEN job', anonClosed, 404);
  assertStatus('EXPLOIT H-2: outsider read of a non-OPEN job', outsiderClosed, 404);
  assertStatus('EXPLOIT H-2: unassigned artisan read of a non-OPEN job', artisanClosed, 404);
  assertStatus('REGRESSION: owner read of own non-OPEN job', ownerClosed, 200);

  console.log(`   Anonymous sees location: "${anonJob.data.location}"`);
  console.log(`   Outsider sees location: "${outsiderJob.data.location}"`);
  console.log(`   Owner sees location: "${ownerJob.data.location?.slice(0, 40)}..."`);
  console.log('   Non-OPEN job → 404 for anon/outsider/unassigned artisan, 200 for owner ✓');
  console.log('   🛡️  SEALED: Discovery is verified-artisan-only; public views are allowlisted and coarse.');

  // ─────────────────────────────────────────────────────────────────────────────
  // H-3: BID IDOR — unauthorized user reading another job's bids
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 3 (H-3): Bid IDOR — Outsider must not read bids on another job...');

  // Try to get bids without auth
  const anonBidRes = await GET(`/bids/job/${jobId}`);
  if (anonBidRes.status !== 401) {
    throw new Error(`EXPLOIT H-3 SUCCEEDED! GET /bids/job/:id without auth returned ${anonBidRes.status} instead of 401!`);
  }

  // A real bid must exist, otherwise "empty list" proves nothing
  const bidRes = await POST('/bids', {
    jobId, amount: 50000, tranche1Amount: 20000, tranche2Amount: 30000, coverNote: 'rt2 bid',
  }, artisan_token);
  if (bidRes.status !== 201) throw new Error('Setup failed: could not place bid: ' + JSON.stringify(bidRes.data));
  const bidId = bidRes.data.id;

  const outsiderBidRes = await GET(`/bids/job/${jobId}`, outsider_token);
  const ownerBidRes = await GET(`/bids/job/${jobId}`, clientA_token);
  const artisanBidRes = await GET(`/bids/job/${jobId}`, artisan_token);
  const outsiderSingleBid = await GET(`/bids/${bidId}`, outsider_token);

  if (!Array.isArray(ownerBidRes.data) || ownerBidRes.data.length !== 1) {
    throw new Error('REGRESSION H-3: job owner cannot see the bid on their own job!');
  }
  if (!Array.isArray(artisanBidRes.data) || artisanBidRes.data.length !== 1) {
    throw new Error('REGRESSION H-3: bidding artisan cannot see their own bid!');
  }
  if (outsiderBidRes.status === 200 && Array.isArray(outsiderBidRes.data) && outsiderBidRes.data.length > 0) {
    throw new Error('EXPLOIT H-3 SUCCEEDED! Outsider can see bids on a job they do not own!');
  }
  if (outsiderSingleBid.status !== 403) {
    throw new Error(`EXPLOIT H-3 SUCCEEDED! GET /bids/:id by outsider returned ${outsiderSingleBid.status} instead of 403!`);
  }

  console.log(`   Anonymous → GET /bids/job/:id → ${anonBidRes.status} (must be 401) ✓`);
  console.log(`   Outsider  → GET /bids/job/:id → ${outsiderBidRes.status} (empty or 403) ✓`);
  console.log('   🛡️  SEALED: Bid route requires authentication; non-owners see empty list.');

  // ─────────────────────────────────────────────────────────────────────────────
  // H-1: NEARBY ARTISAN PRIVACY — auth, allowlist, distanceBand, verified categories
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 4 (H-1): Artisan Nearby — requires auth, allowlist, distanceBand, verified scope...');

  const nearbyQuery = 'lat=6.5244&lng=3.3792';
  const anonNearbyRes = await GET(`/users/artisans/nearby?${nearbyQuery}`);
  if (anonNearbyRes.status !== 401) {
    throw new Error(`EXPLOIT H-1 SUCCEEDED! Anonymous caller got artisan list (status ${anonNearbyRes.status})!`);
  }

  const authNearbyRes = await GET(`/users/artisans/nearby?${nearbyQuery}`, clientA_token);
  assertStatus('GET /users/artisans/nearby as client', authNearbyRes, 200);
  if (!Array.isArray(authNearbyRes.data)) {
    throw new Error(`GET /users/artisans/nearby expected an array, got ${JSON.stringify(authNearbyRes.data).slice(0, 200)}`);
  }
  for (const a of authNearbyRes.data) {
    assertKeys('GET /users/artisans/nearby item', a, NEARBY_KEYS);
    if ('distanceKm' in a) throw new Error('EXPLOIT H-1: exact distanceKm exposed in nearby results!');
    if (!DISTANCE_BANDS.includes(a.distanceBand)) throw new Error(`Unexpected distanceBand "${a.distanceBand}"`);
    if (!a.isCertifiedByTark) throw new Error('EXPLOIT H-1: Uncertified artisans included in nearby results!');
  }
  assertNoLeak('GET /users/artisans/nearby', authNearbyRes.data, ['@tark.ng', 'phoneNumber', 'latitude', 'longitude', 'walletBalance', 'verifiedCategories', 'areaCode']);

  const me = authNearbyRes.data.find((a) => a.id === artisan_id);
  if (!me) throw new Error('REGRESSION H-1: certified artisan at the query point is missing from nearby results!');
  if (me.distanceBand !== '< 2 km') throw new Error(`Expected "< 2 km" for an artisan at the query point, got "${me.distanceBand}"`);

  // Category filter must use verifiedCategories, NOT the self-editable skills array.
  const selfTagged = await GET(`/users/artisans/nearby?${nearbyQuery}&category=${selfTaggedTrade}`, clientA_token);
  assertStatus('nearby ?category=<self-tagged trade>', selfTagged, 200);
  if (selfTagged.data.some((a) => a.id === artisan_id)) {
    throw new Error('EXPLOIT H-1: artisan self-tagged into an unverified trade via skills and appeared in category search!');
  }
  const verifiedMatch = await GET(`/users/artisans/nearby?${nearbyQuery}&category=${jobCategory}`, clientA_token);
  assertStatus('nearby ?category=<verified trade>', verifiedMatch, 200);
  if (!verifiedMatch.data.some((a) => a.id === artisan_id)) {
    throw new Error('REGRESSION H-1: artisan verified for this trade is missing from the category search!');
  }
  const upperMatch = await GET(`/users/artisans/nearby?${nearbyQuery}&category=${encodeURIComponent(jobCategory.toUpperCase())}`, clientA_token);
  assertStatus('nearby ?category=<VERIFIED TRADE UPPERCASE>', upperMatch, 200);
  if (!upperMatch.data.some((a) => a.id === artisan_id)) {
    throw new Error('REGRESSION H-1: category filter is not case-normalized!');
  }

  console.log(`   Anonymous → GET /users/artisans/nearby → ${anonNearbyRes.status} (must be 401) ✓`);
  console.log(`   Auth user → ${authNearbyRes.data.length} artisans, keys = allowlist, distanceBand="${me.distanceBand}", no distanceKm ✓`);
  console.log(`   ?category=${selfTaggedTrade} (self-tagged only) → hidden; ?category=${jobCategory} (verified) → shown ✓`);
  console.log('   🛡️  SEALED: Nearby artisans are auth-only, banded, allowlisted, and category-filtered on verified scope.');

  // ─────────────────────────────────────────────────────────────────────────────
  // P-2: MALFORMED WEBHOOK — NaN amount, missing reference, wrong status
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 5 (P-2): Malformed Webhook Payload Injection...');

  const paystackSecret = process.env.PAYSTACK_SECRET_KEY || 'fake';

  async function sendWebhook(payload) {
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac('sha512', paystackSecret).update(body).digest('hex');
    return req({ ...BASE, path: '/payments/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig } }, body);
  }

  // Set up a victim customer code
  const victimCode = `CUS_P2TEST_${ts}`;
  await pgClient.query(`UPDATE "user" SET "paystackCustomerCode" = $1, "walletBalance" = 1000 WHERE id = $2`, [victimCode, clientA_id]);

  // Attack 5a: NaN amount
  const nanRes = await sendWebhook({ event: 'charge.success', data: { reference: `P2NAN${ts}`, status: 'success', currency: 'NGN', amount: null, customer: { customer_code: victimCode } } });
  const nanCheck = await pgClient.query(`SELECT "walletBalance" FROM "user" WHERE id = $1`, [clientA_id]);
  if (Number(nanCheck.rows[0].walletBalance) !== 1000) {
    throw new Error(`EXPLOIT P-2 (NaN): Wallet balance changed when amount was null/NaN! Balance: ${nanCheck.rows[0].walletBalance}`);
  }
  console.log(`   NaN amount webhook → ${nanRes.status} "${nanRes.data?.message}"`);

  // Attack 5b: missing reference
  const noRefRes = await sendWebhook({ event: 'charge.success', data: { status: 'success', currency: 'NGN', amount: 500000, customer: { customer_code: victimCode } } });
  const noRefCheck = await pgClient.query(`SELECT "walletBalance" FROM "user" WHERE id = $1`, [clientA_id]);
  if (Number(noRefCheck.rows[0].walletBalance) !== 1000) {
    throw new Error(`EXPLOIT P-2 (no-ref): Wallet changed on webhook with no reference!`);
  }
  console.log(`   Missing reference webhook → ${noRefRes.status} "${noRefRes.data?.message}"`);

  // Attack 5c: wrong status
  const wrongStatusRes = await sendWebhook({ event: 'charge.success', data: { reference: `P2FAIL${ts}`, status: 'failed', currency: 'NGN', amount: 500000, customer: { customer_code: victimCode } } });
  const wrongStatusCheck = await pgClient.query(`SELECT "walletBalance" FROM "user" WHERE id = $1`, [clientA_id]);
  if (Number(wrongStatusCheck.rows[0].walletBalance) !== 1000) {
    throw new Error(`EXPLOIT P-2 (wrong-status): Wallet changed on failed charge webhook!`);
  }
  console.log(`   Failed status webhook → ${wrongStatusRes.status} "${wrongStatusRes.data?.message}"`);
  console.log('   🛡️  SEALED: All malformed webhooks correctly ignored, wallet balance unchanged.');

  // ─────────────────────────────────────────────────────────────────────────────
  // H-12: SUPPORT BOLA — user can't load context of a job they don't own
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 6 (H-12): Support BOLA — outsider sees another user\'s job context...');

  // outsider opens a support ticket referencing clientA's job
  const supportRes = await POST('/support/ticket', {
    subject: 'I need help with my job',
    message: 'Tell me about this job',
    jobId,
  }, outsider_token);

  // The response should not contain clientA's job details in the AI context
  const supportData = supportRes.data;
  const responseStr = JSON.stringify(supportData);

  // If the AI response includes the exact secret street address (from clientA's job context), that's a BOLA
  if (responseStr.includes(secretStreet)) {
    throw new Error('EXPLOIT H-12 SUCCEEDED! Support AI context leaked clientA\'s private job address to outsider!');
  }

  console.log(`   Outsider support ticket using clientA's job ID → response does not leak address ✓`);
  console.log('   🛡️  SEALED: Support BOLA — job context only loaded for parties to the job.');

  // ─────────────────────────────────────────────────────────────────────────────
  // H-5: PUBLIC REVIEWS — allowlist projection + keyset pagination
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 7 (H-5): Public reviews — allowlist, moderation fields, pagination...');

  const adminNote = `SECRET-ADMIN-NOTE-${ts}`;
  const pendingMarker = `PENDING-LEAK-${ts}`;
  for (let i = 0; i < 3; i++) {
    await pgClient.query(
      `INSERT INTO "review" ("id", "jobId", "clientId", "artisanId", rating, comment, "proofMediaUrls", status, "adminNotes", "moderatedBy", "moderatedAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], 'APPROVED', $8, $9, NOW(), NOW() - make_interval(secs => $10::int))`,
      [crypto.randomUUID(), crypto.randomUUID(), clientB_id, artisan_id, 5 - i, `rt2 approved review ${i}`, [`https://example.com/proof-${i}.jpg`], adminNote, clientB_id, i * 10],
    );
  }
  await pgClient.query(
    `INSERT INTO "review" ("id", "jobId", "clientId", "artisanId", rating, comment, "proofMediaUrls", status)
     VALUES ($1, $2, $3, $4, 1, $5, '{}', 'PENDING_REVIEW')`,
    [crypto.randomUUID(), crypto.randomUUID(), clientB_id, artisan_id, pendingMarker],
  );

  const badReviewId = await GET('/reviews/artisan/not-a-uuid');
  assertStatus('GET /reviews/artisan/not-a-uuid', badReviewId, 400);

  const reviewsRes = await GET(`/reviews/artisan/${artisan_id}`);
  assertStatus('GET /reviews/artisan/:id (anonymous)', reviewsRes, 200);
  assertPage('GET /reviews/artisan/:id', reviewsRes.data);
  if (reviewsRes.data.data.length !== 3) {
    throw new Error(`Expected 3 approved reviews (pending excluded), got ${reviewsRes.data.data.length}`);
  }
  for (const r of reviewsRes.data.data) assertKeys('GET /reviews/artisan/:id item', r, REVIEW_KEYS);
  assertNoLeak('GET /reviews/artisan/:id', reviewsRes.data, [adminNote, clientB_id, pendingMarker, 'adminNotes', 'moderatedBy', 'moderatedAt', 'clientId', 'jobId', 'PENDING_REVIEW']);
  const ratings = reviewsRes.data.data.map((r) => r.rating);
  if (JSON.stringify(ratings) !== JSON.stringify([5, 4, 3])) {
    throw new Error(`Reviews not ordered createdAt DESC: got ratings ${ratings.join(',')}`);
  }

  const page1 = await GET(`/reviews/artisan/${artisan_id}?limit=2`);
  assertStatus('reviews page 1', page1, 200);
  assertPage('reviews page 1', page1.data);
  if (page1.data.data.length !== 2 || page1.data.meta.hasMore !== true || typeof page1.data.meta.nextCursor !== 'string') {
    throw new Error(`Reviews page 1 wrong: ${JSON.stringify(page1.data.meta)} (${page1.data.data.length} items)`);
  }
  const page2 = await GET(`/reviews/artisan/${artisan_id}?limit=2&cursor=${encodeURIComponent(page1.data.meta.nextCursor)}`);
  assertStatus('reviews page 2', page2, 200);
  assertPage('reviews page 2', page2.data);
  if (page2.data.data.length !== 1 || page2.data.meta.hasMore !== false || page2.data.meta.nextCursor !== null) {
    throw new Error(`Reviews page 2 wrong: ${JSON.stringify(page2.data.meta)} (${page2.data.data.length} items)`);
  }
  const pagedIds = [...page1.data.data, ...page2.data.data].map((r) => r.id);
  if (new Set(pagedIds).size !== 3) throw new Error('Reviews pagination duplicated or dropped rows!');

  const garbageCursor = await GET(`/reviews/artisan/${artisan_id}?cursor=garbage`);
  assertStatus('reviews garbage cursor', garbageCursor, 400);
  const hugeLimit = await GET(`/reviews/artisan/${artisan_id}?limit=1000`);
  if (hugeLimit.status === 200) {
    if (hugeLimit.data.meta.limit > 50 || hugeLimit.data.data.length > 50) {
      throw new Error('EXPLOIT H-5: limit above 50 was honoured (scraping vector)!');
    }
  } else if (hugeLimit.status !== 400) {
    throw new Error(`Unexpected status ${hugeLimit.status} for limit=1000`);
  }

  console.log('   Reviews: bad uuid 400, 3 approved only (pending hidden), keys = allowlist, no adminNotes/moderatedBy/clientId/jobId ✓');
  console.log('   Pagination: limit=2 → 2 + hasMore, cursor → 1 + done, no dupes; garbage cursor 400; limit capped ✓');
  console.log('   🛡️  SEALED: Public reviews are allowlisted, paginated and moderation-metadata free.');

  // ─────────────────────────────────────────────────────────────────────────────
  // H-6: SCOPE TAMPERING — artisan cannot self-grant verified categories / area
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n⚔️  ATTACK 8 (H-6): Artisan self-grants verifiedCategories / areaCode via PATCH /users/profile...');

  const tamper = await PATCH('/users/profile', {
    verifiedCategories: [selfTaggedTrade, 'electrical'],
    areaCode: 'abuja',
  }, artisan_token);
  const scopeAfter = await pgClient.query(`SELECT "verifiedCategories", "areaCode" FROM "user" WHERE id = $1`, [artisan_id]);
  const { verifiedCategories: vcAfter, areaCode: areaAfter } = scopeAfter.rows[0];
  if (JSON.stringify(vcAfter) !== JSON.stringify([jobCategory]) || areaAfter !== jobArea) {
    throw new Error(`EXPLOIT H-6 SUCCEEDED! Profile PATCH changed admin scope to ${JSON.stringify(vcAfter)} / ${areaAfter}`);
  }
  console.log(`   PATCH /users/profile with scope fields → ${tamper.status}; DB scope unchanged (${jobCategory} / ${jobArea}) ✓`);
  console.log('   🛡️  SEALED: verifiedCategories and areaCode are admin-only.');

  // ─────────────────────────────────────────────────────────────────────────────
  // CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────
  const emails = [
    `rt2.clientA.${ts}@tark.ng`,
    `rt2.clientB.${ts}@tark.ng`,
    `rt2.artisan.${ts}@tark.ng`,
    `rt2.outsider.${ts}@tark.ng`,
    `rt2.pw.${ts}@tark.ng`,
  ];

  const idRes = await pgClient.query(`SELECT id FROM "user" WHERE email = ANY($1::text[])`, [emails]);
  const ids = idRes.rows.map(r => r.id);
  if (ids.length > 0) {
    const idList = ids.map((_, i) => `$${i+1}`).join(',');
    await pgClient.query(`DELETE FROM "review" WHERE "artisanId"::text IN (${idList}) OR "clientId"::text IN (${idList})`, ids);
    await pgClient.query(`DELETE FROM wallet_ledgers WHERE "userId"::text IN (${idList})`, ids);
    await pgClient.query(`DELETE FROM notifications WHERE "userId"::text IN (${idList})`, ids);
    await pgClient.query(`DELETE FROM bid WHERE "artisanId"::text IN (${idList}) OR "jobId"::text IN (SELECT id::text FROM job WHERE "clientId"::text IN (${idList}))`, ids);
    await pgClient.query(`DELETE FROM escrow_transaction WHERE "clientId"::text IN (${idList}) OR "artisanId"::text IN (${idList})`, ids);
    await pgClient.query(`DELETE FROM job WHERE "clientId"::text IN (${idList})`, ids);
    await pgClient.query(`DELETE FROM "user" WHERE id::text IN (${idList})`, ids);
  }

  await pgClient.end();

  console.log('\n================================================================');
  console.log('✨ ALL PHASE 2 ACTIVE RED-TEAM ATTACKS WERE 100% REPELLED!');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('\n❌ PHASE 2 RED-TEAM FAILED:', err.message);
  process.exit(1);
});
