#!/usr/bin/env node
/**
 * End-to-end test.
 *
 * Spawns the REAL built server (`dist/main.js`) against a REAL PostgreSQL +
 * TimescaleDB + PostGIS database and a REAL Redis, then drives the complete
 * dispatcher → driver → telemetry → realtime flow over HTTP and WebSocket.
 *
 * Nothing here is mocked. That is the point: the bugs this class of test finds
 * — the gzip/HMAC ordering contract, Fastify hook interactions, the Socket.IO
 * room fan-out — are invisible to unit tests by construction.
 *
 *   node test/e2e.mjs
 *
 * Requires: npm run build, and DATABASE_URL / REDIS_URL pointing at live services.
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, '..');

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', Y = '\x1b[33m', O = '\x1b[0m';

const PORT = Number(process.env.E2E_PORT ?? 4055);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;

const ADMIN_EMAIL = 'e2e-admin@karahoca.local';
const ADMIN_PASSWORD = 'E2eAdminPassword!2026';

// -----------------------------------------------------------------------------
// Tiny assertion framework
// -----------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];

function group(name) { console.log(`\n${B}${name}${O}`); }

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ${G}PASS${O}  ${name}`); }
  else {
    failed++; failures.push(name);
    console.log(`  ${R}FAIL${O}  ${name}`);
    if (detail !== undefined) console.log(`        ${D}${detail}${O}`);
  }
}

const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const near = (name, actual, low, high) =>
  check(name, typeof actual === 'number' && actual >= low && actual <= high,
        `expected ${low}..${high}, got ${actual}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Signed driver requests — mirrors the Android SigningInterceptor exactly.
// -----------------------------------------------------------------------------
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The signature covers the UNCOMPRESSED JSON. gzip is applied afterwards and is
 * a pure transport concern (see AppModule.okHttpClient ordering note). If this
 * ever has to sign the compressed bytes instead, the Android client and this
 * test must change together.
 */
function signedFetch(path, { token, ingestKey, body, gzip = false, clockOffsetSec = 0, nonce, tamper }) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const ts = String(Math.floor(Date.now() / 1000) + clockOffsetSec);
  const n = nonce ?? randomBytes(16).toString('hex');
  let signature = createHmac('sha256', ingestKey)
    .update(`${ts}.${n}.${sha256hex(raw)}`)
    .digest('hex');
  if (tamper) signature = signature.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-KH-Timestamp': ts,
    'X-KH-Nonce': n,
    'X-KH-Signature': signature,
  };

  let payload = raw;
  if (gzip) { payload = gzipSync(raw); headers['Content-Encoding'] = 'gzip'; }

  return fetch(`${API}${path}`, {
    method: 'POST', headers, body: payload, signal: AbortSignal.timeout(30_000),
  });
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// -----------------------------------------------------------------------------
// Point factory
// -----------------------------------------------------------------------------
let seq = 0;
const ulid = () => `01JT${randomBytes(11).toString('hex').toUpperCase().slice(0, 22)}`;

function point(atMs, lat, lon, extra = {}) {
  return {
    id: ulid(),
    recordedAt: atMs,
    lat, lon,
    accuracy: 6.2,
    speed: 18.5,
    bearing: 143.2,
    altitude: 112,
    elapsedRealtimeNs: atMs * 1e6,
    batteryPct: 74,
    isCharging: true,
    isMock: false,
    satellites: 11,
    provider: 'fused',
    networkType: 'cellular',
    seq: ++seq,
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// Server lifecycle
// -----------------------------------------------------------------------------
let server = null;
const serverLog = [];

async function startServer() {
  const entry = join(API_ROOT, 'dist', 'main.js');
  if (!existsSync(entry)) {
    console.error(`${R}dist/main.js not found — run "npm run build" first.${O}`);
    process.exit(2);
  }

  server = spawn(process.execPath, [entry], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      API_PREFIX: 'api/v1',
      PUBLIC_API_URL: BASE,
      CORS_ORIGINS: 'http://localhost:3000',
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      JWT_USER_SECRET: randomBytes(48).toString('base64'),
      JWT_DRIVER_SECRET: randomBytes(48).toString('base64'),
      INGEST_KEY_SECRET: randomBytes(48).toString('base64'),
      INGEST_REQUIRE_HMAC: 'true',
      ADMIN_EMAIL, ADMIN_PASSWORD,
      // Make the coalesced fleet frame land fast enough to assert on.
      REALTIME_FLEET_THROTTLE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = (chunk) => { serverLog.push(chunk.toString()); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) break;
    await sleep(500);
  }
  console.error(`${R}Server failed to become healthy.${O}\n${serverLog.join('')}`);
  process.exit(2);
}

function stopServer() {
  if (server && server.exitCode === null) server.kill('SIGTERM');
}

// -----------------------------------------------------------------------------
// Socket.IO event collector
// -----------------------------------------------------------------------------
function collector(socket, ...events) {
  const seen = [];
  for (const name of events) socket.on(name, (payload) => seen.push({ name, payload }));
  return {
    seen,
    async wait(name, predicate = () => true, ms = 6000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = seen.find((e) => e.name === name && predicate(e.payload));
        if (hit) return hit.payload;
        await sleep(50);
      }
      return null;
    },
  };
}

// =============================================================================
// The run
// =============================================================================
async function main() {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    console.error('DATABASE_URL and REDIS_URL must be set.');
    process.exit(2);
  }

  // A hung await must fail loudly rather than look like a slow test. Every
  // individual wait already has a deadline; this is the backstop.
  const watchdog = setTimeout(() => {
    console.error(`\n${R}WATCHDOG: e2e exceeded 300s — aborting.${O}`);
    console.error(serverLog.join('').split('\n').slice(-30).join('\n'));
    stopServer();
    process.exit(3);
  }, 300_000);
  watchdog.unref?.();

  console.log(`${D}starting server on ${BASE}…${O}`);
  await startServer();

  const stamp = Date.now();
  let adminToken, sessionId, claimCode, driver, socket, events;

  // ---------------------------------------------------------------------------
  group('health');
  {
    const h = await api('/health');
    eq('GET /health is 200', h.status, 200);
    eq('reports ok', h.body?.status, 'ok');

    const ready = await api('/health/ready');
    eq('readiness passes with live deps', ready.status, 200);
    eq('database reachable', ready.body?.database?.ok, true);
    eq('redis reachable', ready.body?.redis?.ok, true);
  }

  // ---------------------------------------------------------------------------
  group('dispatcher auth');
  {
    const bad = await api('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: 'wrong-password-x' } });
    eq('wrong password is rejected', bad.status, 401);
    eq('error code is stable', bad.body?.error?.code, 'INVALID_CREDENTIALS');

    const ok = await api('/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    eq('bootstrapped admin can sign in', ok.status, 200);
    check('access token issued', typeof ok.body?.accessToken === 'string');
    eq('role is ADMIN', ok.body?.user?.role, 'ADMIN');
    adminToken = ok.body.accessToken;

    const unauth = await api('/sessions');
    eq('protected route rejects anonymous', unauth.status, 401);

    const me = await api('/auth/me', { token: adminToken });
    eq('/auth/me works with the token', me.status, 200);
  }

  // ---------------------------------------------------------------------------
  group('catalog + session creation');
  let orderId, carrierId;
  {
    const customer = await api('/customers', {
      method: 'POST', token: adminToken,
      body: { code: `E2E-C-${stamp}`, name: 'E2E Alıcı A.Ş.', city: 'İzmit', lat: 40.7654, lon: 29.9187 },
    });
    eq('create customer', customer.status, 201);

    const companies = await api('/shipping-companies', { token: adminToken });
    eq('list carriers', companies.status, 200);
    check('at least one carrier seeded', Array.isArray(companies.body) && companies.body.length > 0);
    carrierId = companies.body[0].id;

    const order = await api('/orders', {
      method: 'POST', token: adminToken,
      body: {
        orderNumber: `E2E-SO-${stamp}`,
        customerId: customer.body.id,
        destinationLabel: 'Merkez Depo',
        destinationLat: 40.7754, destinationLon: 29.9187,
        destinationRadiusM: 300,
        cargoSummary: '22 pal. KaraFresh 5 L',
      },
    });
    eq('create order', order.status, 201);
    orderId = order.body.id;

    const session = await api('/sessions', {
      method: 'POST', token: adminToken,
      body: { orderId, shippingCompanyId: carrierId, driverName: 'Mehmet Kaplan', vehiclePlate: '34 ABC 123', pingIntervalSec: 10 },
    });
    eq('create tracking session', session.status, 201);
    sessionId = session.body.session_id ?? session.body.sessionId;
    claimCode = session.body?.handoff?.code;
    check('claim code issued', typeof claimCode === 'string' && claimCode.length === 8, claimCode);
    check('QR data URL generated', String(session.body?.handoff?.qrDataUrl ?? '').startsWith('data:image/png;base64,'));
    eq('deep link uses the custom scheme', session.body?.handoff?.deepLink, `karahoca://track?c=${claimCode}`);
    eq('status is ASSIGNED', session.body?.status, 'ASSIGNED');

    // The Sessions list must speak the same camelCase the dashboard reads.
    // /sessions used to `SELECT f.*` from a snake_case view while
    // /tracking/live aliased by hand, so the list page rendered blank columns
    // and linked to /sessions/undefined.
    const listed = await api('/sessions?status=ASSIGNED&limit=5', { token: adminToken });
    eq('sessions list responds', listed.status, 200);
    const row = listed.body?.items?.find((s) => s.sessionId === sessionId);
    check('list row is addressable by sessionId', row !== undefined);
    eq('list exposes orderNumber, not order_number', row?.orderNumber, `E2E-SO-${stamp}`);
    check('list exposes customerName', typeof row?.customerName === 'string' && row.customerName.length > 0);
    check('list exposes carrierName', typeof row?.carrierName === 'string' && row.carrierName.length > 0);
    check('list exposes no snake_case leakage',
          row !== undefined && !Object.keys(row).some((k) => k.includes('_')),
          Object.keys(row ?? {}).filter((k) => k.includes('_')).join(', '));

    const dupe = await api('/sessions', {
      method: 'POST', token: adminToken,
      body: { orderId, shippingCompanyId: carrierId },
    });
    eq('second live session for the same order is refused', dupe.status, 409);
    eq('conflict code is stable', dupe.body?.error?.code, 'SESSION_ALREADY_OPEN');

    const landing = await fetch(`${BASE}/t/${claimCode}`);
    eq('QR landing page renders', landing.status, 200);
    const html = await landing.text();
    check('landing page carries the intent:// fallback', html.includes('intent://track?c='));
  }

  // ---------------------------------------------------------------------------
  group('realtime subscription');
  {
    socket = io(BASE, { path: '/realtime', transports: ['websocket'], auth: { token: adminToken } });
    const connected = await new Promise((resolve) => {
      socket.once('connect', () => resolve(true));
      socket.once('connect_error', () => resolve(false));
      setTimeout(() => resolve(false), 8000);
    });
    eq('dispatcher socket connects', connected, true);

    events = collector(
      socket,
      'position:update', 'route:backfill', 'session:state', 'session:event',
      'ingest:stats', 'fleet:positions', 'fleet:snapshot', 'subscribed',
    );

    // NOTE: emit WITHOUT an ack callback. The gateway handlers return a
    // `{ event, data }` WsResponse, which Nest *emits as an event* rather than
    // passing to an acknowledgement callback — so `emit(..., cb)` would wait
    // forever. We confirm the subscription by waiting for the emitted event.
    socket.emit('subscribe:session', { sessionId });
    socket.emit('subscribe:fleet', {});

    const subscribed = await events.wait('subscribed', (p) => String(p?.room ?? '').includes(sessionId));
    check('session subscription acknowledged', subscribed !== null);
    const snapshot = await events.wait('fleet:snapshot');
    check('fleet snapshot delivered on subscribe', snapshot !== null);

    // The transport connects first and the gateway disconnects in
    // handleConnection, so the client always sees `connect` before
    // `disconnect`. Asserting on `connect` would be testing the transport, not
    // the auth guard — wait for the disconnect (or the error frame) instead.
    const anon = io(BASE, {
      path: '/realtime', transports: ['websocket'], auth: {}, reconnection: false,
    });
    const rejected = await new Promise((resolve) => {
      anon.once('disconnect', () => resolve(true));
      anon.once('error:auth', () => resolve(true));
      anon.once('connect_error', () => resolve(true));
      setTimeout(() => resolve(false), 8000);
    });
    eq('unauthenticated socket is refused', rejected, true);
    anon.close();
  }

  // ---------------------------------------------------------------------------
  group('driver claim');
  {
    const badCode = await api('/driver/claim', {
      method: 'POST',
      body: { code: 'ZZZZ9999', device: { deviceId: 'e2e-device-1' } },
    });
    eq('unknown claim code is refused', badCode.status, 404);
    eq('claim error code is stable', badCode.body?.error?.code, 'CODE_INVALID');

    // Lower-case with a separator and an ambiguous glyph — the normaliser must
    // resolve it the same way the SQL side does.
    const typed = `${claimCode.slice(0, 4)}-${claimCode.slice(4)}`.toLowerCase();
    const claim = await api('/driver/claim', {
      method: 'POST',
      body: {
        code: typed,
        device: {
          deviceId: 'e2e-device-1', manufacturer: 'Xiaomi', model: 'Redmi Note 12',
          osVersion: 'Android 14', sdkInt: 34, appVersion: '1.0.0', appBuild: 10,
          batteryOptimisationIgnored: true, hasBackgroundLocation: true, hasExactAlarm: true,
        },
      },
    });
    eq('driver claims with a normalised code', claim.status, 200);
    if (claim.status !== 200) {
      // Everything downstream is meaningless without credentials; fail loudly
      // rather than cascading a dozen misleading errors.
      console.error(`\n${R}Claim failed — cannot continue.${O}\n${JSON.stringify(claim.body, null, 2)}`);
      socket?.close(); stopServer();
      console.log(`\n${B}${passed} passed, ${R}${failed + 1} failed${O}`);
      process.exit(1);
    }
    check('access token issued', typeof claim.body?.accessToken === 'string');
    check('refresh token issued', typeof claim.body?.refreshToken === 'string');
    check('ingest key issued', typeof claim.body?.ingestKey === 'string');
    eq('ingest key is 32 bytes', Buffer.from(claim.body.ingestKey, 'base64').length, 32);
    eq('shipment details handed to the driver', claim.body?.shipment?.orderNumber, `E2E-SO-${stamp}`);
    eq('policy handed to the driver', claim.body?.policy?.pingIntervalSec, 10);
    check('serverTime returned for clock correction', Number.isFinite(claim.body?.serverTime));

    driver = { token: claim.body.accessToken, ingestKey: Buffer.from(claim.body.ingestKey, 'base64'), refresh: claim.body.refreshToken };

    const reuse = await api('/driver/claim', {
      method: 'POST', body: { code: claimCode, device: { deviceId: 'e2e-device-2' } },
    });
    eq('claim code is single-use', reuse.status, 404);

    const state = await events.wait('session:state', (p) => p.status === 'CLAIMED');
    check('dispatcher sees CLAIMED over the socket', state !== null);
  }

  // ---------------------------------------------------------------------------
  group('telemetry ingest');
  const t0 = Date.now() - 5 * 60 * 1000;
  {
    const ping = await signedFetch('/ingest/ping', {
      ...driver,
      body: { batchId: randomUUID(), point: point(t0, 40.7654, 29.9187) },
    });
    const pingBody = await ping.json();
    eq('signed single ping accepted', ping.status, 202);
    eq('one point accepted', pingBody.accepted, 1);
    eq('session flipped to ACTIVE', pingBody.sessionStatus, 'ACTIVE');
    eq('policy echoed back', pingBody.policy?.pingIntervalSec, 10);
    eq('nextAction instructs CONTINUE', pingBody.nextAction, 'CONTINUE');
    check('serverTime echoed for clock correction', Number.isFinite(pingBody.serverTime));

    const moved = await events.wait('position:update', (p) => p.sessionId === sessionId);
    check('position:update reaches the dispatcher', moved !== null);
    near('broadcast latitude matches', moved?.lat, 40.7653, 40.7655);

    // --- THE gzip/HMAC contract -------------------------------------------
    // Signature over the UNCOMPRESSED JSON, body sent gzipped.
    const batchPoints = Array.from({ length: 60 }, (_, i) =>
      point(t0 + (i + 1) * 10_000, 40.7654 + i * 0.0004, 29.9187));
    const batchBody = { batchId: randomUUID(), offline: false, bufferRemaining: 0, points: batchPoints };

    const gz = await signedFetch('/ingest/batch', { ...driver, body: batchBody, gzip: true });
    const gzBody = await gz.json();
    eq('gzipped batch accepted (signature covers uncompressed JSON)', gz.status, 202);
    eq('all 60 points accepted', gzBody.accepted, 60);
    eq('no rejects', gzBody.rejected, 0);
    near('distance accumulated', gzBody.distanceM, 2400, 2800);

    // --- Idempotent replay -------------------------------------------------
    const replay = await signedFetch('/ingest/batch', { ...driver, body: batchBody, gzip: true });
    const replayBody = await replay.json();
    eq('replay accepted at HTTP level', replay.status, 202);
    eq('replay stores nothing new', replayBody.accepted, 0);
    eq('replay reports duplicates', replayBody.duplicates, 60);
    eq('replay does not inflate the total', replayBody.pointsTotal, 61);

    // --- Offline backlog ---------------------------------------------------
    // Recorded an hour before the live run and deliberately separated from it,
    // so the route also contains a genuine coverage gap for /gaps to find.
    const headBefore = replayBody.pointsTotal;
    const backlog = Array.from({ length: 25 }, (_, i) =>
      point(t0 - 3_600_000 + i * 10_000, 40.7600 + i * 0.0002, 29.9187));
    const back = await signedFetch('/ingest/batch', {
      ...driver,
      body: { batchId: randomUUID(), offline: true, bufferRemaining: 0, points: backlog },
      gzip: true,
    });
    const backBody = await back.json();
    eq('offline backlog accepted', backBody.accepted, 25);
    eq('backlog counts toward the total', backBody.pointsTotal, headBefore + 25);

    const bf = await events.wait('route:backfill', (p) => p.sessionId === sessionId && p.count === 25);
    check('route:backfill emitted for the backlog', bf !== null);
    check('backfill carries geometry to splice', Array.isArray(bf?.points) && bf.points.length === 25);

    const live = await api(`/tracking/live`, { token: adminToken });
    const mine = live.body?.positions?.find((p) => p.sessionId === sessionId);
    check('session appears on the live fleet', mine !== undefined);
    near('live marker did NOT rewind to the backlog', mine?.lat, 40.78, 40.79);
    eq('signal state is LIVE', mine?.signalState, 'LIVE');
  }

  // ---------------------------------------------------------------------------
  group('ingest security');
  {
    const noToken = await fetch(`${API}/ingest/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ point: point(Date.now(), 40.7, 29.9) }),
    });
    eq('missing bearer token is refused', noToken.status, 401);

    const unsigned = await fetch(`${API}/ingest/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${driver.token}` },
      body: JSON.stringify({ point: point(Date.now(), 40.7, 29.9) }),
    });
    eq('unsigned request is refused', unsigned.status, 401);
    eq('missing-signature code is stable', (await unsigned.json())?.error?.code, 'MISSING_SIGNATURE');

    const tampered = await signedFetch('/ingest/ping', {
      ...driver, body: { point: point(Date.now(), 40.7, 29.9) }, tamper: true,
    });
    eq('bad signature is refused', tampered.status, 401);
    eq('bad-signature code is stable', (await tampered.json())?.error?.code, 'BAD_SIGNATURE');

    const nonce = randomBytes(16).toString('hex');
    const first = await signedFetch('/ingest/ping', {
      ...driver, nonce, body: { point: point(Date.now() - 1000, 40.7654, 29.9187) },
    });
    eq('first use of a nonce succeeds', first.status, 202);
    const second = await signedFetch('/ingest/ping', {
      ...driver, nonce, body: { point: point(Date.now() - 1000, 40.7654, 29.9187) },
    });
    eq('replayed nonce is refused', second.status, 401);
    eq('replay code is stable', (await second.json())?.error?.code, 'REPLAY_DETECTED');

    const skewed = await signedFetch('/ingest/ping', {
      ...driver, clockOffsetSec: 4000, body: { point: point(Date.now(), 40.7654, 29.9187) },
    });
    eq('excessive clock skew is refused', skewed.status, 401);
    const skewBody = await skewed.json();
    eq('skew code is stable', skewBody?.error?.code, 'CLOCK_SKEW');
    check('skew response carries serverTime so the device can self-correct',
          Number.isFinite(skewBody?.serverTime));

    // A device whose clock is wrong but which corrects using serverTime must work.
    const corrected = await signedFetch('/ingest/ping', {
      ...driver, clockOffsetSec: 0, body: { point: point(Date.now() - 2000, 40.7654, 29.9187) },
    });
    eq('clock-corrected request succeeds', corrected.status, 202);
  }

  // ---------------------------------------------------------------------------
  group('driver token refresh');
  {
    const refreshed = await api('/driver/token/refresh', {
      method: 'POST', body: { refreshToken: driver.refresh, deviceId: 'e2e-device-1' },
    });
    eq('refresh returns a new access token', refreshed.status, 200);
    check('token differs from the original', refreshed.body?.accessToken !== driver.token);

    const withNew = await signedFetch('/ingest/ping', {
      token: refreshed.body.accessToken, ingestKey: driver.ingestKey,
      body: { point: point(Date.now() - 1500, 40.7654, 29.9187) },
    });
    eq('refreshed token works for ingest', withNew.status, 202);

    const wrongDevice = await api('/driver/token/refresh', {
      method: 'POST', body: { refreshToken: driver.refresh, deviceId: 'someone-elses-device' },
    });
    eq('refresh bound to the device', wrongDevice.status, 401);
    driver.token = refreshed.body.accessToken;
  }

  // ---------------------------------------------------------------------------
  group('history + reporting');
  {
    const route = await api(`/tracking/sessions/${sessionId}/route`, { token: adminToken });
    eq('route endpoint responds', route.status, 200);
    eq('route is a FeatureCollection', route.body?.type, 'FeatureCollection');
    check('route has geometry', route.body?.features?.[0]?.geometry?.type === 'LineString');
    check('route point count reflects stored points', route.body?.pointCount >= 86, route.body?.pointCount);

    const playback = await api(`/tracking/sessions/${sessionId}/playback?maxPoints=20`, { token: adminToken });
    eq('playback responds', playback.status, 200);
    check('playback decimates to the cap', playback.body?.returned <= 21, playback.body?.returned);
    check('playback returns positional tuples', Array.isArray(playback.body?.points?.[0]));

    const gaps = await api(`/tracking/sessions/${sessionId}/gaps?minGapSec=120`, { token: adminToken });
    eq('gaps endpoint responds', gaps.status, 200);
    check('the dead-zone gap is detected', Array.isArray(gaps.body) && gaps.body.length >= 1,
          JSON.stringify(gaps.body?.slice(0, 1)));
    // ~55 minutes between the end of the backlog and the start of the live run.
    near('gap duration is measured', gaps.body?.[0]?.durationSec, 3000, 3400);
    check('gap reports how far the truck moved while dark',
          Number(gaps.body?.[0]?.straightLineM) > 0, gaps.body?.[0]?.straightLineM);

    const detail = await api(`/sessions/${sessionId}`, { token: adminToken });
    eq('session detail responds', detail.status, 200);
    eq('device health surfaced to the dispatcher', detail.body?.device?.battery_optimisation_ignored, true);
    check('event timeline populated', Array.isArray(detail.body?.events) && detail.body.events.length > 0);
    check('offline sync recorded', detail.body?.offlineBatches >= 1, detail.body?.offlineBatches);

    const exported = await fetch(`${API}/tracking/sessions/${sessionId}/export.ndjson`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    eq('NDJSON export streams', exported.status, 200);
    const lines = (await exported.text()).trim().split('\n');
    check('export contains one JSON object per point', lines.length >= 86, `${lines.length} lines`);
    check('export lines parse', (() => { try { JSON.parse(lines[0]); return true; } catch { return false; } })());
  }

  // ---------------------------------------------------------------------------
  group('session lifecycle');
  {
    const completed = await api(`/sessions/${sessionId}/complete`, {
      method: 'POST', token: adminToken, body: { reason: 'delivered' },
    });
    eq('dispatcher completes the session', completed.status, 200);

    const order = await api(`/orders/${orderId}`, { token: adminToken });
    eq('order marked DELIVERED', order.body?.status, 'DELIVERED');

    // Revocation must be effective immediately through the Redis auth cache.
    const afterClose = await signedFetch('/ingest/ping', {
      ...driver, body: { point: point(Date.now(), 40.7654, 29.9187) },
    });
    eq('closed session refuses further points', afterClose.status, 403);
    eq('closure code is stable', (await afterClose.json())?.error?.code, 'SESSION_CLOSED');
  }

  // ---------------------------------------------------------------------------
  socket?.close();
  stopServer();

  console.log('');
  if (failed === 0) {
    console.log(`${B}${G}${passed} assertions passed.${O}`);
  } else {
    console.log(`${B}${passed} passed, ${R}${failed} failed${O}`);
    console.log(`${Y}failing:${O} ${failures.join(', ')}`);
    const tail = serverLog.join('').split('\n').slice(-25).join('\n');
    console.log(`\n${D}--- server log tail ---\n${tail}${O}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

process.on('unhandledRejection', (err) => {
  console.error(`${R}unhandled rejection:${O}`, err);
  stopServer();
  process.exit(2);
});

main().catch((err) => {
  console.error(`${R}e2e crashed:${O}`, err);
  console.error(serverLog.join('').split('\n').slice(-25).join('\n'));
  stopServer();
  process.exit(2);
});
