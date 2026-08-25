# Rate-Limit, Admin Analytics, FORCE REFRESH Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 3 configs/day/IP rate limit, admin-only user records management in Analytics, and minimalistic FORCE REFRESH stream card matching the Nuvio dark theme.

**Architecture:** Rate limit uses Turso `rate_limits(ip, day, count)` checked atomically in `POST /api/config/save`. Admin gate uses `ADMIN_TOKEN` env (fallback to existing accessToken) checked via `X-Admin-Token` header; new endpoints `GET /api/admin/users` and `DELETE /api/admin/users/:id` read/delete Turso `configs`. FORCE REFRESH stream is rendered as a minimal card via `getForceRefreshStream()` with SVG icon, muted border, no emoji spam.

**Tech Stack:** Node/Express, Turso libSQL, vanilla JS (public/index.html), Vercel serverless

**Spec:** User chat 2026-08-22 (rate limit 3/day/IP, admin user DB in Analytics deletable, FORCE REFRESH keep-at-top but minimalistic theme, tail-latency proof deferred)

## Global Constraints
- Turso is source of truth for configs; do not break existing `urls`/`repos` mapping
- public/index.html is single-page; Analytics section is `#section-analytics`
- Preserve `POST /api/config/save` shape `{configId, config}` response `{success, configId}`
- No new npm dependencies unless trivial

---

### Task 1: Rate Limit 3/day/IP on POST /api/config/save

**Files:**
- Modify: `index.js:271-286` (save handler)
- Modify: `index.js:124-144` (add `ensureRateLimitsTable()` called in `loadAllConfigsFromTurso`)
- Test: `test/test-rate-limit.js` (new)

**Interfaces:**
- Consumes: `req.headers['x-forwarded-for']`, `turso.execute()`
- Produces: `429 {success:false, error:'Rate limit: 3 configs per day'}` when exceeded; helper `getClientIp(req): string` and `getToday(): string YYYY-MM-DD`

- [ ] **Step 1: Write the failing test** `test/test-rate-limit.js`
```js
const { getClientIp } = require('../index.js'); // or inline helper
// simulate 4 saves from same IP same day -> 4th should 429
```

- [ ] **Step 2: Run test to verify it fails**
Run: `node test/test-rate-limit.js -v`
Expected: FAIL (helper not exported / no 429)

- [ ] **Step 3: Write minimal implementation** in `index.js`
```js
function getClientIp(req){
  const fwd = req.headers['x-forwarded-for'];
  if(fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.ip || 'unknown';
}
function getToday(){ return new Date().toISOString().slice(0,10); }
async function ensureRateLimitsTable(){
  if(!turso) return;
  await turso.execute(`CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT, day TEXT, count INTEGER, PRIMARY KEY(ip, day))`);
}
async function checkRateLimit(ip){
  const day=getToday();
  const r=await turso.execute({sql:'SELECT count FROM rate_limits WHERE ip=? AND day=?', args:[ip,day]});
  const c=r.rows[0]?.count||0;
  if(c>=3) return false;
  await turso.execute({sql:'INSERT INTO rate_limits(ip,day,count) VALUES(?,?,1) ON CONFLICT(ip,day) DO UPDATE SET count=count+1', args:[ip,day]});
  return true;
}
// in save handler before saveUserConfig:
const ip=getClientIp(req);
if(turso && !(await checkRateLimit(ip))) return res.status(429).json({success:false, error:'Rate limit: 3 configs per day'});
```

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** `feat: rate limit 3/day/IP on config save`

### Task 2: Admin User Records in Analytics (list + delete, admin-only)

**Files:**
- Modify: `index.js:300-330` (add GET /api/admin/users, DELETE /api/admin/users/:configId)
- Modify: `public/index.html:1140-1170` (analytics section: admin gated UI, user DB table)
- Test: manual with `ADMIN_TOKEN` env

**Interfaces:**
- Consumes: `ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ACCESS_TOKEN || ''`, `turso configs`
- Produces: `GET /api/admin/users -> {users:[{configId, updatedAt, repoCount, providerCount, sortBy}]}`, `DELETE /api/admin/users/:id -> {success}`; header `X-Admin-Token`

- [ ] **Step 1: Write failing check** `curl -H "X-Admin-Token: wrong" GET /api/admin/users -> 401`
- [ ] **Step 2: Implement endpoints** with `requireAdmin(req,res,next)` middleware
- [ ] **Step 3: Implement analytics UI**: hidden unless admin token present in localStorage; prompt for token if not; list table with Delete buttons calling DELETE endpoint; refresh after delete
- [ ] **Step 4: Manual verify** with correct token
- [ ] **Step 5: Commit** `feat: admin user DB in analytics`

### Task 3: Redesign FORCE REFRESH Stream Card

**Files:**
- Modify: `index.js:539-546` (getForceRefreshStream)
- Modify: `public/index.html` (no change needed; stream rendered by Stremio, but card design is backend `name/title/externalUrl`)
- Test: fetch `/c/{id}/stream/movie/tt0111161.json` and inspect first stream

**Interfaces:**
- Consumes: `config.addonHost/addonProtocol`
- Produces: stream `{name:'↻ Refresh', title:'... minimal', externalUrl:...}` with muted styling via Stremio's rendering (cannot fully style; keep text minimal, icon subtle)

- [ ] **Step 1: Update getForceRefreshStream** to minimalistic:
```js
return {
  name: '↻ Refresh',
  title: 'Clear cache · Tap then Refresh in Stremio',
  externalUrl: `...`
};
```
Match existing dark theme: single-char icon, short title, no emoji spam, keep at position 0.

- [ ] **Step 2: Verify** stream list still has it at top, other streams below
- [ ] **Step 3: Commit** `style: minimalistic FORCE REFRESH stream`

---
## Tail Latency (deferred, proof provided, no code change this plan)
- Proof already gathered: P95 ~18-21s across providers (see stress-results.json). Recommendation: keep current 14s per-provider timeout (already optimal), optionally add progressive response later. No task in this plan.
