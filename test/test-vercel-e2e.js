const BASE = 'https://chole-bhature.vercel.app';
const TS = Date.now().toString(36);
const TEST_ID = 'e2e' + TS;

const REPOS = [
  'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/PirateZoro9/asura-providers/refs/heads/main/manifest.json'
];

async function get(url, timeoutMs = 150000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (e) {
    clearTimeout(t);
    throw new Error(url + ' -> ' + e.message);
  }
}

async function post(url, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal
    });
    clearTimeout(t);
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (e) {
    clearTimeout(t);
    throw new Error(url + ' -> ' + e.message);
  }
}

function result(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  return ok;
}

(async () => {
  const passed = { ok: 0, fail: 0 };
  const R = (name, ok, d) => { ok ? passed.ok++ : passed.fail++; result(name, ok, d); return ok; };

  console.log('=== E2E on ' + BASE + ' ===');
  console.log('test configId:', TEST_ID, '\n');

  // 1. Deployment is up + manifest valid
  const m = await get(BASE + '/manifest.json', 60000);
  R('deployment reachable, manifest ok', m.status === 200 && m.json && m.json.id, 'status=' + m.status);

  // 2. Save a distinctive config (marker + disabled list + 4 repos)
  const testConfig = {
    urls: REPOS,
    hideDead: false, hideSlow: false, hideCam: false,
    showSeeders: true, deduplicateStreams: true,
    enableDoh: true, dohProvider: 'cloudflare', accessToken: '',
    sortBy: 'speed', sortMode: 'speed',
    prioritizeQuality: false, prioritizeHindi: false,
    preferredLanguages: ['e2e-marker-' + TS],
    disabled: ['Castle', 'Kisskh']
  };
  const s = await post(BASE + '/api/config/save', { configId: TEST_ID, config: testConfig });
  R('config saved (marker=' + TEST_ID + ')', s.status === 200 && s.json && s.json.success === true, 'status=' + s.status);

  // 3. Read it back (same invocation)
  const g1 = await get(BASE + '/api/config/' + TEST_ID, 30000);
  const g1ok = g1.json && g1.json.config && g1.json.config.preferredLanguages &&
               g1.json.config.preferredLanguages[0] === 'e2e-marker-' + TS;
  R('config read back #1 (marker present)', g1ok, g1.json ? JSON.stringify(g1.json.config ? { lang: g1.json.config.preferredLanguages } : null) : 'status=' + g1.status);

  // 4. Fan out requests to spread across function instances
  const fan = await Promise.allSettled(
    [1, 2, 3, 4].map(i => get(BASE + '/manifest.json?probe=' + i, 60000))
  );
  const fansOk = fan.filter(x => x.status === 'fulfilled' && x.value.status === 200).length;
  R('fanned out ' + fansOk + '/4 manifest requests (spins instances)', fansOk >= 2, '');

  // 5. Real stream test: disabled addons must NOT reappear
  const t0 = Date.now();
  const st1 = await get(BASE + '/c/' + TEST_ID + '/stream/movie/tmdb:27205.json', 180000);
  const streams1 = (st1.json && st1.json.streams) || [];
  const el1 = ((Date.now() - t0) / 1000).toFixed(0);
  const castle1 = streams1.filter(s => /castle/i.test(s.name)).length;
  const kiss1 = streams1.filter(s => /kiss/i.test(s.name)).length;
  const torr1 = streams1.filter(s => /torrentio/i.test(s.name)).length;
  R('stream run #1: ' + streams1.length + ' streams, castle=' + castle1 + ', kiss=' + kiss1 + ', torrentio=' + torr1,
    castle1 === 0 && kiss1 === 0 && torr1 > 0, el1 + 's');

  // 6. Config must STILL be intact after the heavy stream request (fresh instance, from Redis)
  const g2 = await get(BASE + '/api/config/' + TEST_ID, 30000);
  const g2ok = g2.json && g2.json.config && g2.json.config.preferredLanguages &&
               g2.json.config.preferredLanguages[0] === 'e2e-marker-' + TS &&
               (g2.json.config.disabled || []).includes('Castle');
  R('config read back #2 after stream (persisted across instances)', g2ok, g2.json && g2.json.config ? 'disabled=' + JSON.stringify(g2.json.config.disabled) : 'status=' + g2.status);

  // 7. Second stream run (another instance) — must behave the SAME
  const t1 = Date.now();
  const st2 = await get(BASE + '/c/' + TEST_ID + '/stream/movie/tmdb:27205.json', 180000);
  const streams2 = (st2.json && st2.json.streams) || [];
  const el2 = ((Date.now() - t1) / 1000).toFixed(0);
  const castle2 = streams2.filter(s => /castle/i.test(s.name)).length;
  const kiss2 = streams2.filter(s => /kiss/i.test(s.name)).length;
  const torr2 = streams2.filter(s => /torrentio/i.test(s.name)).length;
  R('stream run #2: ' + streams2.length + ' streams, castle=' + castle2 + ', kiss=' + kiss2 + ', torrentio=' + torr2,
    castle2 === 0 && kiss2 === 0 && torr2 > 0, el2 + 's');

  // 8. Final config integrity check
  const g3 = await get(BASE + '/api/config/' + TEST_ID, 30000);
  const g3ok = g3.json && g3.json.config && g3.json.config.preferredLanguages &&
               g3.json.config.preferredLanguages[0] === 'e2e-marker-' + TS;
  R('config read back #3 (final integrity)', g3ok, '');

  console.log('\n==========');
  console.log('PASS: ' + passed.ok + '  FAIL: ' + passed.fail);
  console.log('test configId left in Redis for inspection: ' + TEST_ID);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
