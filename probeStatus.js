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

// 5 reference titles — TMDB IDs for stable probing
const REFERENCE_TITLES = [
  { tmdbId: '872585', title: 'Oppenheimer', type: 'movie' },
  { tmdbId: '278', title: 'The Shawshank Redemption', type: 'movie' },
  { tmdbId: '155', title: 'The Dark Knight', type: 'movie' },
  { tmdbId: '27205', title: 'Inception', type: 'movie' },
  { tmdbId: '157336', title: 'Interstellar', type: 'movie' },
];

const PER_PROVIDER_TIMEOUT_MS = 8000;
const GLOBAL_TIMEOUT_MS = 50000;
const CONCURRENCY = 16;

function timeoutPromise(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(label || 'Timeout')), ms));
}

async function probeProvider(provider) {
  const start = Date.now();
  let streamsFound = 0;
  const titles = [];

  // Probe each reference title in parallel with per-title 8s race
  const titleResults = await Promise.allSettled(
    REFERENCE_TITLES.map(async (ref) => {
      try {
        const scrapePromise = provider.getStreams(ref.tmdbId, ref.type, null, null, {});
        const streams = await Promise.race([
          scrapePromise,
          timeoutPromise(PER_PROVIDER_TIMEOUT_MS, 'Scrape Timeout'),
        ]);
        if (Array.isArray(streams) && streams.length > 0) {
          return { title: ref.title, count: streams.length };
        }
        return { title: ref.title, count: 0 };
      } catch (e) {
        return { title: ref.title, count: 0 };
      }
    })
  );

  for (const r of titleResults) {
    if (r.status === 'fulfilled' && r.value && r.value.count > 0) {
      streamsFound += r.value.count;
      titles.push(r.value.title);
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

  async function runBatched() {
    for (let i = 0; i < providers.length; i += CONCURRENCY) {
      const batch = providers.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (provider) => {
          // Per-provider wall timeout 14s (spec global constraints) — wrap probeProvider
          // Inner per-title timeout is 8s via Promise.race above.
          try {
            const res = await Promise.race([
              probeProvider(provider),
              timeoutPromise(14000, 'Provider Timeout'),
            ]);
            return { provider, res };
          } catch (e) {
            // Timeout or error -> down
            return { provider, res: { streamsFound: 0, latencyMs: 14000, up: false, titles: [], updatedAt: Date.now() } };
          }
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const { provider, res } = r.value;
          if (res.up) up++;
          else down++;
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

  // Global cap 50s
  try {
    await Promise.race([runBatched(), timeoutPromise(GLOBAL_TIMEOUT_MS, 'Global probe timeout')]);
  } catch (e) {
    if (e.message !== 'Global probe timeout') throw e;
    // Global timeout hit — treat remaining as down (already counted what we probed)
    const probedSoFar = up + down;
    const remaining = providers.length - probedSoFar;
    down += remaining > 0 ? remaining : 0;
  }

  return { probed: providers.length, up, down };
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
