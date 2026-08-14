const BASE = 'http://localhost:7000';

async function post(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return res.json();
}
async function get(url, timeoutMs = 115000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, { signal: ctrl.signal });
    clearTimeout(t);
    return await res.json();
  } finally { clearTimeout(t); }
}

(async () => {
  const emoji = String.fromCodePoint(0x1F9F2); // 🧲
  const torrentioName = emoji + ' Torrentio';
  console.log('Disabled name codepoints:', [...torrentioName].map(c => c.codePointAt(0).toString(16)).join(' '));

  const cfg = {
    configId: 'benchtest3',
    config: {
      urls: ['https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json'],
      hideDead: false, hideSlow: false, hideCam: false,
      showSeeders: true, deduplicateStreams: true, enableDoh: true, dohProvider: 'cloudflare',
      accessToken: '', sortBy: 'speed', sortMode: 'speed', prioritizeQuality: false,
      prioritizeHindi: false, preferredLanguages: [],
      disabled: [torrentioName]
    }
  };
  const saved = await post('/api/config/save', cfg);
  console.log('Saved disabled:', JSON.stringify(saved.config.disabled));

  console.log('Requesting streams (may take ~35s)...');
  const t0 = Date.now();
  const result = await get('/c/benchtest3/stream/movie/tmdb:27205.json');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const streams = result.streams || [];
  console.log(`Elapsed ${elapsed}s, streams: ${streams.length}`);
  const torr = streams.filter(s => /torrentio/i.test(s.name));
  console.log(`Torrentio streams found: ${torr.length}`);
  console.log(torr.length === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');

  // Also demonstrate the cross-repo name-mismatch bypass with real emoji names
  const cfg2 = {
    configId: 'benchtest4',
    config: {
      urls: [
        'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json',
        'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json'
      ],
      hideDead: false, hideSlow: false, hideCam: false,
      showSeeders: true, deduplicateStreams: true, enableDoh: true, dohProvider: 'cloudflare',
      accessToken: '', sortBy: 'speed', sortMode: 'speed', prioritizeQuality: false,
      prioritizeHindi: false, preferredLanguages: [],
      disabled: [String.fromCodePoint(0x1F3F0) + ' Castle'] // 🏰 Castle only
    }
  };
  const saved2 = await post('/api/config/save', cfg2);
  console.log('\nSaved2 disabled:', JSON.stringify(saved2.config.disabled));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
