# Task 2 Report — Synthetic probe runner + cron + API

**Plan:** `docs/superpowers/plans/2026-08-22-status-parity.md` Task 2
**Status:** DONE
**Date:** 2026-08-22

## Summary
Implemented `probeStatus.js` synthetic probe runner, `GET /api/provider-status` and `GET /api/cron/provider-status` endpoints, and `vercel.json` cron schedule per plan Task 2. Probe loads manifest URLs expanded from `DEFAULT_REPO_URLS`, probes 5 reference titles in parallel per provider with `Promise.race` 8000 ms timeout, aggregates `up=streamsFound>0`, and persists via `saveProviderStatus`. Global 50 s cap and 16-concurrency batching respect Vercel function limits; existing `/api/analytics` kept intact.

## Files Changed
- `probeStatus.js` (new) — `probeAllProviders(opts)`, `probeProvider(provider)`, constants `DEFAULT_REPO_URL`, `DEFAULT_REPO_URLS`, `REFERENCE_TITLES`, `PER_PROVIDER_TIMEOUT_MS=8000`, `GLOBAL_TIMEOUT_MS=50000`, `CONCURRENCY=16`
- `index.js:4` — added `require('./probeStatus').probeAllProviders`
- `index.js:224` — `loadProviderStatus().catch(()=>{})` on boot to hydrate cache
- `index.js:439-461` — added `GET /api/provider-status` (sorted array from `getAllProviderStatus`) and `GET /api/cron/provider-status` (optional `X-Cron-Secret`/`Authorization: Bearer`/`?secret=` check against `process.env.CRON_SECRET`, then `probeAllProviders()`)
- `vercel.json` — added `crons: [{path:"/api/cron/provider-status", schedule:"*/30 * * * *"}]`

## Probe Logic
```js
// For each provider, in parallel over REFERENCE_TITLES (872585 Oppenheimer, 278 Shawshank, 155 Dark Knight, 27205 Inception, 157336 Interstellar):
streams = await Promise.race([provider.getStreams(tmDbId, 'movie', null, null, {}), timeout 8000])
// Aggregate: streamsFound = sum(length), titles = titles with count>0, up = streamsFound>0, latencyMs = wall time, updatedAt = Date.now()
// Per-provider wall cap 14s via Promise.race, concurrency 16 via batched Promise.allSettled, global 50s cap via Promise.race
// Deduplicate providers by case-insensitive name; save via saveProviderStatus(name, {up, streamsFound, latencyMs, titles, updatedAt})
// Returns {probed, up, down}
```

## Interfaces Produced
- `probeAllProviders(opts?: {repoUrls?: string[], saveProviderStatus?: Function}): Promise<{probed:number, up:number, down:number}>`
- `GET /api/provider-status` → `200 [{name, up, streamsFound, latencyMs, titles, updatedAt}, ...]` sorted by name
- `GET /api/cron/provider-status` → `200 {ok:true, probed, up, down, timestamp}` or `401 {error:'Unauthorized'}` when `CRON_SECRET` set and secret mismatch; `500` on probe failure

## Verification
1. **Provider-status empty before probe:**
   ```
   GET /api/provider-status → 200 []  PASS
   ```
2. **Mock probe (3 providers, deduped 2):**
   ```
   probeAllProviders({repoUrls:['http://a/manifest.json','http://b/manifest.json']})
   → {probed:2, up:1, down:1}  PASS
   MockUp up:true streamsFound:10 titles length 5, MockDown up:false  PASS
   GET /api/provider-status after probe → 3 entries sorted  PASS
   ```
3. **Timeout handling (15s hang → 8s per-title timeout → down):**
   ```
   MockTimeout streamsFound:0 up:false latencyMs~8009  PASS
   ```
4. **Cron secret:**
   ```
   CRON_SECRET=s3cr3t, no header → 401 PASS
   wrong secret → 401 PASS
   X-Cron-Secret:s3cr3t → 200 {ok:true, probed:1, up:1} PASS
   CRON_SECRET unset, no header → 200 PASS
   ```
5. **Regression:**
   ```
   GET /api/analytics → 200 object  PASS
   node test/test-provider-status-store.js → PASS
   ```
6. **Global constraints:**
   - Per-title `Promise.race` 8000 ms implemented `probeStatus.js:42-45`
   - Per-provider 14s cap `probeStatus.js:121-124`
   - Concurrency 16 batched `probeStatus.js:114`
   - Global 50s cap `probeStatus.js:151`
   - `vercel.json` cron `*/30 * * * *` added, `/api/analytics` unchanged

## Notes
- `probeStatus.js` lazy-requires `saveProviderStatus` from `./index` inside `probeAllProviders` to avoid circular top-level require (`index.js` requires `probeStatus.js` at top). Optional `opts.saveProviderStatus` injection for testing.
- `loadProviderStatus()` called non-blocking at boot (fire-and-forget) alongside `loadUserConfigs()` so cold starts hydrate cache without blocking listen.
- Vercel Hobby cron limit noted in plan: `crons` requires Pro; fallback is external ping to `/api/cron/provider-status` with `CRON_SECRET` — endpoint works without Vercel Cron.

## Next Task
Task 3 Status tab UI consumes `GET /api/provider-status`.
