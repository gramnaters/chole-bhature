const { sortAndTagStreams, parseStreamMetadata, deduplicateAndMergeStreams, getStreamFingerprint, formatStreamLabels } = require('../streamTester');

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
    name: 'Provider',
    title: 'Test Movie 2024',
    url: `https://example.com/video${uid}.mp4`,
    latency: 100,
    statusCategory: 'fast',
    isDead: false,
    _pretested: true
  }, overrides);
}

(async () => {

section('1. DEDUPLICATION');
{
  const dupByHash = [
    pt({ infoHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: 'Torrentio', title: 'Movie 2024 1080p', seeders: 5 }),
    pt({ infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Peerflix', title: 'Movie 2024 1080p', seeders: 30 })
  ];
  const out = await sortAndTagStreams(dupByHash, { deduplicateStreams: true });
  assert('same infoHash (case-insens) merged into 1', out.length === 1, `got ${out.length}`);
  assert('merged provider label shows both', out[0] && out[0].name.includes('Torrentio') && out[0].name.includes('Peerflix'));
  assert('max seeders preserved', out[0] && out[0].name.includes('30'));

  const dupByUrl = [
    pt({ url: 'https://cdn.example.com/a.mp4', name: 'CinemaHD' }),
    pt({ url: 'https://cdn.example.com/a.mp4', name: 'MovieBox' })
  ];
  const out2 = await sortAndTagStreams(dupByUrl, { deduplicateStreams: true });
  assert('same URL merged into 1', out2.length === 1, `got ${out2.length}`);
  assert('URL dedup label has both providers', out2[0] && out2[0].name.includes('CinemaHD') && out2[0].name.includes('MovieBox'));

  const noDedup = await sortAndTagStreams(dupByUrl, { deduplicateStreams: false });
  assert('dedup OFF keeps 2 streams', noDedup.length === 2, `got ${noDedup.length}`);
}

section('2. CAM / THEATER-RIP BLOCK');
{
  const cam = pt({ title: 'Movie 2024 CAM 720p x264' });
  const hdcam = pt({ title: 'Movie 2024 HDCAM 1080p' });
  const telesync = pt({ title: 'Movie 2024 TeleSync 1080p' });
  const tc = pt({ title: 'Movie 2024 TC 1080p' });
  const dvdscr = pt({ title: 'Movie 2024 DVDSCR 720p' });
  const clean = pt({ title: 'Movie 2024 BluRay 1080p' });
  const withTitles = [cam, hdcam, telesync, tc, dvdscr, clean];

  const blocked = await sortAndTagStreams(withTitles, { hideCam: true, hideDead: false });
  assert('hideCam removes all 5 CAM types, keeps clean', blocked.length === 1, `got ${blocked.length}: ${blocked.map(s=>s.title).join(', ')}`);

  const notBlocked = await sortAndTagStreams(withTitles, { hideCam: false, hideDead: false });
  assert('hideCam OFF keeps all 6', notBlocked.length === 6, `got ${notBlocked.length}`);

  const legit = pt({ title: 'Ghostbusters: Frozen Empire 2024 HDR10' });
  const meta = parseStreamMetadata(legit);
  assert('no false CAM on legit release', meta.isCam === false);
}

section('3. DEAD / SLOW FILTERS');
{
  const fast = pt({ latency: 120, statusCategory: 'fast' });
  const slow = pt({ latency: 900, statusCategory: 'slow' });
  const dead = pt({ latency: 99999, statusCategory: 'dead', isDead: true });

  let out = await sortAndTagStreams([fast, slow, dead], { hideDead: true });
  assert('hideDead removes dead', out.length === 2, `got ${out.length}`);

  out = await sortAndTagStreams([fast, slow, dead], { hideDead: true, hideSlow: true });
  assert('hideDead+hideSlow keeps only fast', out.length === 1, `got ${out.length}`);

  out = await sortAndTagStreams([fast, slow, dead], {});
  assert('no filters keeps all 3', out.length === 3);

  const allDead = [pt({ latency: 99999, statusCategory: 'dead', isDead: true })];
  out = await sortAndTagStreams(allDead, { hideDead: true });
  assert('hideDead with all-dead returns 0 (no fallback bypass)', out.length === 0, `got ${out.length} (fallback re-enabled hidden streams)`);
}

section('4. P2P / SEEDER HANDLING (non-pretested magnet streams)');
{
  const mkP2P = (hash, seeders) => ({
    name: 'Torrentio', title: 'Movie 2024 1080p', url: `magnet:?xt=urn:btih:${hash}`, seeders
  });

  let out0 = await sortAndTagStreams([mkP2P('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 0)], {});
  assert('0-seeder torrent = DEAD', out0[0] && out0[0].name.includes('DEAD'), out0[0] && out0[0].name);

  let out3 = await sortAndTagStreams([mkP2P('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 3)], {});
  assert('3-seeder torrent = SLOW tier (🔴 badge)', out3[0] && out3[0].name.includes('🔴 3 Seeder'), out3[0] && out3[0].name);

  let out50 = await sortAndTagStreams([mkP2P('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 50)], {});
  assert('50-seeder torrent = FAST tier (🟢 badge)', out50[0] && out50[0].name.includes('🟢 50 Seeder'), out50[0] && out50[0].name);
}

section('5. SORT MODES');
{
  const mk = (title, latency, statusCategory) => pt({
    title, latency, statusCategory, _pretested: true
  });

  const s4k = mk('Movie 2160p WEB-DL', 700, 'slow');
  const s1080 = mk('Movie 1080p WEB-DL', 150, 'fast');
  const s720 = mk('Movie 720p WEB-DL', 100, 'fast');
  const s480 = mk('Movie 480p', 50, 'fast');

  let out = await sortAndTagStreams([s1080, s4k, s720, s480], { sortBy: 'quality' });
  assert('quality mode: 2160p first even if slow', out[0].title.includes('2160p'), `first=${out[0].title}`);
  assert('quality mode: 1080p before 720p', out[1].title.includes('1080p') && out[2].title.includes('720p'), `${out.map(s=>s.title).join(' | ')}`);

  out = await sortAndTagStreams([s4k, s1080, s720], { sortBy: 'speed' });
  assert('speed mode: fastest first (720p 100ms)', out[0].title.includes('720p'), `first=${out[0].title}`);

  const b4kFast = mk('Movie B4 2160p WEB-DL', 500, 'fast');
  const b1080Fast = mk('Movie B3 1080p WEB-DL', 400, 'fast');
  const b4kSlow = mk('Movie B2 2160p WEB-DL', 900, 'slow');
  const b1080Slow = mk('Movie B1 1080p WEB-DL', 950, 'slow');
  out = await sortAndTagStreams([b1080Slow, b4kSlow, b1080Fast, b4kFast], { sortBy: 'balanced' });
  const titles = out.map(s => s.title);
  assert('balanced: 4K fast > 1080p fast > 4K slow > 1080p slow',
    /B4 2160p/.test(titles[0]) && /B3 1080p/.test(titles[1]) && /B2 2160p/.test(titles[2]) && /B1 1080p/.test(titles[3]),
    titles.join(' | '));

  // SEEDERS MODE with seeders embedded in title text
  const seedA = { name: 'T1', title: 'Movie A 1080p 👤 100', url: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111' };
  const seedB = { name: 'T2', title: 'Movie B 1080p 👤 10', url: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222' };
  out = await sortAndTagStreams([seedB, seedA], { sortBy: 'seeders' });
  assert('seeders mode: 100-seeders first (text-embedded)', out[0].title.includes('Movie A'), `first=${out[0].title}`);

  // SEEDERS MODE with STRUCTURED seeders field only (no text) - real-world Torrentio shape
  const seedC = { name: 'T1', title: 'Movie C 1080p', seeders: 100, url: 'magnet:?xt=urn:btih:4444444444444444444444444444444444444444' };
  const seedD = { name: 'T2', title: 'Movie D 1080p', seeders: 10, url: 'magnet:?xt=urn:btih:5555555555555555555555555555555555555555' };
  out = await sortAndTagStreams([seedD, seedC], { sortBy: 'seeders' });
  assert('seeders mode: structured seeders field respected', out[0].title.includes('Movie C'), `first=${out[0].title} (getSeederScore ignores stream.seeders)`);
}

section('6. LANGUAGE / HINDI PRIORITY');
{
  const mk = (title) => pt({ title, latency: 400, statusCategory: 'fast' });

  const eng = mk('Movie 1080p BluRay English');
  const hin = mk('Movie 1080p BluRay Hindi');
  const dual = mk('Movie 1080p BluRay Dual Audio');

  let out = await sortAndTagStreams([eng, hin, dual], { sortBy: 'speed', preferredLanguages: ['Hindi', 'Dual-Audio'], prioritizeHindi: true });
  assert('Hindi priority floats Hindi first', out[0].title.includes('Hindi'), `first=${out[0].title}`);
  assert('Dual-Audio second', out[1].title.includes('Dual'), `${out.map(s=>s.title).join(' | ')}`);

  out = await sortAndTagStreams([eng, hin, dual], { sortBy: 'speed' });
  assert('no lang pref keeps original order', out[0].title.includes('English') && out[1].title.includes('Hindi'), out.map(s=>s.title).join(' | '));
}

section('7. SEEDER BADGE & FORMAT');
{
  const s = pt({ title: 'Movie 1080p BluRay', seeders: 25, url: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333', name: 'Torrentio' });
  const out = await sortAndTagStreams([s], {});
  assert('healthy seeder badge present', /🟢 25 Seeders/.test(out[0].name), out[0].name);
}

section('8. DEAD HTTP LINK DETECTION (real network probe)');
{
  // Truly unreachable host -> label check (final output strips internal fields)
  const unreachable = { name: 'P', title: 'Movie 2024 1080p', url: 'http://127.0.0.1:1/video.mp4' };
  const out = await sortAndTagStreams([unreachable], {});
  const name = out[0] && out[0].name || '';
  assert('unreachable http link flagged DEAD (not SLOW)', name.includes('DEAD'), `${name} <- hideDead will NOT remove this`);
}

console.log(`\n==========\nPASS: ${passed}  FAIL: ${failed}\n==========`);
process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
