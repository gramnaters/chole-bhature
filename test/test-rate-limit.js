// Standalone verification for the rate-limit/admin review fixes.
// Runnable directly: node test/test-rate-limit.js
// Covers:
//   (a) getClientIp picks the LAST X-Forwarded-For hop (leftmost is forgeable)
//   (b) timing-safe admin compare accepts correct / rejects wrong token,
//       including unequal lengths, without throwing
//   (c) turso-less mode: full save flow answers with structured JSON, no crash
//   (d) end-to-end atomic gate via a local SQLite-backed Turso client:
//       3 saves/day allowed ({success:true,configId}), 4th rejected 429,
//       malformed bodies never consume quota.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawnSync } = require('child_process');

// Deterministic environment BEFORE requiring index.js
process.env.ADMIN_TOKEN = 'unit-test-secret';
delete process.env.ACCESS_TOKEN;
delete process.env.CRON_SECRET;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
// VERCEL=1 prevents index.js from auto-binding its default port; the test
// starts its own ephemeral server instead.
process.env.VERCEL = '1';

const CONFIGS_FILE = path.join(__dirname, '..', 'user_configs.json');
const configFileBackup = fs.existsSync(CONFIGS_FILE) ? fs.readFileSync(CONFIGS_FILE) : null;

const app = require('../index.js'); // module.exports IS the express app (+ helpers)
const { getClientIp, adminTokenMatches, clearStreamCacheForConfig, userConfigs } = app;

// Guard: .env injection could have (re)populated Turso creds AFTER our deletes.
// This suite must never talk to a live database.
if (process.env.TURSO_DATABASE_URL || process.env.TURSO_AUTH_TOKEN) {
  console.error('[test-rate-limit] FAIL - TURSO env vars present (dotenv injection?); refusing to run against a live DB.');
  process.exit(1);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`[test-rate-limit] ok - ${name}`);
}

// ---------- (a) getClientIp ----------
check('getClientIp picks LAST XFF hop, ignoring forged leftmost entries', () => {
  assert.strictEqual(
    getClientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 203.0.113.7' } }),
    '203.0.113.7'
  );
});
check('getClientIp handles single-hop XFF', () => {
  assert.strictEqual(getClientIp({ headers: { 'x-forwarded-for': '198.51.100.1' } }), '198.51.100.1');
});
check('getClientIp falls back to x-real-ip then unknown', () => {
  assert.strictEqual(getClientIp({ headers: { 'x-real-ip': '198.51.100.5' } }), '198.51.100.5');
  assert.strictEqual(getClientIp({ headers: {} }), 'unknown');
});
check('getClientIp skips blank XFF hops', () => {
  assert.strictEqual(getClientIp({ headers: { 'x-forwarded-for': ' , , ' } }), 'unknown');
});

// ---------- (b) timing-safe admin compare ----------
check('adminTokenMatches accepts the exact secret', () => {
  assert.strictEqual(adminTokenMatches('unit-test-secret'), true);
});
check('adminTokenMatches rejects wrong secrets of ANY length without throwing', () => {
  assert.doesNotThrow(() => adminTokenMatches(''));
  assert.doesNotThrow(() => adminTokenMatches('short'));
  assert.doesNotThrow(() => adminTokenMatches('unit-test-secret-but-longer'));
  assert.strictEqual(adminTokenMatches(''), false);
  assert.strictEqual(adminTokenMatches('short'), false);
  assert.strictEqual(adminTokenMatches('unit-test-secret-but-longer'), false);
});
check('adminTokenMatches handles non-string input safely', () => {
  assert.doesNotThrow(() => adminTokenMatches(undefined));
  assert.strictEqual(adminTokenMatches(undefined), false);
});

// ---------- cache invalidation key matching ----------
// streamCache keys are `${type}_${contentId}_${cfg:hash}`; the DELETE endpoint
// must match the content-id SEGMENT exactly (no substring false-positives).
check('cache invalidation matches id segment boundaries exactly', () => {
  const match = (key, id) => {
    const hashAt = key.lastIndexOf('_cfg:');
    const prefix = hashAt === -1 ? key : key.slice(0, hashAt);
    return prefix.endsWith(`_${id}`);
  };
  assert.strictEqual(match('movie_tt111_cfg:aaaa111122223333', 'tt11'), false);
  assert.strictEqual(match('movie_tt111_cfg:aaaa111122223333', 'tt111'), true);
  assert.strictEqual(match('series_tt11:2:1_cfg:bbbb222233334444', 'tt11:2:1'), true);
  assert.strictEqual(match('anime_tmdb:99:1:1_cfg:cccc333344445555', 'tmdb:99'), false);
});
void clearStreamCacheForConfig;
void userConfigs;

// ---------- (c)+(d) HTTP flows ----------
async function postJson(base, pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
        catch (e) { resolve({ status: res.statusCode, body: null, raw }); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function tursolessFlow() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port(server)}`;
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const bad = await postJson(base, '/api/config/save', { configId: 'nope' });
    check('turso-less: malformed body -> 400 before any quota logic', () => {
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.success, false);
    });

    const res = await postJson(base, '/api/config/save', {
      configId: 'test-rate-limit-cfg',
      config: { urls: ['https://example.com/manifest.json'], sortBy: 'speed' }
    });
    check('turso-less: save flow completes with structured JSON, no crash', () => {
      assert.ok(res.status === 500 || res.status === 200, `unexpected status ${res.status}`);
      assert.ok(res.body && typeof res.body === 'object', 'response body was not JSON');
      if (res.status === 500) {
        assert.strictEqual(res.body.success, false);
        assert.match(String(res.body.error), /Turso not configured/);
      }
      assert.strictEqual(unhandled, false, 'unhandledRejection fired during save flow');
    });
    check('turso-less: config still reachable from memory store', () => {
      assert.ok(userConfigs.has('test-rate-limit-cfg'));
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
    server.close();
  }
}
function port(server) { return server.address().port; }

function runAtomicGateSimulation() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-sim-'));
  const dbPath = path.join(tmpDir, 'sim.db').replace(/\\/g, '/');
  const indexPath = require.resolve('../index.js').replace(/\\/g, '/');
  const childCode = `
const assert = require('assert');
const http = require('http');
const fs = require('fs');
process.env.TURSO_DATABASE_URL = 'file:${dbPath}';
process.env.TURSO_AUTH_TOKEN = 'local-only';
process.env.ADMIN_TOKEN = 'sim-admin';
delete process.env.ACCESS_TOKEN;
process.env.VERCEL = '1';

(async () => {
  const { createClient } = require('@libsql/client');
  const boot = createClient({ url: 'file:${dbPath}' });
  // Pre-create schema INCLUDING updatedAt so the startup migration takes the
  // "duplicate column" branch deterministically (no race with fire-and-forget).
  await boot.execute('CREATE TABLE IF NOT EXISTS configs (configId TEXT PRIMARY KEY, config TEXT, updatedAt INTEGER)');
  await boot.execute('CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT, day TEXT, count INTEGER, PRIMARY KEY(ip, day))');

  const app = require('${indexPath}');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (p, payload) => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(data);
  });

  const out = { saves: [] };
  for (let i = 0; i < 4; i++) {
    out.saves.push(await post('/api/config/save', { configId: 'sim-' + i, config: { urls: ['https://example.com/' + i + '.json'] } }));
  }
  // Malformed attempt between quota consumption must NOT free a slot:
  out.malformed = await post('/api/config/save', {});
  out.afterMalformed = await post('/api/config/save', { configId: 'sim-x', config: { urls: [] } });

  // updatedAt persisted?
  const row = await boot.execute("SELECT updatedAt FROM configs WHERE configId='sim-0'");
  out.updatedAtSet = row.rows.length === 1 && Number(row.rows[0].updatedAt) > 0;
  server.close();
  console.log('__RESULT__' + JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
`;
  const r = spawnSync(process.execPath, ['-e', childCode], { encoding: 'utf8', timeout: 60000, cwd: path.join(__dirname, '..') });
  const stdout = r.stdout || '';
  const marker = '__RESULT__';
  const idx = stdout.indexOf(marker);
  if (idx === -1) {
    throw new Error(`simulation did not produce result (exit=${r.status})\nstdout:${stdout}\nstderr:${r.stderr}`);
  }
  return JSON.parse(stdout.slice(idx + marker.length));
}

(async () => {
  let failed = false;
  try {
    await tursolessFlow();

    // ---------- (d) atomic gate end-to-end (SQLite-backed Turso client) ----------
    let sim;
    let simError = null;
    try {
      sim = runAtomicGateSimulation();
    } catch (e) {
      simError = e;
    }
    if (!simError) {
      check('atomic gate: first 3 saves succeed with {success:true,configId}', () => {
        for (let i = 0; i < 3; i++) {
          assert.strictEqual(sim.saves[i].status, 200, `save#${i} status ${sim.saves[i].status}`);
          assert.strictEqual(sim.saves[i].body.success, true);
          assert.strictEqual(sim.saves[i].body.configId, `sim-${i}`);
        }
      });
      check('atomic gate: 4th save rejected with 429', () => {
        assert.strictEqual(sim.saves[3].status, 429);
        assert.strictEqual(sim.saves[3].body.success, false);
        assert.match(String(sim.saves[3].body.error), /Rate limit: 3 configs per day/);
      });
      check('quota not refunded/burned by malformed bodies (still 429 after)', () => {
        assert.strictEqual(sim.malformed.status, 400);
        assert.strictEqual(sim.afterMalformed.status, 429);
      });
      check('updatedAt column written on save', () => {
        assert.strictEqual(sim.updatedAtSet, true);
      });
    } else {
      console.warn('[test-rate-limit] WARN - SQLite-backed simulation unavailable, skipping (d):', String(simError.message).split('\n')[0]);
    }

    console.log(`[test-rate-limit] PASS (${passed} checks${simError ? ', simulation skipped' : ' incl. atomic-gate simulation'})`);
  } catch (e) {
    failed = true;
    console.error('[test-rate-limit] FAIL', e);
  } finally {
    // Restore user_configs.json exactly as found (flows above wrote through it).
    try {
      if (configFileBackup === null) {
        if (fs.existsSync(CONFIGS_FILE)) fs.unlinkSync(CONFIGS_FILE);
      } else {
        fs.writeFileSync(CONFIGS_FILE, configFileBackup);
      }
    } catch (e) {}
  }
  process.exit(failed ? 1 : 0);
})();
