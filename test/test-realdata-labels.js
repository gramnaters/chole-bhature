const BASE = 'http://localhost:7000';
const TECH = /^(?:\d{2,4}p|4k|uhd|sd|hd|fhd|web[- ]?dl|webrip|blu[- ]?ray|bluray|hdrip|bdrip|dvdrip|hdtv|h26[45]|hevc|av1|x26[45]|vp9|aac|ac3|eac3|ddp|dts|truehd|atmos|flac|opus|mp3|pcm|2\.0|5\.1|7\.1|10bit|8bit|hdr10?\+?|sdr|dolby[- ]?vision|dv|mkv|mp4|avi|webm|multi[- ]?audio|dual[- ]?audio|english|hindi|tamil|telugu|japanese|korean)$/i;

(async () => {
  console.log('=== Real-data merged-label probe (benchtest3, dedup ON) ===');
  const r = await fetch(BASE + '/c/benchtest3/stream/movie/tmdb:27205.json').then(res => res.json());
  const streams = r.streams || [];
  console.log('total streams:', streams.length);

  const merged = streams.filter(s => /\s\+\s/.test(s.name));
  console.log('merged (multi-provider) streams:', merged.length);

  let bad = [];
  let noProvider = 0;
  for (const s of streams) {
    const name = s.name || '';
    const m = name.match(/•\s*(.*?)(?:\s\|\s|$)/);
    const providerPart = m ? m[1] : name;
    if (!providerPart || providerPart.trim() === '') { noProvider++; continue; }
    const parts = providerPart.split(' + ');
    for (const p of parts) {
      const t = p.trim();
      if (TECH.test(t) || /^stream$/i.test(t) || /^(fast|slow|dead)$/i.test(t)) {
        bad.push(t + '  <= ' + name);
      }
    }
  }
  console.log('streams with empty provider label:', noProvider);
  if (bad.length === 0) {
    console.log('VERDICT: PASS - no tech-token/Stream pollution in any provider label');
  } else {
    console.log('VERDICT: FAIL - polluted labels:');
    bad.slice(0, 15).forEach(b => console.log('   ', b));
  }
  process.exit(bad.length === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(2); });
