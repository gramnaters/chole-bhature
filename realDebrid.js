const axios = require('axios');
const crypto = require('crypto');

const API_BASE = 'https://api.real-debrid.com/rest/1.0';

const linkCache = new Map();      // hash(lowercase) -> { url, ts }  resolved direct CDN links
const negativeCache = new Map();  // hash(lowercase) -> { ts }       known unavailable (short TTL)
const inFlight = new Map();       // hash(lowercase) -> Promise       dedupe concurrent resolutions

const CACHE_TTL = 12 * 60 * 60 * 1000;    // positive cache: 12h
const NEGATIVE_TTL = 10 * 60 * 1000;      // negative cache: 10min
const POLL_INTERVAL = 1500;
const POLL_MAX_WAIT = 6000;               // cached torrents resolve in 1-3s; give up fast on uncached

const MAX_CONCURRENT = 3;                 // semaphore: at most 3 RD flows at once
const ATTEMPT_WINDOW_MS = 60 * 1000;      // sliding window for attempt rate cap
const MAX_ATTEMPTS_PER_WINDOW = 8;        // bound unique-hash RD API calls per request burst

// Shared Redis layer (same Upstash instance used for config persistence). In-memory Maps stay
// the fast L1; Redis is the L2 shared across Vercel instances and survives cold starts. Keyed by
// (hash, RD key) because unrestrict/link URLs are account-bound — never serve one user's link
// to another account. Wired in by index.js via setRedis().
const REDIS_LINK_PREFIX = 'nuvio:rdlink:';
const REDIS_NEG_PREFIX = 'nuvio:rdneg:';
let redis = null;

function setRedis(client) {
    redis = client;
}

function redisCacheKey(hash, key) {
    const keyHash = crypto.createHash('sha1').update(key || '').digest('hex').slice(0, 12);
    return hash + ':' + keyHash;
}

let active = 0;
const queue = [];
const attemptTimes = [];

async function withSemaphore(fn) {
    if (active >= MAX_CONCURRENT) {
        await new Promise(resolve => queue.push(resolve));
    }
    active++;
    try {
        return await fn();
    } finally {
        active--;
        if (queue.length) queue.shift()();
    }
}

function allowAttempt() {
    const now = Date.now();
    while (attemptTimes.length && now - attemptTimes[0] > ATTEMPT_WINDOW_MS) attemptTimes.shift();
    if (attemptTimes.length >= MAX_ATTEMPTS_PER_WINDOW) return false;
    attemptTimes.push(now);
    return true;
}

async function rdRequest(path, key, method = 'GET', body = null) {
    try {
        const res = await axios({
            method,
            url: API_BASE + path,
            headers: {
                'Authorization': 'Bearer ' + key,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: body,
            timeout: 15000,
            validateStatus: () => true
        });
        const data = res.data;
        if (typeof data === 'string') {
            try { return JSON.parse(data); } catch (e) { return null; }
        }
        return data;
    } catch (e) {
        return null;
    }
}

async function checkKey(key) {
    const data = await rdRequest('/user', key);
    if (!data || data.type !== 'premium') return { valid: false, data: data || null };
    return { valid: true, data };
}

function pickVideoLink(info) {
    const VIDEO_EXT = /\.(mkv|mp4|avi|webm|mov|m4v|ts|flv|wmv|mpg|mpeg|3gp|ogv)$/i;
    if (info && Array.isArray(info.files) && Array.isArray(info.links)) {
        for (let i = 0; i < info.files.length; i++) {
            const p = (info.files[i] && info.files[i].path) || '';
            if (VIDEO_EXT.test(p)) return info.links[i] || null;
        }
    }
    if (info && Array.isArray(info.links) && info.links.length > 0) return info.links[0];
    return null;
}

async function resolveHash(hash, key) {
    const magnet = 'magnet:?xt=urn:btih:' + hash;
    const add = await rdRequest('/torrents/addMagnet', key, 'POST', 'magnet=' + encodeURIComponent(magnet));
    if (!add || !add.id) return null;

    // RD auto-selects on newer accounts; ignore action_already_done
    await rdRequest('/torrents/selectFiles/' + add.id, key, 'POST', 'files=all');

    const deadline = Date.now() + POLL_MAX_WAIT;
    let info = null;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        info = await rdRequest('/torrents/info/' + add.id, key);
        if (!info) continue;
        if (info.status === 'downloaded') break;
        if (info.status === 'error') return null;
    }
    if (!info || info.status !== 'downloaded') return null;

    const hostLink = pickVideoLink(info);
    if (!hostLink) return null;

    const unrestrict = await rdRequest('/unrestrict/link', key, 'POST', 'link=' + encodeURIComponent(hostLink));
    const direct = unrestrict && (unrestrict.download || unrestrict.link);
    return direct || null;
}

async function resolveStream(hash, key) {
    hash = (hash || '').toLowerCase();
    if (!hash || !key) return null;

    const now = Date.now();

    // L1: in-memory caches (fast path, no Redis round-trip)
    const hit = linkCache.get(hash);
    if (hit && now - hit.ts < CACHE_TTL) return hit.url;

    const neg = negativeCache.get(hash);
    if (neg && now - neg.ts < NEGATIVE_TTL) return null;

    if (inFlight.has(hash)) return inFlight.get(hash);

    // L2: shared Redis cache (cross-instance, survives cold starts)
    if (redis) {
        const redisKey = redisCacheKey(hash, key);
        try {
            const redisHit = await redis.get(REDIS_LINK_PREFIX + redisKey);
            if (redisHit) {
                linkCache.set(hash, { url: redisHit, ts: Date.now() });
                return redisHit;
            }
            const redisNeg = await redis.get(REDIS_NEG_PREFIX + redisKey);
            if (redisNeg) {
                negativeCache.set(hash, { ts: Date.now() });
                return null;
            }
        } catch (e) {
            console.warn('[RD] Redis cache read failed:', e.message);
        }
    }

    if (!allowAttempt()) return null;

    const p = withSemaphore(async () => {
        try {
            const url = await resolveHash(hash, key);
            if (url) {
                linkCache.set(hash, { url, ts: Date.now() });
                if (redis) {
                    const redisKey = redisCacheKey(hash, key);
                    try {
                        await redis.set(REDIS_LINK_PREFIX + redisKey, url, { ex: CACHE_TTL / 1000 });
                    } catch (e) {
                        console.warn('[RD] Redis link cache write failed:', e.message);
                    }
                }
                return url;
            }
            negativeCache.set(hash, { ts: Date.now() });
            if (redis) {
                const redisKey = redisCacheKey(hash, key);
                try {
                    await redis.set(REDIS_NEG_PREFIX + redisKey, '1', { ex: NEGATIVE_TTL / 1000 });
                } catch (e) {}
            }
            return null;
        } catch (e) {
            negativeCache.set(hash, { ts: Date.now() });
            return null;
        } finally {
            inFlight.delete(hash);
        }
    });
    inFlight.set(hash, p);
    return p;
}

function clearCache() {
    linkCache.clear();
    negativeCache.clear();
}

module.exports = { checkKey, resolveStream, clearCache, setRedis };
