const axios = require('axios');

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
    const hit = linkCache.get(hash);
    if (hit && now - hit.ts < CACHE_TTL) return hit.url;

    const neg = negativeCache.get(hash);
    if (neg && now - neg.ts < NEGATIVE_TTL) return null;

    if (inFlight.has(hash)) return inFlight.get(hash);

    if (!allowAttempt()) return null;

    const p = withSemaphore(async () => {
        try {
            const url = await resolveHash(hash, key);
            if (url) {
                linkCache.set(hash, { url, ts: Date.now() });
                return url;
            }
            negativeCache.set(hash, { ts: Date.now() });
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

module.exports = { checkKey, resolveStream, clearCache };
