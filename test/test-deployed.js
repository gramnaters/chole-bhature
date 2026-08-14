const BASE = 'https://chole-bhature.vercel.app';

async function post(url, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal
    });
    clearTimeout(t);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { clearTimeout(t); }
}
async function get(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, { signal: ctrl.signal });
    clearTimeout(t);
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: res.status, body };
  } finally { clearTimeout(t); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- 1. Save a config to the deployed (serverless) instance ---');
  const configId = 'bench' + Math.random().toString(36).slice(2, 8);
  const cfg = {
    configId,
    config: {
      urls: ['https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json'],
      hideDead: true, hideSlow: true, hideCam: true, showSeeders: true, deduplicateStreams: true,
      enableDoh: true, dohProvider: 'cloudflare', accessToken: '',
      sortBy: 'quality', sortMode: 'quality', prioritizeQuality: true,
      prioritizeHindi: true, preferredLanguages: ['Hindi', 'Dual-Audio'],
      disabled: ['AllAnime', 'HDFilme']
    }
  };
  const saved = await post('/api/config/save', cfg);
  console.log('save status:', saved.status, 'body:', JSON.stringify(saved.body));
  if (!saved.body || !saved.body.success) { console.log('ABORT: save failed'); return; }

  console.log('\n--- 2. Immediate GET (same warm instance expected) ---');
  const g1 = await get(`/api/config/${configId}`);
  console.log('get1 status:', g1.status, 'config sortBy=', g1.body && g1.body.config && g1.body.config.sortBy);

  console.log('\n--- 3. Wait 20s then GET again (likely a DIFFERENT serverless instance) ---');
  await sleep(20000);
  const g2 = await get(`/api/config/${configId}`);
  console.log('get2 status:', g2.status, 'config present:', !!(g2.body && g2.body.config));
  console.log(g2.body && g2.body.config ? 'PASS: config persisted across instances' : 'FAIL: config LOST (no cross-instance persistence)');

  console.log('\n--- 4. /c/:id/manifest.json resolves for a NEVER-saved config id ---');
  const g3 = await get(`/c/${configId}123/manifest.json`);
  console.log('manifest for unknown config:', g3.status, 'name=', g3.body && g3.body.name);

  console.log('\n--- 5. /api/verify-token with garbage ---');
  const g4 = await get('/api/verify-token/chole-bhature-deadbeef');
  console.log('verify-token garbage:', g4.status, JSON.stringify(g4.body));

  console.log('\n--- 6. /api/analytics ---');
  const g5 = await get('/api/analytics');
  console.log('analytics:', g5.status, typeof g5.body === 'object' ? 'object' : g5.body);

  console.log('\n--- 7. /api/wakeup ---');
  const g6 = await get('/api/wakeup', 60000);
  console.log('wakeup:', g6.status, String(g6.body).slice(0, 80));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
