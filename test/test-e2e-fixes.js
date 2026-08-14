const BASE = 'http://localhost:7000';

async function post(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return res.json();
}
async function get(url, timeoutMs = 150000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, { signal: ctrl.signal });
    clearTimeout(t);
    return await res.json();
  } finally { clearTimeout(t); }
}

(async () => {
  console.log('=== TEST 1: series tmdb:60735:1:1 (was 0 streams before fix) ===');
  const t0 = Date.now();
  const r1 = await get('/c/benchtest1/stream/series/tmdb:60735:1:1.json', 100000);
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s, streams: ${(r1.streams || []).length}`);
  console.log((r1.streams || []).length > 0 ? 'PASS: series tmdb: resolves' : 'FAIL: series tmdb: still empty');

  console.log('\n=== TEST 2: disabled=[Castle, Kisskh] (no emoji) must kill all variants ===');
  const cfg = {
    configId: 'benchtest5',
    config: {
      urls: [
        'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json',
        'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json',
        'https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json',
        'https://raw.githubusercontent.com/PirateZoro9/asura-providers/refs/heads/main/manifest.json'
      ],
      hideDead: false, hideSlow: false, hideCam: false, showSeeders: true, deduplicateStreams: true,
      enableDoh: true, dohProvider: 'cloudflare', accessToken: '', sortBy: 'speed', sortMode: 'speed',
      prioritizeQuality: false, prioritizeHindi: false, preferredLanguages: [],
      disabled: ['Castle', 'Kisskh']
    }
  };
  await post('/api/config/save', cfg);
  console.log('saved config benchtest5');

  const t1 = Date.now();
  const r2 = await get('/c/benchtest5/stream/movie/tmdb:27205.json', 300000);
  const streams = r2.streams || [];
  console.log(`elapsed ${((Date.now() - t1) / 1000).toFixed(1)}s, streams: ${streams.length}`);
  const castle = streams.filter(s => /castle/i.test(s.name));
  const kiss = streams.filter(s => /kiss/i.test(s.name));
  const torr = streams.filter(s => /torrentio/i.test(s.name));
  console.log(`Castle streams: ${castle.length} (must be 0)`);
  console.log(`Kisskh streams: ${kiss.length} (must be 0)`);
  console.log(`Torrentio streams (sanity, should be >0): ${torr.length}`);

  const ok = castle.length === 0 && kiss.length === 0 && torr.length > 0;
  console.log(ok ? 'VERDICT: PASS — normalized disabled matching works' : 'VERDICT: FAIL');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
