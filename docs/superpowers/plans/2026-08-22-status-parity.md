# Status Tab Full Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PenguPlay-parity live Status tab with 30-min synthetic probes, replacing the minimal analytics view.

**Architecture:** A Vercel Cron job runs every 30 min, probes 5 reference titles (Oppenheimer/Shawshank etc) against every loaded provider in parallel (14s timeout each), writes per-provider {up, down, streamsFound, latencyMs, titles[], updatedAt} to Turso `provider_status` table + in-memory cache. Frontend Status tab fetches `GET /api/provider-status` and renders 4 summary cards + filterable provider rows matching the reference screenshots (UP/DOWN pills, title chips, ms).

**Tech Stack:** Node, Turso libSQL, Vercel Cron (vercel.json crons), Express, vanilla JS

**Spec:** User screenshots 2026-08-22 + "Full parity (needs one cron) is a good one" chat; reference PenguPlay status (16 sources display, filters All/Up/Down, rows with UP/DOWN pills)

## Global Constraints
- Vercel Hobby cron max 1 run per day on free? Use `crons` in vercel.json with `schedule: "*/30 * * * *"` — requires Pro; fallback is setInterval + /api/cron endpoint hit by external ping if Hobby
- Do not break existing `/api/analytics` (fast/slow/dead) — keep it, add new `/api/provider-status`
- Provider probing must not exceed Vercel function 10s (Hobby) / 60s (Pro) — parallel batched with 14s per-provider timeout but overall wall time must fit; use `Promise.allSettled` with concurrency 16 and global 50s cap

---

### Task 1: Turso schema + probe store

**Files:**
- Modify: `index.js:124-144` (add `ensureProviderStatusTable`, `saveProviderStatus`, `loadProviderStatus`)
- Test: `test/test-provider-status-store.js` (new)

**Interfaces:**
- Consumes: `turso`
- Produces: `providerStatusCache Map<string, {up:boolean, streamsFound:number, latencyMs:number, titles:string[], updatedAt:number}>`; functions `ensureProviderStatusTable():Promise<void>`, `saveProviderStatus(name, status)`, `loadProviderStatus()`

- [ ] **Step 1: Write the failing test** `test/test-provider-status-store.js`
```js
const { ensureProviderStatusTable, saveProviderStatus } = require('../index.js');
async function test(){ await ensureProviderStatusTable(); await saveProviderStatus('4KHDHub', {up:true, streamsFound:3, latencyMs:4200, titles:['Oppenheimer'], updatedAt: Date.now()}); const r=await (require('../index.js').getProviderStatus('4KHDHub')); console.assert(r.up===true); }
test();
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node test/test-provider-status-store.js`
Expected: FAIL "ensureProviderStatusTable not defined"

- [ ] **Step 3: Write minimal implementation**
```js
const providerStatusCache = new Map();
async function ensureProviderStatusTable(){
  if(!turso) return;
  await turso.execute(`CREATE TABLE IF NOT EXISTS provider_status (name TEXT PRIMARY KEY, up INTEGER, streamsFound INTEGER, latencyMs INTEGER, titles TEXT, updatedAt INTEGER)`);
}
async function saveProviderStatus(name, s){
  providerStatusCache.set(name, s);
  if(turso) await turso.execute({sql:'INSERT OR REPLACE INTO provider_status(name,up,streamsFound,latencyMs,titles,updatedAt) VALUES(?,?,?,?,?,?)', args:[name, s.up?1:0, s.streamsFound, s.latencyMs, JSON.stringify(s.titles), s.updatedAt]});
}
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**
```bash
git add index.js test/test-provider-status-store.js
git commit -m "feat: provider_status store"
```

### Task 2: Synthetic probe runner + cron + API

**Files:**
- Create: `probeStatus.js` (probe logic)
- Modify: `index.js:400-420` (add `GET /api/provider-status`, `GET /api/cron/provider-status`, wire `providerLoader`, `STREAM_TIMEOUT`)
- Modify: `vercel.json` (add `crons: [{path:"/api/cron/provider-status", schedule:"*/30 * * * *"}]`)
- Test: `test/test-provider-status-api.js`

**Interfaces:**
- Consumes: `providerLoader.loadProviders`, `provider.getStreams`, `saveProviderStatus`
- Produces: `async function probeAllProviders(): Promise<{probed:number, up:number, down:number}>`; endpoints

- [ ] **Step 1: Write failing test** – fetch `/api/provider-status` expects `[]` before probe, after probe has entries
- [ ] **Step 2: Implement probeAllProviders** – load manifest URLs from config (DEFAULT_REPO_URL expanded via load), for each provider: `await Promise.race([provider.getStreams(Oppenheimer,movie), timeout 8000])` track streamsFound, latency, up=streamsFound>0, save
- [ ] **Step 3: Add endpoints** with optional cron secret check `X-Cron-Secret === process.env.CRON_SECRET`
- [ ] **Step 4: Verify** `curl /api/provider-status` returns 200 with array
- [ ] **Step 5: Commit**

### Task 3: Status tab UI (replaces analytics provider grid, keeps 3 metric cards)

**Files:**
- Modify: `public/index.html:637-660` (add Status header with Open full page -> /status, summary cards Sources/Up/Down/Streams found, filter pills All/Up/Down, provider rows)
- Test: `public/index.html` manual — visit `/analytics`, check filters

**Interfaces:**
- Consumes: `GET /api/provider-status`
- Produces: renders rows with UP (green) pill + title chips + `streams + latency + 45m ago`

- [ ] **Step 1: Write UI markup** – 4 summary cards above existing 3 metric cards or merged
- [ ] **Step 2: Implement render** – filter logic, pill colors, chips, ms display, updatedAt relative
- [ ] **Step 3: Manual verify** in browser
- [ ] **Step 4: Commit**

