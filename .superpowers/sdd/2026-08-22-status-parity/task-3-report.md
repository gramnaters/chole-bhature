# Task 3 Report — Status tab UI

**Plan:** `docs/superpowers/plans/2026-08-22-status-parity.md` Task 3
**Status:** DONE
**Date:** 2026-08-22

## Summary
Replaced analytics provider grid with live Status UI consuming `GET /api/provider-status`, while keeping the 3 existing health metric cards (Scraper Uptime / Avg Resolve Time / Cache Hit Rate). Added Status header with "Open full page → /status", 4 probe-summary cards (Sources/Up/Down/Streams found), filter pills All/Up/Down, and provider rows with UP/DOWN pill + title chips + latency + updatedAt relative time. Added `/status` route and updated nav/popstate to treat `/status` as the Status tab.

## Files Changed
- `public/index.html` — Task 3 edits:
  - Header `public/index.html:636-652`: Changed section `id="section-analytics"` heading from "Analytics" to "Status" with subtitle "Live provider health from synthetic probes (30 min cadence)" and `btn Open full page ↗ → /status`.
  - CSS `public/index.html:545-575`: Added `.status-summary` (4-col grid, 2-col on mobile), `.ps-pill.up/down` (green/red pills), `.prov-status-row`, `.ps-chips/.ps-chip`, `.ps-right .lat`, `.status-filter-row` etc.
  - JS nav `public/index.html:1167-1210`: Added `isStatusPath()` helper (`/analytics` or `/status`), updated `setupNavTabs()` click handler and `popstate` to toggle Status tab for both paths; auto-open handler now triggers for `/analytics` or `/status`.
  - JS status helpers `public/index.html:1321-1360`: Added `_statusData`, `_statusFilter`, `formatRelativeTime(ts)` (m ago / h ago / d ago), `renderStatusList()` (filter All/Up/Down, UP/DOWN pill, title chips, `streamsFound + latencyMs + updatedAt`), `setupStatusFilters()` (seg Active toggle → re-render).
  - JS `loadAnalytics()` `public/index.html:1362-1440`: Now fetches `/api/health` + `/api/analytics` + `/api/provider-status` in parallel; keeps 3 health cards + Refresh button; appends 4-card probe summary (`Sources/Up/Down/Streams found` aggregates), filter seg `All/Up/Down` with `status-summary-meta` count, and `div#status-list` rows. Legacy `fast/slow/dead` grid only shown when `providerStatus.length===0 && analytics keys>0` as fallback.
- `index.js:427-432`: Added `app.get('/status', …)` serving `public/index.html` (cache `no-store`) alongside existing `/analytics` route for full-page deep link.

## Interfaces Consumed / Produced
- Consumes: `GET /api/provider-status` → `[{name, up, streamsFound, latencyMs, titles:string[], updatedAt}]` sorted by name (from Task 2).
- Produces: Renders rows `<span class="ps-pill up|down">UP/DOWN</span> + <div class="ps-name">name</div> + <div class="ps-chips"><span class="ps-chip">Title</span>…</div> + <div class="ps-right"><span>Ns streams</span> <span class="lat">Nms</span> <span>Xm ago</span></div>` with `streams + latency + 45m ago` parity to reference screenshots.
- Filter: `All` shows all, `Up` filters `p.up===true`, `Down` filters `p.up===false`; pills colors `up=green #30d158 bg rgba(48,209,88,0.12)`, `down=red var(--red) bg rgba(255,69,58,0.12)`.

## Verification
1. **HTML structure:**
   ```
   html bytes 90419
   contains "Provider Status" ✓, "/status" ✓, "status-summary" ✓, "Scraper Uptime" ✓
   ```
2. **Syntax:**
   ```
   node --check index.js → ok
   node --check probeStatus.js → ok
   ```
3. **API integration (via http server):**
   ```
   GET /api/provider-status → 200 [] (empty before probe) PASS
   GET /status → 200 text/html PASS
   GET /analytics → 200 PASS
   saveProviderStatus('TestProvX', {up:true, streamsFound:5, latencyMs:1234, titles:['Oppenheimer','Inception'], updatedAt:Date.now()})
   GET /api/provider-status → [{name:'TestProvX', up:true, streamsFound:5, latencyMs:1234, titles:['Oppenheimer','Inception'], updatedAt:…}] PASS
   saveProviderStatus('DownProv', {up:false, streamsFound:0, latencyMs:8000, titles:[], updatedAt:Date.now()-45m})
   GET /api/provider-status → 2 entries sorted ['DownProv','TestProvX'] with correct up/down PASS
   ```
4. **Metric cards kept:**
   - `Scraper Uptime`, `Avg Resolve Time`, `Cache Hit Rate` cards still rendered from `loadAnalytics()` health/analytics fetch before status section — verified by `h.includes('Scraper Uptime')` and code retains all 3 card HTML blocks unchanged.
5. **Manual check (expected):** Visit `/analytics` or `/status` → Analytics nav active, Status header + Open full page link visible, 3 health cards, 4 summary cards (Sources/Up/Down/Streams found), filter pills All/Up/Down toggle, rows show UP green pill or DOWN red pill + title chips + `5 streams 1234ms just now` / `0 streams 8000ms 45m ago`.

## Notes
- No breaking change to `/api/analytics`; status rows replace the analytics `fast/slow/dead` grid only when probe data exists — fallback preserves legacy grid when probes not yet run.
- `/status` is a static HTML alias for `/analytics` (same SPA section); Vercel routing via `vercel.json` `routes: [{src:"/(.*)", dest:"index.js"}]` already proxies unknown paths to Express, but explicit Express `app.get('/status')` ensures correct Cache-Control and avoids SPA 404 on direct navigation.
- Relative time uses `Date.now() - updatedAt`; future timestamps clamp to "just now".

## Next
Plan complete — Task 1 (store) + Task 2 (probe+cron+API) + Task 3 (Status UI) done.
