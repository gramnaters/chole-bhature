const {
  sortAndTagStreams, parseStreamMetadata, deduplicateAndMergeStreams, getStreamFingerprint,
  formatStreamLabels, formatProviderLabel, cleanProviderName, normalizeTorrentHash
} = require('../streamTester');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail || ''}`); }
}
function section(name) { console.log(`\n=== ${name} ===`); }

let uid = 0;
function pt(overrides) {
  uid++;
  return Object.assign({
    name: 'Provider', title: 'Test Movie 2024', url: `https://example.com/video${uid}.mp4`,
    latency: 100, statusCategory: 'fast', isDead: false, _pretested: true
  }, overrides);
}
const magnet = (hash) => `magnet:?xt=urn:btih:${hash}`;

(async () => {

section('1. cleanProviderName — every variant');
{
  assert('plain provider passes', cleanProviderName('CinemaHD') === 'CinemaHD');
  assert('name with spaces passes', cleanProviderName('Net Mirrors') === 'Net Mirrors');
  assert('pipe-only splits to left', cleanProviderName('FAST | 141ms') === 'FAST');
  assert('bullet takes rightmost segment', cleanProviderName('FAST | 141ms • DesiFlix') === 'DesiFlix');
  assert('emoji-only leading stripped', cleanProviderName('🟢 CinemaHD') === 'CinemaHD');
  assert('quality token alone -> null', cleanProviderName('1080p') === null);
  assert('720p alone -> null', cleanProviderName('720p') === null);
  assert('4K alone -> null', cleanProviderName('4K') === null);
  assert('WEB-DL alone -> null', cleanProviderName('WEB-DL') === null);
  assert('Dual-Audio alone -> null', cleanProviderName('Dual-Audio') === null);
  assert('Hindi alone -> null', cleanProviderName('Hindi') === null);
  assert('DDP alone -> null', cleanProviderName('DDP') === null);
  assert('BluRay alone -> null', cleanProviderName('BluRay') === null);
  assert('mixed "HdGharTV 720p" keeps provider', cleanProviderName('HdGharTV 720p') === 'HdGharTV 720p');
  assert('mixed "NetMirror - 1080p" keeps provider', cleanProviderName('NetMirror (Netflix) - 1080p') === 'NetMirror (Netflix) - 1080p');
  assert('empty -> Stream', cleanProviderName('') === 'Stream');
  assert('null -> Stream', cleanProviderName(null) === 'Stream');
  assert('lowercase ddp not null (looks like provider)', cleanProviderName('ddp') === null, 'ddp should be quality token');
}

section('2. formatProviderLabel — dedup + fallback');
{
  assert('single provider', formatProviderLabel(['A'], 'X') === 'A');
  assert('two providers joined', formatProviderLabel(['A', 'B'], 'X') === 'A + B');
  assert('three providers joined', formatProviderLabel(['A', 'B', 'C'], 'X') === 'A + B + C');
  assert('case-insensitive dedup (A,a)', formatProviderLabel(['A', 'a'], 'X') === 'A');
  assert('null filtered out', formatProviderLabel(['A', null, 'B'], 'X') === 'A + B');
  assert('empty list -> default', formatProviderLabel([], 'D') === 'D');
  assert('all null -> default', formatProviderLabel([null, null], 'D') === 'D');
  assert('4+ providers -> (+N more)', formatProviderLabel(['A', 'B', 'C', 'D'], 'X') === 'A + B (+2 more)');
}

section('3. DEDUP — hash & URL variants');
{
  const mk = (name, hash, url, seeders) => pt({ name, title: 'Movie 2024 1080p', seeders, infoHash: hash, url: url || magnet(hash) });
  let out;

  out = await sortAndTagStreams([mk('A', 'A'.repeat(40)), mk('B', 'A'.repeat(40))], { deduplicateStreams: true });
  assert('same hash merged', out.length === 1, `got ${out.length}`);

  out = await sortAndTagStreams([mk('A', 'A'.repeat(40)), mk('B', 'A'.repeat(40).toLowerCase())], { deduplicateStreams: true });
  assert('hash case-insensitive merged', out.length === 1);

  out = await sortAndTagStreams([pt({ name: 'A', url: 'https://x/a.mp4' }), pt({ name: 'B', url: 'https://x/a.mp4' })], { deduplicateStreams: true });
  assert('same URL merged', out.length === 1);

  out = await sortAndTagStreams([pt({ name: 'A', url: 'https://x/a.mp4' }), pt({ name: 'B', url: 'https://x/A.MP4' })], { deduplicateStreams: true });
  assert('URL case-insensitive merged', out.length === 1, `got ${out.length}`);

  out = await sortAndTagStreams([mk('A', 'A'.repeat(40)), mk('B', 'B'.repeat(40))], { deduplicateStreams: true });
  assert('different hashes stay separate', out.length === 2);

  out = await sortAndTagStreams([mk('A', 'A'.repeat(40), 'https://x/a.mp4'), mk('B', 'B'.repeat(40), 'https://x/a.mp4')], { deduplicateStreams: true });
  assert('same URL different hashes NOT merged (hash is authoritative)', out.length === 2, `got ${out.length}`);

  const merged = await sortAndTagStreams([mk('CinemaHD', 'A'.repeat(40)), mk('MovieBox', 'A'.repeat(40))], { deduplicateStreams: true });
  assert('merged label has both providers', merged[0].name.includes('CinemaHD') && merged[0].name.includes('MovieBox'), merged[0] && merged[0].name);
  assert('merged label has NO "Stream"', merged[0] && !/Stream/.test(merged[0].name), merged[0] && merged[0].name);

  out = await sortAndTagStreams([mk('A', 'A'.repeat(40)), mk('B', 'A'.repeat(40))], { deduplicateStreams: false });
  assert('dedup OFF keeps 2', out.length === 2);
}

section('4. FILTERS — hideDead / hideSlow / hideCam / showSeeders');
{
  const fast = pt({ latency: 100, statusCategory: 'fast' });
  const slow = pt({ latency: 900, statusCategory: 'slow' });
  const dead = pt({ latency: 99999, statusCategory: 'dead', isDead: true });
  let out;

  out = await sortAndTagStreams([fast, slow, dead], { hideDead: true });
  assert('hideDead keeps fast+slow', out.length === 2, `got ${out.length}`);
  out = await sortAndTagStreams([fast, slow, dead], { hideDead: true, hideSlow: true });
  assert('hideDead+hideSlow keeps fast only', out.length === 1 && out[0].name.includes('FAST'));
  out = await sortAndTagStreams([fast, slow, dead], { hideDead: false, hideSlow: false });
  assert('no filters keeps all 3', out.length === 3);
  out = await sortAndTagStreams([fast, slow, dead], { hideSlow: true });
  assert('hideSlow alone removes slow', out.length === 2);

  const cam = pt({ title: 'Movie 2024 CAM 720p x264' });
  const hdcam = pt({ title: 'Movie 2024 HDCAM 1080p' });
  const ts = pt({ title: 'Movie 2024 TeleSync 1080p' });
  const tc = pt({ title: 'Movie 2024 TC 1080p' });
  const dvdscr = pt({ title: 'Movie 2024 DVDSCR 720p' });
  const screener = pt({ title: 'Movie 2024 Screener 720p' });
  const clean = pt({ title: 'Movie 2024 BluRay 1080p' });
  const legit = pt({ title: 'Ghostbusters: Frozen Empire 2024 HDR10' });

  out = await sortAndTagStreams([cam, hdcam, ts, tc, dvdscr, screener, clean, legit], { hideCam: true });
  assert('hideCam removes all 6 cam types, keeps clean+legit', out.length === 2, `got ${out.length}`);
  assert('no false CAM on Ghostbusters HDR10', parseStreamMetadata(legit).isCam === false);

  const s25 = pt({ title: 'Movie 1080p', seeders: 25, url: magnet('C'.repeat(40)), name: 'Torrentio' });
  out = await sortAndTagStreams([s25], { showSeeders: true });
  assert('showSeeders true -> badge present', /🟢 25 Seeders/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([s25], { showSeeders: false });
  assert('showSeeders false -> no badge', !/Seeder/.test(out[0].name), out[0].name);
}

section('5. SORT — speed / quality / balanced / seeders / default');
{
  const s4k = pt({ title: 'Movie 2160p WEB-DL', latency: 700, statusCategory: 'slow' });
  const s1080 = pt({ title: 'Movie 1080p WEB-DL', latency: 150, statusCategory: 'fast' });
  const s720 = pt({ title: 'Movie 720p WEB-DL', latency: 100, statusCategory: 'fast' });
  const s480 = pt({ title: 'Movie 480p', latency: 50, statusCategory: 'fast' });
  let out;

  out = await sortAndTagStreams([s1080, s4k, s720, s480], { sortBy: 'quality' });
  assert('quality: 2160p first', /2160p/.test(out[0].title));
  assert('quality: 1080p > 720p > 480p', /1080p/.test(out[1].title) && /720p/.test(out[2].title) && /480p/.test(out[3].title), out.map(s=>s.title).join(' | '));

  out = await sortAndTagStreams([s4k, s1080, s720], { sortBy: 'speed' });
  assert('speed: fastest (720p 100ms) first', /720p/.test(out[0].title), `first=${out[0].title}`);

  out = await sortAndTagStreams([s1080, s4k, s720, s480], { sortBy: 'balanced' });
  assert('balanced: 1080p Fast(4) > 4K Slow(3) > 720p Fast(1) > 480p(0)', /1080p/.test(out[0].title) && /2160p/.test(out[1].title) && /720p/.test(out[2].title) && /480p/.test(out[3].title), out.map(s=>s.title).join(' | '));

  const b4kF = pt({ title: 'Movie B4 2160p WEB-DL', latency: 500, statusCategory: 'fast' });
  const b1080F = pt({ title: 'Movie B3 1080p WEB-DL', latency: 400, statusCategory: 'fast' });
  const b4kS = pt({ title: 'Movie B2 2160p WEB-DL', latency: 900, statusCategory: 'slow' });
  const b1080S = pt({ title: 'Movie B1 1080p WEB-DL', latency: 950, statusCategory: 'slow' });
  out = await sortAndTagStreams([b1080S, b4kS, b1080F, b4kF], { sortBy: 'balanced' });
  const t = out.map(s => s.title);
  assert('balanced matrix: 4K fast > 1080p fast > 4K slow > 1080p slow', /B4 2160p/.test(t[0]) && /B3 1080p/.test(t[1]) && /B2 2160p/.test(t[2]) && /B1 1080p/.test(t[3]), t.join(' | '));

  const seedTxt = [
    { name: 'T1', title: 'Movie A 1080p 👤 100', url: magnet('1'.repeat(40)) },
    { name: 'T2', title: 'Movie B 1080p 👤 10', url: magnet('2'.repeat(40)) }
  ];
  out = await sortAndTagStreams(seedTxt, { sortBy: 'seeders' });
  assert('seeders: text-embedded 100 first', /Movie A/.test(out[0].title), `first=${out[0].title}`);

  const seedField = [
    { name: 'T1', title: 'Movie C 1080p', seeders: 100, url: magnet('3'.repeat(40)) },
    { name: 'T2', title: 'Movie D 1080p', seeders: 10, url: magnet('4'.repeat(40)) }
  ];
  out = await sortAndTagStreams(seedField, { sortBy: 'seeders' });
  assert('seeders: structured field 100 first', /Movie C/.test(out[0].title), `first=${out[0].title}`);

  out = await sortAndTagStreams([s1080, s720], {});
  assert('default mode runs (no crash)', out.length === 2);
}

section('6. LANGUAGE / HINDI PRIORITY — every combination');
{
  const eng = pt({ title: 'Movie 1080p BluRay English', latency: 400, statusCategory: 'fast' });
  const hin = pt({ title: 'Movie 1080p BluRay Hindi', latency: 400, statusCategory: 'fast' });
  const dual = pt({ title: 'Movie 1080p BluRay Dual Audio', latency: 400, statusCategory: 'fast' });
  const tam = pt({ title: 'Movie 1080p BluRay Tamil', latency: 400, statusCategory: 'fast' });
  let out;

  out = await sortAndTagStreams([eng, hin, dual, tam], { sortBy: 'speed', preferredLanguages: ['Hindi', 'Dual-Audio'], prioritizeHindi: true });
  assert('pref [Hindi,Dual]: Hindi first', /Hindi/.test(out[0].title), out.map(s=>s.title).join(' | '));
  assert('pref [Hindi,Dual]: Dual second', /Dual/.test(out[1].title), out.map(s=>s.title).join(' | '));

  out = await sortAndTagStreams([eng, hin, dual, tam], { sortBy: 'speed', preferredLanguages: ['Tamil'] });
  assert('pref [Tamil]: Tamil first', /Tamil/.test(out[0].title), out.map(s=>s.title).join(' | '));

  out = await sortAndTagStreams([eng, hin, dual], { sortBy: 'speed' });
  assert('no pref: original order preserved', /English/.test(out[0].title) && /Hindi/.test(out[1].title), out.map(s=>s.title).join(' | '));

  // Real-world case: same status tier, Hindi is SLOWER but must float above English
  // (audio preference outranks exact latency in speed mode)
  const hinSlower = pt({ title: 'Movie 1080p BluRay Hindi', latency: 500, statusCategory: 'fast' });
  const engFaster = pt({ title: 'Movie 1080p BluRay English', latency: 100, statusCategory: 'fast' });
  out = await sortAndTagStreams([engFaster, hinSlower], { sortBy: 'speed', preferredLanguages: ['Hindi'], prioritizeHindi: true });
  assert('Hindi priority beats latency within status tier', /Hindi/.test(out[0].title), out.map(s=>s.title).join(' | '));
}

section('7. SEEDER TIERS — DEAD / SLOW / FAST');
{
  const mk = (seeders) => ({ name: 'Torrentio', title: 'Movie 2024 1080p', url: magnet(seeders.toString(16).padStart(40, '0')), seeders });
  let out = await sortAndTagStreams([mk(0)], {});
  assert('0 seeders -> DEAD', /DEAD/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([mk(3)], {});
  assert('3 seeders -> SLOW 🔴', /🔴 3 Seeder/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([mk(5)], {});
  assert('5 seeders -> SLOW 🟡', /🟡 5 Seeders/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([mk(19)], {});
  assert('19 seeders -> SLOW 🟡', /🟡 19 Seeders/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([mk(20)], {});
  assert('20 seeders -> FAST 🟢', /🟢 20 Seeders/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([mk(50)], {});
  assert('50 seeders -> FAST 🟢', /🟢 50 Seeders/.test(out[0].name), out[0].name);
  out = await sortAndTagStreams([mk(1)], {});
  assert('1 seeder -> singular "Seeder"', /1 Seeder\b/.test(out[0].name), out[0].name);
}

section('8. P2P / HTTP DEAD DETECTION');
{
  let out = await sortAndTagStreams([{ name: 'P', title: 'Movie 2024 1080p', url: 'http://127.0.0.1:1/video.mp4' }], {});
  assert('unreachable http -> DEAD', /DEAD/.test(out[0].name), out[0].name);

  out = await sortAndTagStreams([{ name: 'P', title: 'Movie 2024 1080p 🧲', url: 'http://127.0.0.1:1/video.mp4' }], {});
  assert('unreachable p2p http -> DEAD too', /DEAD/.test(out[0].name), out[0].name);
}

section('9. SAMPLE / TRAILER detection');
{
  const sample = pt({ title: 'Movie 2024 sample 1080p' });
  const trailer = pt({ title: 'Movie 2024 trailer 1080p' });
  assert('sample flagged', parseStreamMetadata(sample).isSample === true);
  assert('trailer flagged', parseStreamMetadata(trailer).isSample === true);
}

section('10. normalizeTorrentHash + fingerprint');
{
  assert('40-hex hash normalized', normalizeTorrentHash('A'.repeat(40)) === 'A'.repeat(40).toLowerCase());
  assert('magnet hash extracted', normalizeTorrentHash(magnet('B'.repeat(40))) === 'B'.repeat(40).toLowerCase());
  assert('garbage -> null', normalizeTorrentHash('garbage') === null);
  assert('32-base32 accepted', normalizeTorrentHash('b'.repeat(32)) === 'b'.repeat(32));
  const a = { url: 'https://x/a.mp4' };
  const b = { url: 'https://x/a.mp4' };
  assert('fingerprint stable for same URL', getStreamFingerprint(a) === getStreamFingerprint(b));
}

section('11. MULTI-SOURCE max seeders preserved');
{
  const s1 = pt({ name: 'A', infoHash: 'A'.repeat(40), seeders: 5, title: 'Movie 1080p' });
  const s2 = pt({ name: 'B', infoHash: 'a'.repeat(40), seeders: 30, title: 'Movie 1080p' });
  const out = await sortAndTagStreams([s1, s2], { deduplicateStreams: true });
  assert('merged keeps max seeders (30)', /30/.test(out[0].name), out[0].name);
}

section('12. QUALITY tier split protection');
{
  const a = pt({ name: 'A', url: 'https://x/v.mp4', title: 'Movie 1080p' });
  const b = pt({ name: 'B', url: 'https://x/v.mp4', title: 'Movie 720p' });
  const out = await sortAndTagStreams([a, b], { deduplicateStreams: true });
  assert('same URL different resolution NOT merged', out.length === 2, `got ${out.length}`);
}

console.log(`\n==========\nPASS: ${passed}  FAIL: ${failed}\n==========`);
process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
