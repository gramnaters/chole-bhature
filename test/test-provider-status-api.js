// Regression test for the provider status API surface.
// Run: node test/test-provider-status-api.js
// No new deps: uses global fetch (Node 18+) and plain asserts.

process.env.PORT = process.env.PORT || '3779';
const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-cron-secret-' + Date.now();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  ok - ' + msg);
  } else {
    failures++;
    console.error('  FAIL - ' + msg);
  }
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body };
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/provider-status');
      if (r && r.status) return true;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// Abrupt process.exit() while libuv handles are mid-close trips a Windows
// uv assert (node >=20 win32). Close the HTTP server and give the loop a beat.
const net = require('net');
function gracefulExit(code) {
  try {
    for (const h of process._getActiveHandles()) {
      if (h instanceof net.Server) h.close(() => {});
    }
  } catch (e) {}
  setTimeout(() => process.exit(code), 500);
}

async function main() {
  process.env.CRON_SECRET = SECRET;
  require('../index.js');

  assert(await waitForServer(), 'server listening on port ' + PORT);

  // 1. saveProviderStatus -> getProviderStatus roundtrip
  const { saveProviderStatus, getProviderStatus } = require('../index.js');
  const stamp = Date.now();
  await saveProviderStatus('ApiTestProvider', {
    up: true,
    streamsFound: 7,
    latencyMs: 1234,
    titles: ['Oppenheimer', 'Game of Thrones'],
    updatedAt: stamp,
  });
  const got = getProviderStatus('ApiTestProvider');
  assert(!!got, 'roundtrip: saved entry is returned by getProviderStatus');
  assert(got.up === true && got.streamsFound === 7 && got.latencyMs === 1234, 'roundtrip: scalar fields intact');
  assert(Array.isArray(got.titles) && got.titles.length === 2, 'roundtrip: titles array intact');
  assert(got.updatedAt === stamp, 'roundtrip: updatedAt intact');

  // 2. GET /api/provider-status -> 200 + array shape
  const list = await req('/api/provider-status');
  assert(list.status === 200, 'GET /api/provider-status -> 200');
  assert(Array.isArray(list.body), 'response body is an array');
  const row = Array.isArray(list.body) ? list.body.find((x) => x && x.name === 'ApiTestProvider') : null;
  assert(!!row, 'saved provider appears in /api/provider-status');
  const requiredKeys = ['name', 'up', 'streamsFound', 'latencyMs', 'titles', 'updatedAt'];
  const keysOk = !!row && requiredKeys.every((k) => Object.prototype.hasOwnProperty.call(row, k));
  assert(keysOk, 'rows carry {' + requiredKeys.join(',') + '}');
  const sortedOk = Array.isArray(list.body) &&
    list.body.every((x, i, a) => i === 0 || String(a[i - 1].name).localeCompare(String(x.name)) <= 0);
  assert(sortedOk, 'rows sorted by name');

  // 3. Cron endpoint auth hardening
  const noSecret = await req('/api/cron/provider-status');
  assert(noSecret.status === 401 || noSecret.status === 403, 'cron without secret -> 401/403');

  const wrongHeader = await req('/api/cron/provider-status', { headers: { 'X-Cron-Secret': 'wrong-secret' } });
  assert(wrongHeader.status === 401 || wrongHeader.status === 403, 'cron with wrong X-Cron-Secret -> 401/403');

  const wrongBearer = await req('/api/cron/provider-status', { headers: { Authorization: 'Bearer nope' } });
  assert(wrongBearer.status === 401 || wrongBearer.status === 403, 'cron with wrong Bearer -> 401/403');

  const queryPath = await req('/api/cron/provider-status?secret=' + encodeURIComponent(SECRET));
  assert(queryPath.status === 401 || queryPath.status === 403, '?secret= query-param path removed -> 401/403');

  // Short-circuit manifest loading so authorized runs return fast/offline-safe
  const providerLoader = require('../providerLoader');
  const origLoadProviders = providerLoader.loadProviders;
  providerLoader.loadProviders = async () => [];

  const withHeader = await req('/api/cron/provider-status', { headers: { 'X-Cron-Secret': SECRET } });
  assert(withHeader.status === 200 && withHeader.body && withHeader.body.ok === true,
    'cron with correct X-Cron-Secret -> 200 {ok:true}');

  const withBearer = await req('/api/cron/provider-status', { headers: { Authorization: 'Bearer ' + SECRET } });
  assert(withBearer.status === 200 && withBearer.body && withBearer.body.ok === true,
    'cron with correct Authorization Bearer -> 200 {ok:true}');

  providerLoader.loadProviders = origLoadProviders;

  if (failures > 0) {
    console.error('[test-provider-status-api] FAIL (' + failures + ' assertion(s))');
    gracefulExit(1);
    return;
  }
  console.log('[test-provider-status-api] PASS');
  gracefulExit(0);
}

main().catch((e) => {
  console.error('[test-provider-status-api] FAIL', e);
  gracefulExit(1);
});
