const providerLoader = require('./providerLoader');

// Default repo manifests — mirrors public/index.html defaultRepos
const DEFAULT_REPO_URL = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';
const DEFAULT_REPO_URLS = [
  'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/PirateZoro9/asura-providers/refs/heads/main/manifest.json',
  'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json',
  'https://plugin.eclipsia.dpdns.org/x5rn8g7q/manifest.json',
];

// Reference titles — TMDB IDs for stable probing (movies + one series + one anime)
const REFERENCE_TITLES = [
  { tmdbId: '872585', title: 'Oppenheimer', type: 'movie' },
  { tmdbId: '278', title: 'The Shawshank Redemption', type: 'movie' },
  { tmdbId: '155', title: 'The Dark Knight', type: 'movie' },
  { tmdbId: '27205', title: 'Inception', type: 'movie' },
  { tmdbId: '157336', title: 'Interstellar', type: 'movie' },
  { tmdbId: '1399', title: 'Game of Thrones', type: 'series', season: 1, episode: 1 },
  { tmdbId: '900667', title: 'One Piece Film: Red', type: 'anime' },
];

const PER_PROVIDER_TIMEOUT_MS = 5000;
const GLOBAL_TIMEOUT_MS = 50000;
const CONCURRENCY = 48;

function timeoutPromise(ms, label) {
  let timerId;
  const promise = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(label || 'Timeout')), ms);
  });
  promise.clear = () => clearTimeout(timerId);
  return promise;
}

// Mirrors the stream-handler type normalization in index.js
function normalizeRefType(ref) {
  if (ref.type === 'series' || ref.type === 'tv') {
    return { type: 'tv', season: ref.season ?? null, episode: ref.episode ?? null };
  }
  if (ref.type === 'anime') {
    return (ref.season != null && ref.episode != null)
      ? { type: 'tv', season: ref.season, episode: ref.episode }
      : { type: 'movie', season: null, episode: null };
  }
  return { type: 'movie', season: null, episode: null };
}

async function probeProvider(provider) {
  const start = Date.now();
  let streamsFound = 0;
  const titles = [];

  // Probe each reference title in parallel with per-title 8s race
  const titleResults = await Promise.allSettled(
    REFERENCE_TITLES.map(async (ref) => {
      const norm = normalizeRefType(ref);
      const t = timeoutPromise(PER_PROVIDER_TIMEOUT_MS, 'Scrape Timeout');
      try {
        const scrapePromise = provider.getStreams(ref.tmdbId, norm.type, norm.season, norm.episode, {});
        const streams = await Promise.race([scrapePromise, t]);
        if (Array.isArray(streams) && streams.length > 0) {
          return { title: ref.title, count: streams.length };
        }
        return { title: ref.title, count: 0 };
      } catch (e) {
        return { title: ref.title, count: 0 };
      } finally {
        t.clear();
      }
    })
  );

  for (const r of titleResults) {
    if (r.status === 'fulfilled' && r.value) {
      if (r.value.count > 0) {
        streamsFound += r.value.count;
        titles.push(r.value.title);
      } else {
        titles.push(r.value.title + ' (0)');
      }
    }
  }

  const latencyMs = Date.now() - start;
  const up = streamsFound > 0;
  const updatedAt = Date.now();
  return { streamsFound, latencyMs, up, titles, updatedAt };
}

async function probeAllProviders(opts = {}) {
  const repoUrls = opts.repoUrls || DEFAULT_REPO_URLS;
  const saveFn = opts.saveProviderStatus || null;

  // Resolve saver lazily to avoid circular require at module load
  let saveProviderStatus = saveFn;
  if (!saveProviderStatus) {
    try {
      const idx = require('./index');
      if (idx && typeof idx.saveProviderStatus === 'function') saveProviderStatus = idx.saveProviderStatus;
    } catch (e) {}
  }

  // 1. Load all providers from manifest URLs (expanded)
  let allProviders = [];
  const loadResults = await Promise.allSettled(repoUrls.map((url) => providerLoader.loadProviders(url)));
  for (const r of loadResults) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      allProviders = allProviders.concat(r.value);
    }
  }

  // Deduplicate by name (case-insensitive) — same provider from multiple manifests counted once
  const seen = new Set();
  const providers = [];
  for (const p of allProviders) {
    const key = String(p.name || p.id || '').toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      providers.push(p);
    }
  }

  if (providers.length === 0) {
    return { probed: 0, up: 0, down: 0 };
  }

  // 2. Probe with concurrency 16 and global 50s cap
  let up = 0;
  let down = 0;
  // Providers actually probed and settled this run (name -> result). The
  // response on global timeout is derived from this so it always reflects
  // stored truth instead of fabricated "down" entries for unprobed providers.
  const settledResults = new Map();

  async function runBatched() {
    for (let i = 0; i < providers.length; i += CONCURRENCY) {
      const batch = providers.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (provider) => {
          // Per-provider wall timeout 14s (spec global constraints) — wrap probeProvider
          // Inner per-title timeout is 8s via Promise.race above.
          const start = Date.now();
          const t = timeoutPromise(8000, 'Provider Timeout');
          try {
            const res = await Promise.race([probeProvider(provider), t]);
            return { provider, res };
          } catch (e) {
            // Timeout or error -> down; report measured elapsed time
            return { provider, res: { streamsFound: 0, latencyMs: Date.now() - start, up: false, titles: [], updatedAt: Date.now() } };
          } finally {
            t.clear();
          }
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const { provider, res } = r.value;
          if (res.up) up++;
          else down++;
          settledResults.set(provider.name, res);
          if (saveProviderStatus) {
            try {
              await saveProviderStatus(provider.name, res);
            } catch (e) {}
          }
        } else {
          down++;
        }
      }
    }
  }

  // Global cap 50s. When it fires we stop waiting and return only what has
  // already been probed/saved; the background batch keeps running and saving.
  let aborted = false;
  let fireAborted;
  const abortedPromise = new Promise((resolve) => {
    fireAborted = () => { aborted = true; resolve(); };
  });
  const globalTimer = setTimeout(fireAborted, GLOBAL_TIMEOUT_MS);

  const batched = runBatched();
  await Promise.race([batched, abortedPromise]);
  clearTimeout(globalTimer);

  if (!aborted) {
    return { probed: providers.length, up, down };
  }

  let settledUp = 0;
  for (const res of settledResults.values()) {
    if (res.up) settledUp++;
  }
  return { probed: settledResults.size, up: settledUp, down: settledResults.size - settledUp };
}

module.exports = {
  probeAllProviders,
  probeProvider,
  DEFAULT_REPO_URL,
  DEFAULT_REPO_URLS,
  REFERENCE_TITLES,
  PER_PROVIDER_TIMEOUT_MS,
  GLOBAL_TIMEOUT_MS,
  CONCURRENCY,
};
