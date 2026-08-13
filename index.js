const express = require('express');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const path = require('path');
const providerLoader = require('./providerLoader');
const { sortAndTagStreams } = require('./streamTester');
const { setDohEnabled, setDohProvider, getDohConfig } = require('./dohResolver');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const torrentEngine = require('./torrentEngine');
const realDebrid = require('./realDebrid');

const app = express();
app.use(express.json());

// Persistent User Configuration Store
// WARNING: on Vercel the function filesystem is EPHEMERAL and per-instance — anything
// written to user_configs.json is lost on cold start and invisible to other instances.
// To persist configs durably on Vercel, set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// (free Upstash Redis tier: 256MB, 500K commands/mo, no credit card). Without them we
// fall back to the local file (fine for a single long-running server / local dev).
const CONFIGS_FILE = path.join(__dirname, 'user_configs.json');
const userConfigs = new Map();

// In-Memory Stream Cache — prevents Stremio UI glitches / duplicate re-scrapes on auto-refresh.
// 30 min TTL, bounded size. Keyed on the full config payload so distinct configs never share
// entries AND any settings change instantly busts the cache (no stale streams after edits).
const streamCache = new Map();
const STREAM_CACHE_TTL_MS = 30 * 60 * 1000;
const STREAM_CACHE_MAX_ENTRIES = 500;

function getConfigCacheKey(config) {
    // Always hash the entire config: covers both /c/:configId and /:configJSON routes,
    // and detects config content changes (upstream only keyed by configId on the /c/ route,
    // which served stale streams after a user edited their settings).
    try {
        return 'cfg:' + crypto.createHash('sha1').update(JSON.stringify(config)).digest('hex').slice(0, 16);
    } catch (e) {
        return config.configId ? 'cfg:' + config.configId : 'cfg:default';
    }
}

// Real-Debrid API key source: Vercel env var first, then realdebrid.json (managed by the owner / self-hosted)
const RD_KEY_FILE = path.join(__dirname, 'realdebrid.json');
function getRealDebridKey() {
    if (process.env.REALDEBRID_API_KEY) return process.env.REALDEBRID_API_KEY;
    try {
        if (fs.existsSync(RD_KEY_FILE)) {
            const d = JSON.parse(fs.readFileSync(RD_KEY_FILE, 'utf8'));
            if (d.apiKey) return d.apiKey;
        }
    } catch (e) {}
    return null;
}

let redis = null;
try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        const { Redis } = require('@upstash/redis');
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN
        });
        console.log('[Config] Upstash Redis persistence ENABLED.');
        realDebrid.setRedis(redis); // shared cache for resolved RD links (L2, cross-instance)
    }
} catch (e) {
    console.warn('[Config] Upstash Redis unavailable, using file storage only:', e.message);
}
const REDIS_CONFIGS_KEY = 'nuvio:user_configs';

function loadUserConfigsFromFile() {
    try {
        if (fs.existsSync(CONFIGS_FILE)) {
            const raw = fs.readFileSync(CONFIGS_FILE, 'utf8');
            const data = JSON.parse(raw);
            for (const [k, v] of Object.entries(data)) {
                userConfigs.set(k, v);
            }
            console.log(`[Config] Loaded ${userConfigs.size} configurations from file.`);
        }
    } catch (e) {
        console.error('[Config] Failed to load user_configs.json:', e.message);
    }
}

async function loadUserConfigsFromRedis() {
    if (!redis) return;
    try {
        const raw = await redis.get(REDIS_CONFIGS_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            for (const [k, v] of Object.entries(data)) {
                userConfigs.set(k, v);
            }
            console.log(`[Config] Loaded ${userConfigs.size} configurations from Upstash Redis.`);
        }
    } catch (e) {
        console.error('[Config] Failed to load from Upstash Redis:', e.message);
    }
}

async function persistUserConfigsToRedis() {
    if (!redis) return;
    try {
        const obj = {};
        for (const [k, v] of userConfigs.entries()) {
            obj[k] = v;
        }
        await redis.set(REDIS_CONFIGS_KEY, JSON.stringify(obj));
    } catch (e) {
        console.error('[Config] Failed to persist to Upstash Redis:', e.message);
    }
}

function persistUserConfigsToFile() {
    try {
        const obj = {};
        for (const [k, v] of userConfigs.entries()) {
            obj[k] = v;
        }
        fs.writeFileSync(CONFIGS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error('[Config] Failed to persist user_configs.json:', e.message);
    }
}

async function loadUserConfigs() {
    loadUserConfigsFromFile();        // local dev / non-Vercel
    await loadUserConfigsFromRedis(); // durable copy on Vercel (overrides any stale file)
}

async function saveUserConfig(configId, configData) {
    userConfigs.set(configId, configData);
    persistUserConfigsToFile();
    await persistUserConfigsToRedis();
}

// Reads a config, falling back to Redis when the in-memory map is empty (e.g. just
// booted on a fresh Vercel instance before the background load finished).
async function getConfig(configId) {
    let config = userConfigs.get(configId) || null;
    if (!config && redis) {
        try {
            const raw = await redis.get(REDIS_CONFIGS_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                config = data[configId] || null;
                if (config) userConfigs.set(configId, config);
            }
        } catch (e) {
            console.error('[Config] Redis read fallback failed:', e.message);
        }
    }
    return config;
}

loadUserConfigs();

// PWA Core Endpoints with explicit headers & CORS for WebAPK minting
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get(['/favicon.ico', '/favicon.png'], (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

['icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'logo.png'].forEach((iconFile) => {
    app.get(`/${iconFile}`, (req, res) => {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(path.join(__dirname, 'public', iconFile));
    });
});

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/', '/configure', '/index.html'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve configure page on configId routes
app.get('/c/:configId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/c/:configId/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API to save configuration (Instant Sync)
app.post('/api/config/save', async (req, res) => {
    try {
        let { configId, config } = req.body;
        if (!configId) {
            configId = crypto.randomBytes(4).toString('hex');
        }
        
        await saveUserConfig(configId, config);
        
        console.log(`[Config] Configuration saved & synced for configId: ${configId}`);
        res.json({ success: true, configId, config });
    } catch (err) {
        console.error('[Config Error]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API to get configuration
app.get('/api/config/:configId', async (req, res) => {
    const config = await getConfig(req.params.configId);
    res.json({ config });
});

// Handle Nuvio/Stremio gear icon clicks which append /configure or / to the addon base URL
app.get('/:configJSON/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Analytics tracker
const providerAnalytics = new Map();

// Token Verification API
app.get('/api/verify-token/:token', (req, res) => {
    const token = req.params.token;
    const authPath = path.join(__dirname, 'access_tokens.json');
    if (fs.existsSync(authPath)) {
        try {
            const tokens = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            const isValid = tokens.some(t => typeof t === 'string' ? t === token : t.token === token);
            if (isValid) {
                return res.json({ valid: true });
            }
        } catch (e) {
            console.error('Error reading access_tokens.json', e);
        }
    }
    res.json({ valid: false });
});

app.get('/api/analytics', (req, res) => {
    const stats = {};
    for (const [provider, data] of providerAnalytics.entries()) {
        stats[provider] = data;
    }
    res.json(stats);
});

// DoH Resolver Status
app.get('/api/doh/status', (req, res) => {
    res.json(getDohConfig());
});

// Repo manifest proxy — repo hosts like plugin.eclipsia.dpdns.org send no CORS
// headers, so the browser can't fetch them directly. We proxy server-side (Node
// fetch ignores CORS) and relay with permissive headers so the settings UI can
// list repo scrapers.
app.get('/api/repo-manifest', async (req, res) => {
    const url = req.query.url;
    if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'Invalid url' });
    }
    try {
        const r = await axios.get(url, { timeout: 15000 });
        res.set('Access-Control-Allow-Origin', '*');
        res.json(r.data);
    } catch (e) {
        res.status(502).json({ error: 'Failed to fetch repo manifest', detail: e.message });
    }
});

// Automated Vercel Cron Job to keep providers awake
app.get('/api/wakeup', async (req, res) => {
    try {
        // The user's main repository
        const repoUrl = 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json';
        // Loading the providers automatically pings their external servers (Render/Koyeb) to keep them awake!
        await providerLoader.loadProviders(repoUrl);
        console.log('[Cron] Wakeup ping completed successfully.');
        res.status(200).send('Wakeup successful');
    } catch (err) {
        console.error('[Cron] Wakeup failed:', err.message);
        res.status(500).send('Wakeup failed');
    }
});

// Mini-Debrid HTTP Streaming Engine
app.get('/stream/:infoHash/:userId', (req, res) => {
    const userId = req.params.userId;
    const infoHash = req.params.infoHash;

    // Verify User Authorization
    const authPath = path.join(__dirname, 'access_tokens.json');
    let isAuthorized = false;
    
    if (fs.existsSync(authPath)) {
        try {
            const tokens = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            isAuthorized = tokens.some(t => typeof t === 'string' ? t === userId : t.token === userId);
        } catch (e) {
            console.error('Error reading access_tokens.json', e);
        }
    }

    if (!isAuthorized) {
        return res.status(403).send('Unauthorized. Please ensure your Telegram ID is added by the server owner.');
    }

    // Hand off to Torrent Engine
    torrentEngine.handleStreamRequest(req, res);
});

const TMDB_API_KEYS = [
    '439c478a771f35c05022f9feabcca01c',
    '1865f43a0549ca50d341dd9ab8b29f49',
    'e49339e830e014e414c2b9a71b2d4f82',
    '847a158b5489812f851da8cf02476566',
    'b025d23315a6b0c266cc6cb221a68134'
];

async function getTmdbId(imdbId, type) {
    if (imdbId.startsWith('tmdb:')) {
        return imdbId.split(':')[1];
    }
    
    const id = imdbId.split(':')[0];
    
    if (/^\d+$/.test(id)) {
        return id;
    }
    
    if (id.startsWith('tt')) {
        for (const key of TMDB_API_KEYS) {
            try {
                const res = await axios.get(`https://api.themoviedb.org/3/find/${id}?api_key=${key}&external_source=imdb_id`, { 
                    timeout: 4000,
                    headers: { 'Accept': 'application/json' }
                });
                if (type === 'movie' && res.data && res.data.movie_results && res.data.movie_results.length > 0) {
                    return res.data.movie_results[0].id.toString();
                } else if ((type === 'series' || type === 'tv') && res.data && res.data.tv_results && res.data.tv_results.length > 0) {
                    return res.data.tv_results[0].id.toString();
                }
            } catch (err) {
                // try next key
            }
        }
    }
    
    return null;
}

// Normalize provider names so emoji-prefixed variants of the same addon match
// (e.g. "🧲 Torrentio" == "Torrentio" == id "torrentio").
function normalizeProviderKey(name) {
    return String(name || '')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2600}-\u{26FF}\u{FE0F}]/gu, '')
        .replace(/[\s._\-\/\\]+/g, ' ')
        .trim()
        .toLowerCase();
}

function isProviderDisabled(provider, disabledList) {
    if (!Array.isArray(disabledList) || disabledList.length === 0) return false;
    if (disabledList.includes(provider.name)) return true;

    const nameKey = normalizeProviderKey(provider.name);
    const idKey = normalizeProviderKey(provider.id);
    for (const entry of disabledList) {
        if (!entry) continue;
        const entryKey = normalizeProviderKey(entry);
        if (entryKey && (entryKey === nameKey || entryKey === idKey || entryKey === provider.id)) {
            return true;
        }
    }
    return false;
}

// Addon builder factory
function createAddon(config) {
    if (config && config.enableDoh !== undefined) setDohEnabled(config.enableDoh !== false);
    if (config && config.dohProvider) setDohProvider(config.dohProvider);

    let addonId = 'org.nuvio.metasorter';
    let addonName = 'Chole Bhature';
    
    if (config.provider) {
        addonId = `org.nuvio.metasorter.${config.provider.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        addonName = `Chole Bhature | ${config.provider}`;
    } else if (config.repoName) {
        addonId = `org.nuvio.metasorter.repo.${config.repoName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        addonName = `Chole Bhature | ${config.repoName}`;
    }

    const addonLogo = config.addonHost 
        ? `${config.addonProtocol || 'http'}://${config.addonHost}/icon-512.png?v=3` 
        : 'https://raw.githubusercontent.com/yoruix/nuvio-providers/main/public/icon-512.png?v=3';

    const builder = new addonBuilder({
        id: addonId,
        version: '3.0.0',
        name: addonName,
        description: 'Dynamically loads Nuvio providers, tests stream speed, and sorts them.',
        logo: addonLogo,
        catalogs: [],
        resources: ['stream'],
        types: ['movie', 'series', 'anime', 'tv', 'other'],
        idPrefixes: ['tt', 'tmdb:', 'kitsu:'],
        behaviorHints: { configurable: true, configurationRequired: true }
    });

    builder.defineStreamHandler(async ({ type, id }) => {
        console.log(`[Stremio] Request for ${type} ${id} (Addon: ${addonName})`);
        
        let imdbId = id;
        let season = null;
        let episode = null;

        if (type === 'series') {
            const parts = id.split(':');
            if (parts[0] === 'tmdb' && parts[1]) {
                // Preserve the tmdb: prefix so getTmdbId can return it directly
                imdbId = `tmdb:${parts[1]}`;
            } else {
                imdbId = parts[0];
            }
            season = parts[1];
            episode = parts[2];
        }

        const tmdbId = await getTmdbId(imdbId, type);
        if (!tmdbId) {
            console.log('[Stremio] Could not resolve TMDB ID for', imdbId);
            return { streams: [] };
        }

        const cacheKey = `${type}_${id}_${getConfigCacheKey(config)}`;
        const cached = streamCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < STREAM_CACHE_TTL_MS)) {
            console.log(`[Stremio] Serving ${cached.streams.length} streams from cache for ${cacheKey}`);
            return { streams: cached.streams };
        }

        let manifestUrls = [];
        if (config.repoUrl) {
            manifestUrls = [config.repoUrl];
        } else if (config.urls && Array.isArray(config.urls)) {
            manifestUrls = config.urls;
        } else if (config.repos && Array.isArray(config.repos)) {
            manifestUrls = config.repos;
        } else if (config.url) {
            manifestUrls = [config.url];
        }
        
        if (manifestUrls.length === 0) {
            console.log('[Stremio] No repository URLs configured');
            return { streams: [] };
        }

        let allProviders = [];
        for (const url of manifestUrls) {
            try {
                const providers = await providerLoader.loadProviders(url);
                allProviders = allProviders.concat(providers);
            } catch (e) {
                console.error(`[ProviderLoader] Failed to load from ${url}:`, e.message);
            }
        }
        
        // Filter providers
        if (config.provider) {
            allProviders = allProviders.filter(p => p.name === config.provider);
        } else if (config.disabled) {
            allProviders = allProviders.filter(p => !isProviderDisabled(p, config.disabled));
        }

        let allStreams = [];

        // Execute all providers in parallel with a strict timeout
        // Stremio allows up to ~15-20s, we give providers 14s to maximize results
        const PROVIDER_TIMEOUT_MS = 14000;

        await Promise.all(allProviders.map(async (provider) => {
            try {
                let nuvioType = type;
                if (type === 'series' || type === 'tv') nuvioType = 'tv';
                else if (type === 'movie') nuvioType = 'movie';
                else if (type === 'anime') nuvioType = (season && episode) ? 'tv' : 'movie';
                
                const scrapePromise = provider.getStreams(tmdbId, nuvioType, season, episode, config);
                
                // Timeout promise
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Scrape Timeout')), PROVIDER_TIMEOUT_MS)
                );

                const streams = await Promise.race([scrapePromise, timeoutPromise]);
                
                if (Array.isArray(streams)) {
                    streams.forEach(s => s.name = s.name || provider.name);
                    allStreams = allStreams.concat(streams);
                }
            } catch (err) {
                console.error(`[Provider] ${provider.name} failed or timed out:`, err.message);
            }
        }));

        console.log(`[Stremio] Collected ${allStreams.length} total streams. Testing speeds...`);
        const sortedAndTaggedStreams = await sortAndTagStreams(allStreams, {
            hideDead: config.hideDead,
            hideSlow: config.hideSlow,
            hideCam: config.hideCam || config.blockCam,
            sortBy: config.sortBy || (config.prioritizeQuality ? 'quality' : 'speed'),
            sortMode: config.sortMode || config.sortBy,
            prioritizeQuality: config.sortBy === 'quality' || config.prioritizeQuality,
            prioritizeHindi: config.prioritizeHindi,
            preferredLanguages: config.preferredLanguages || (config.prioritizeHindi ? ['Hindi', 'Dual-Audio'] : []),
            showSeeders: config.showSeeders !== false,
            deduplicateStreams: config.deduplicateStreams !== false,
            realDebridKey: config.realDebridKey || getRealDebridKey()
        }, providerAnalytics);

        // Only cache non-empty results (an empty array usually means provider hiccup —
        // we don't want to pin that for 30 min and hide newly-available streams).
        if (sortedAndTaggedStreams.length > 0) {
            streamCache.set(cacheKey, { timestamp: Date.now(), streams: sortedAndTaggedStreams });
            if (streamCache.size > STREAM_CACHE_MAX_ENTRIES) {
                const oldest = streamCache.keys().next().value;
                streamCache.delete(oldest);
            }
        }

        return { streams: sortedAndTaggedStreams };
    });

    // No catalogs defined

    return builder.getInterface();
}

const { getRouter } = require('stremio-addon-sdk');

app.use('/c/:configId', async (req, res, next) => {
    // Only intercept Stremio API routes
    if (req.path === '/manifest.json' || req.path.startsWith('/stream/') || req.path.startsWith('/catalog/')) {
        try {
            const { configId } = req.params;
            // Fall back to Redis when this Vercel instance hasn't loaded the config yet,
            // so a fresh cold start does NOT silently fall back to the all-enabled default
            // (which is what made disabled addons "come back" on Vercel).
            const config = await getConfig(configId) || {};
            config.configId = configId;
            config.addonHost = req.headers.host;
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            config.addonProtocol = protocol.split(',')[0].trim();
            
            const addonInterface = createAddon(config);
            const router = getRouter(addonInterface);
            return router(req, res, next);
        } catch (err) {
            console.error('[Router Error /c/:configId]', err);
            return res.status(400).send('Invalid configuration');
        }
    }
    next();
});

app.use('/:configJSON', (req, res, next) => {
    // Only intercept Stremio API routes
    if (req.path === '/manifest.json' || req.path.startsWith('/stream/') || req.path.startsWith('/catalog/')) {
        try {
            const config = JSON.parse(decodeURIComponent(req.params.configJSON));
            config.addonHost = req.headers.host;
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            config.addonProtocol = protocol.split(',')[0].trim();
            
            const addonInterface = createAddon(config);
            const router = getRouter(addonInterface);
            
            // Override req.url so the internal router matches /manifest.json or /stream/...
            return router(req, res, next);
        } catch (err) {
            console.error('[Router Error]', err);
            return res.status(400).send('Invalid configuration');
        }
    }
    next();
});

const PORT = process.env.PORT || 7000;
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Stremio Nuvio Meta-Sorter Addon running at http://localhost:${PORT}`);
        console.log(`Configure at http://localhost:${PORT}/configure`);
    });
}

// Export the app for Vercel Serverless Functions
module.exports = app;


