Agent completed. agent_id: team-review, agent_type: general-purpose, status: completed, description: Hivemind team reviews MVP decisions, elapsed: 275s, total_turns: 0, duration: 226s

I now have full context across all docs and current codebase. Here's the full hivemind review:

---

## 🐕 EDOG Playground — Hivemind MVP Review

---

### Sana Reeves (Tech Lead — Architecture)

**Questions:**
1. **F04 Runtime View ships 7 NEW interceptors via WebSocket over ONE connection.** What's the message routing/multiplexing strategy? Right now `EdogLogServer` broadcasts to all connections. With 11 message types (`log`, `telemetry`, `token`, `fileop`, `spark`, `cache`, `http`, `retry`, `flag`, `di`, `perf`), does the client subscribe per-type, or does every tab receive every message? At 1000 logs/sec + file ops + token events, unfiltered broadcast will saturate the WebSocket.
2. **F02 says deploy logic runs "embedded in web server" (single process).** Our web server is the C# `EdogLogServer` running inside FLT. But deploy LAUNCHES FLT — so deploy can't run inside FLT. This is a circular dependency. Deploy must run in the Python layer (`edog.py` or the dev-server). The doc contradicts itself. Which process actually owns deploy?
3. **Cross-cutting: MWC auto-generate on workspace expand** means we fire N `generatemwctoken` POST requests (one per lakehouse) the moment a workspace node expands. If a workspace has 10 lakehouses, that's 10 concurrent token requests. Is the redirect host rate-limited? The API reference mentions `10 req/sec` rate limits. We could blow past that instantly.

**Concerns:**
- **Phase ordering of F04 sub-views is risky.** Phase A (Logs + Telemetry) exists. Phase B (System Files + Tokens) needs 2 new interceptors + DI changes + 2 new tab UIs. Phase C is 5 more interceptors. Shipping all of F04 "this week" is unrealistic — we should explicitly label Phase C as post-MVP.
- **No IPC protocol defined between Python dev-server and C# EdogLogServer.** The startup doc shows `edog.py → Playwright → Bearer → Dashboard` but never specifies how the Python process hands the Bearer token to the JS frontend or how deploy commands flow. Is it HTTP? File-based? Environment variable?

**Suggestions:**
- Define a WebSocket subscription protocol: client sends `{ "subscribe": ["log", "token", "fileop"] }` and server only routes matching messages. This is critical for performance.
- Split F02 clearly: Python owns `config update → patch → dotnet build → launch`. C# EdogLogServer owns `status reporting + restart`. Don't conflate them.

---

### Kael Andersen (UX Lead — Interaction Design)

**Questions:**
1. **F04 layout: "Internals" dropdown with 7 sub-views.** That's a LOT of hidden functionality behind one dropdown. Has anyone mapped the usage frequency? If engineers use Tokens and HTTP Pipeline constantly (they will during auth debugging), burying them under a dropdown adds a click to every access. Should Tokens be a top-level tab instead of an Internal?
2. **F06 asks about sidebar badges (red dot on Logs for errors).** This is a critical UX decision. A red dot that's ALWAYS on (because there are always warnings in FLT logs) becomes noise. What's the threshold? Only unread errors? Only errors since last view? This needs a clear rule or it'll be useless on day one.
3. **F07 Command Palette: fuzzy match vs prefix match?** Fuzzy match, obviously — it's 2026. But the deeper question: what's the ranking algorithm? `deploy TestLH` should match "Deploy to TestLH" higher than "Deploy to TestLabHouse". Position-weighted fuzzy with recency boost.

**Concerns:**
- **F04 Token Inspector shows TTL countdown, JWT decode, AND a stream — in one tab.** That's three distinct information panels competing for vertical space. On a 1080p monitor (some engineers still have these), the "Active Tokens" panel + "Token Stream" + "JWT Decode" won't fit without scrolling. Need to decide: is JWT decode a slide-out panel? An overlay? A separate sub-tab?
- **"No security restrictions" for content visibility** means we show full file contents, full token claims. That's fine for localhost, but if someone screenshots this for a Teams chat, JWT claims with OIDs and tenant IDs are visible. Consider a "redact mode" toggle for presentations.

**Suggestions:**
- Promote **Tokens** and **HTTP Pipeline** to top-level tabs in the Runtime View. Engineers debugging auth or API issues will live in these. The remaining 5 Internals (Caches, Retries, Flags, DI, Perf) are genuinely deep-debug and can stay in the dropdown.
- For System Files open question: show READs by default but with a toggle to hide them. "What did it look for?" is the most common file system debugging question.
- Internals dropdown should absolutely remember last-selected sub-view (localStorage, keyed by session).

---

### Zara Okonkwo (Sr. Frontend JS — Rendering & WebSocket)

**Questions:**
1. **PERFORMANCE_ARCHITECTURE says Web Worker for log processing, but F04 adds 10 more stream types.** Does each stream type get its own ring buffer in the worker? Or one unified buffer with type tags? The worker architecture was designed for logs only. Extending it to handle token events, file ops, cache events, HTTP waterfall data, AND logs requires a rethink of the worker message protocol.
2. **F04 HTTP Pipeline sub-view wants a "waterfall chart like Chrome DevTools Network."** That's an SVG/Canvas rendering challenge — not a simple virtual-scrolled list. Waterfall requires: horizontal time axis, request bars with DNS/connect/TTFB/download segments, correlation lines. Is this MVP or post-MVP? Building a Chrome DevTools Network clone in vanilla JS is a multi-day effort alone.
3. **Lazy view loading (PERFORMANCE_ARCHITECTURE Shift 1) + F04's 11 sub-views:** Are the Internals sub-views each their own lazy script block? Or does the entire Runtime View load as one block? If one block, we're loading ~7 sub-views worth of JS when user first clicks Runtime. If separate, `build-html.py` needs to handle nested lazy blocks.

**Concerns:**
- **State management complexity explosion.** Currently we have `state.js` managing workspace tree + log filters + sidebar state. F04 adds: active tokens map, file op stream, spark sessions, cache entries, HTTP request timeline, retry state, flag evaluations, DI registry, perf markers. That's 9 new state domains. Without a proper event bus or state container, `state.js` becomes a god object.
- **WebSocket reconnection.** The doc mentions nothing about what happens when the WebSocket drops (FLT restart, network blip). With 11 stream types, reconnection needs to re-subscribe and potentially request a state snapshot (what tokens are currently active? what locks exist?). Without this, the UI goes stale silently.

**Suggestions:**
- Implement a typed event bus (`EventBus.on('token:generated', handler)`) to decouple the WebSocket message router from individual tab renderers. Each tab subscribes to its message types. Worker handles buffering.
- For HTTP Pipeline MVP: skip the waterfall. Ship a sorted request list (like `curl -v` output) with timing columns. Waterfall is Phase C polish.
- Each Runtime sub-view should be its own lazy module with its own ring buffer size. Tokens: 500 entries. File ops: 2000. HTTP: 1000. Logs: 10000.

---

### Mika Tanaka (CSS Systems — Visual Design)

**Questions:**
1. **F04 introduces 11 sub-views, each with "own tailored layout."** That means 11 new CSS modules. Current `src/frontend/css/` has 18 files. We'd go to ~29 CSS files. What's the impact on build-html.py concatenation order? More importantly — are there shared layout patterns (stream + detail panel, table + filter bar) that should be extracted into shared CSS components first?
2. **Token Inspector mockup shows TTL countdowns with color shifts (green → amber → red).** What are the OKLCH breakpoints? I need: remaining > 30min = green (`oklch(0.72 0.18 145)`), 10-30min = amber, <10min = red, expired = gray. But is this a smooth gradient (CSS animation on `oklch` lightness) or discrete steps? Smooth is more informative but costs a `setInterval` per token card.
3. **F04 "Internals" dropdown** — what's the visual treatment? Is this a standard `<select>`, a custom dropdown panel, a popover menu? Need to match the existing command palette aesthetic but at tab-bar scale.

**Concerns:**
- **11 new tailored layouts without a shared component system = visual drift.** If each sub-view designer makes independent spacing/typography decisions, we'll end up with inconsistent padding, different header styles, different "empty state" treatments. Need to define: `.stream-view` (for Logs, Tokens, File Ops, HTTP, Retries, Flags, Perf), `.panel-view` (for Caches, DI, Spark Sessions), `.split-view` (stream + detail).
- **Single HTML file size budget is 800KB.** Adding 11 new view styles could push us over. Each CSS module is ~2-4KB. 11 new modules = ~30KB CSS. Not dangerous alone, but combined with 11 new JS modules (~50KB each) = ~550KB additional. We need to check the current file size.

**Suggestions:**
- Create three base layout CSS classes BEFORE building individual sub-views:
  - `.runtime-stream` — vertical scrolling stream with timestamp + type + content columns
  - `.runtime-inspector` — split: left list, right detail panel
  - `.runtime-dashboard` — grid of metric cards
- All 11 sub-views compose from these three primitives. This cuts CSS duplication by ~60%.
- TTL color should use CSS custom properties animated via JS class swaps: `.token-ok`, `.token-warning`, `.token-critical`, `.token-expired`. Discrete steps, not smooth gradient — smooth gradients on 5+ token cards will cause unnecessary repaints.

---

### Arjun Mehta (Sr. C# — Interceptors & WebSocket)

**Questions:**
1. **F04 needs 7 NEW interceptors. What's the DI registration strategy?** `EdogLogInterceptor` and `EdogTelemetryInterceptor` are registered manually. Are all 7 new interceptors registered in `RunAsync()` callback (per ADR-005)? Some need `DelegatingHandler` registration (Token, HTTP Pipeline), some need `IFileSystem` decoration (System Files), some need `IFeatureFlighter` wrapping (Flags). That's 3 different DI patterns. Do we have a single `EdogDevModeRegistrar` class that handles all of them?
2. **Cache interceptor says "Cache wrappers per manager" — there are 10 cache managers.** Does this mean 10 separate wrapper classes? Or one generic `EdogCacheInterceptor<T>` that wraps any `ICacheManager<T>`? The FLT codebase uses `CacheManager<string, DagDefinition>`, `CacheManager<string, MlvExecutionDefinition>`, etc. Generic wrapping is cleaner but requires knowing the type parameters at registration time.
3. **EdogTokenInterceptor as DelegatingHandler** — the F08 detail shows it capturing `Authorization` headers. But FLT's `HttpClientFactoryRegistry` creates MULTIPLE named HttpClients (OneLake, GTS, PBI). Does the interceptor register in ALL pipelines, or just specific ones? Adding overhead to every HTTP call in the FLT service violates the `< 1ms per entry` target if it's on the hot path.

**Concerns:**
- **"7 new interceptors" in the FLT process is a serious stability risk.** Each interceptor is a decorator/handler that runs in the production code path. A bug in `EdogFileSystemInterceptor` could block file writes and hang DAG execution. Each interceptor MUST have try/catch around the broadcast call — NEVER fail the inner operation because EDOG broadcast failed.
- **WebSocket broadcast from interceptors is fire-and-forget today.** If the WebSocket is full (client can't consume fast enough), does `BroadcastToken()` block? Drop? Queue? If it queues, it leaks memory inside FLT. If it blocks, it slows FLT. Need a bounded channel with drop-oldest semantics.

**Suggestions:**
- Create `EdogDevModeRegistrar.cs` — single entry point for all interceptor DI registration. Conditional on `EDOG_DEV_MODE=true` environment variable. If false, zero overhead.
- Every interceptor broadcast MUST be wrapped: `try { EdogLogServer.Broadcast(...); } catch { /* swallow — never fail production code for debug tooling */ }`
- Use `Channel<T>` (bounded, 1000 items, `BoundedChannelFullMode.DropOldest`) for all WebSocket broadcast queues. Consumer drains to WebSocket. Never block the caller.

---

### Elena Voronova (Sr. Python — CLI, Auth, Deploy)

**Questions:**
1. **F02 "Deploy steps: Config update → patch code → dotnet build → launch FLT."** The current `edog.py` handles patch + build + launch. But F02 says deploy is "embedded in web server." Which web server? The Python dev-server that serves the HTML? Or the C# EdogLogServer that runs inside FLT? If it's Python dev-server, I need a REST API endpoint like `POST /api/deploy` that triggers the subprocess chain. If it's C#, FLT can't build itself.
2. **Startup flow says "Playwright launches → cert-based auth → Bearer token captured."** The Bearer token is currently cached to `.edog-bearer-cache` on disk. But the STARTUP_ARCHITECTURE says MWC tokens are in-memory only (`Map` in JS). If the browser refreshes, all MWC tokens are lost. Is that acceptable? Re-fetching N MWC tokens on page refresh adds latency. Should we cache MWC tokens to disk too, or at least to the Python dev-server's memory?
3. **"Token auto-refresh: silent in background, or show notification?"** For Bearer, auto-refresh requires re-launching Playwright (it's cert-based auth, not a refresh token). That opens a visible browser window. The user WILL notice. Can we do headless Playwright re-auth? Have we tested if cert-based auth works headless?

**Concerns:**
- **FLT repo path detection for deploy.** F02 asks "auto-detect from git, or user configures at setup?" Auto-detect is fragile — the user might have multiple FLT clones, or be on a feature branch in a worktree. The `edog-config.json` should have an explicit `fltRepoPath` field. Auto-detect can be a convenience that pre-fills it, but the user must confirm.
- **Hot-swap deploy (F02 open question).** Deploying to an already-deployed lakehouse means: stop FLT process → patch → rebuild → restart. But stopping FLT kills the WebSocket connection → the UI loses all streaming state (logs, tokens, file ops). The UI needs to handle "FLT restarting" gracefully — show a reconnection banner, buffer any user actions, and restore state on reconnect.

**Suggestions:**
- Deploy endpoint: `POST /api/deploy` on the Python dev-server (port 5556). Returns a streaming response (SSE) with step-by-step progress. Frontend shows a deploy progress panel.
- Cache MWC tokens in the Python dev-server memory (not just JS). If browser refreshes, JS calls `GET /api/tokens` to restore them. This also enables multi-tab support.
- For Bearer refresh: try headless Playwright first. If cert prompt requires visible window, show a toast: "Token expiring in 5 min — click to re-authenticate" with a button that opens the Playwright window.

---

### Dev Patel (FLT Expert — Domain Knowledge)

**Questions:**
1. **F04 Cache interceptor: "10 cache managers."** I need to enumerate them precisely. Off the top of my head: `DagDefinitionCache`, `MlvExecutionDefinitionCache`, `TokenCache`, `CapabilityCache`, `SettingsCache`, `SparkSessionCache`... but I'm not sure the current count is exactly 10. Some caches are `IMemoryCache` instances, some are custom `CacheManager<K,V>`. Do we intercept ALL caching, or only FLT-domain caches? Intercepting `IMemoryCache` globally would capture ASP.NET internal caches too — very noisy.
2. **F04 Retries interceptor hooks into `RetryPolicyProviderV2`.** This class generates Polly policies. The retry behavior is: create a policy → policy wraps an HTTP call → retries happen inside the policy. To intercept, do we wrap the policy itself (decorator on `IAsyncPolicy<HttpResponseMessage>`) or hook into the retry event callbacks (`onRetry`)? Polly v7 (which FLT uses) supports `onRetry` delegates — that's cleaner than wrapping.
3. **System Files: should we show READ operations?** YES — 100%. The most common debugging scenario is "why didn't it find my settings?" which means READ of `dagsettings.json` returned null/empty. Without READ visibility, that's invisible. But we need to filter: show READs for known FLT files (settings, locks, definitions), suppress READs for index scanning (listing directories generates dozens of EXISTS/LIST calls per DAG run).

**Concerns:**
- **MWC token scoping for workspace expand.** The doc says "auto-generate on workspace expand" — but MWC tokens are scoped per `(workspace, lakehouse, capacity)`. When a workspace expands, we see lakehouses but don't know which one the user cares about. Do we generate MWC tokens for ALL visible lakehouses preemptively? That's wasteful if the workspace has 15 lakehouses and the user only cares about one. Better: generate on lakehouse click (first table request), not on workspace expand.
- **Feature Flag evaluations (F04).** The `IFeatureFlighter` wrapper intercepts `IsFeatureEnabledAsync()` calls. But FLT caches flag results aggressively — many flags are evaluated once at startup and never re-evaluated. The "stream" view will show a burst of 30 evaluations at startup then go silent. Is that useful, or should we show the cached state as a static table?

**Suggestions:**
- For MWC auto-generate: use **lakehouse click** trigger, not workspace expand. Cache aggressively. Show "Loading tables..." skeleton while token generates (~1-2s). This avoids wasting tokens on lakehouses the user never inspects.
- For Feature Flags: dual view. **Static table** showing all cached flag states (name → result → inputs). **Stream** showing real-time re-evaluations only. Most of the time the static table is what engineers want.
- For Caches: intercept only classes that implement our `ICacheManager<K,V>` interface, not `IMemoryCache`. This gives us the FLT-domain caches without ASP.NET noise.

---

### Ines Ferreira (QA/Test — Testability & Risk)

**Questions:**
1. **F04 has 11 sub-views, each with a C# interceptor + WebSocket message type + JS renderer.** That's 33 components to test for just one feature. What's the test strategy? Unit test each interceptor in isolation (MSTest)? Integration test the WebSocket message flow? E2E test each tab renders data? We need a test matrix BEFORE implementation starts or we'll ship untested views.
2. **F02 Deploy "patch + build + launch" — what's the rollback strategy?** If `dotnet build` fails after patching, the FLT source is in a modified state. Does deploy auto-revert patches on build failure? What if FLT launches but crashes immediately — do we detect that and report it? The error scenarios here are numerous and each needs a defined behavior.
3. **"Ship this week" with 7 features, 7 new interceptors, and 11 sub-views.** Which features have NO tests today? F03 Favorites is localStorage — no automated tests. F04 Runtime View is 0% built — no tests. F07 Command Palette has "existing" implementation but is it tested? I need a coverage audit before the sprint starts.

**Concerns:**
- **Regression risk from 7 new interceptors in FLT process.** If ANY interceptor has a bug that throws an unhandled exception, it could crash the FLT worker. That blocks ALL development, not just EDOG. We need: (1) each interceptor wrapped in try/catch, (2) a kill switch (`EDOG_DEV_MODE=false` disables all interceptors), (3) a smoke test that FLT starts and processes a DAG successfully with all interceptors enabled.
- **No browser test automation.** Engineering Standards say "Manual browser" for JS testing. With 11 new sub-views, manual testing after every change is unsustainable. Can we at least add Playwright browser tests for critical paths (WebSocket connects, tabs switch, data renders)?
- **Token expiry edge cases.** MWC tokens expire. What happens in the UI when a cached token expires mid-operation? Does the table listing fail silently? Show an error? Auto-refresh and retry? Each token-dependent feature needs an "expired token" test case.

**Suggestions:**
- Create a test matrix: `[interceptor] × [message type] × [UI tab] × [scenario: happy, error, empty, overflow]`. That's the scope. We test bottom-up: interceptor unit tests first, then WebSocket integration, then UI smoke.
- Add Playwright browser tests for: (1) app loads, (2) WebSocket connects, (3) sidebar navigation works, (4) each Runtime tab renders mock data. This replaces 80% of manual testing.
- Implement a `EDOG_DEV_MODE` env var check as the FIRST line of every interceptor's hot path. If false, passthrough with zero overhead.

---

### Ren Aoki (Build/DevOps — Build System & CI)

**Questions:**
1. **PERFORMANCE_ARCHITECTURE Shift 1 (lazy view loading) requires `build-html.py` to emit per-view `<script type="text/lazy">` blocks.** Current `build-html.py` concatenates ALL JS into one `<script>` block. This is a significant refactor of the build system. Is this MVP or post-MVP? If MVP, it blocks all frontend work because the build output format changes.
2. **7 new C# interceptor files.** Are they in the same `src/backend/DevMode/` directory? Does `dotnet build` for the FLT project already include this path, or do we need `.csproj` changes? Currently we have 5 `.cs` files — going to 12. Is there a CI pipeline that builds these, or is it local-only?
3. **Single HTML file size budget: < 800KB.** Current `edog-logs.html` — what's the actual size? With 11 new views (JS + CSS each), we could easily hit 1MB+. Do we need to set up a CI check that fails the build if the output exceeds 800KB?

**Concerns:**
- **No CI pipeline defined.** Engineering Standards say `make lint && make test` before commit. But is there a GitHub Actions workflow? If not, we're relying on developer discipline for 9 agents shipping 7 features in one week. At least one person will forget.
- **Web Worker as inline Blob URL.** PERFORMANCE_ARCHITECTURE says worker code is "inlined as a Blob URL." `build-html.py` needs to handle this — extract the worker JS, wrap it in `new Blob([...], {type: 'text/javascript'})`, create the URL. This is non-trivial build system work. Has this been prototyped?
- **C# files are NOT built by `build-html.py`.** They're built by `dotnet build` inside the FLT repo. But they live in OUR repo (`src/backend/DevMode/`). How do they get INTO the FLT build? Copy? Symlink? Git submodule? This integration path is undefined.

**Suggestions:**
- Add a GitHub Actions CI workflow NOW: `make lint → make test → make build → check file size < 800KB`. Block merges on failure. This is 30 minutes of work and saves days of debugging.
- For C# integration: add a `scripts/install-interceptors.sh` (or `.cmd`) that copies `src/backend/DevMode/*.cs` into the FLT repo's DevMode directory. Document the target path in `CONTRIBUTING.md`.
- Measure the current HTML file size and set a baseline. Track it in CI. If we're already at 500KB with 7 features, 800KB for 44 is tight.

---

## Summary: Top 5 Blocking Issues

| # | Issue | Owner | Risk |
|---|-------|-------|------|
| 1 | **F02 deploy process ownership is contradictory** — can't run inside FLT if it launches FLT | Sana + Elena | 🔴 Blocks F02 |
| 2 | **WebSocket multiplexing for 11 message types undefined** — will cause performance/correctness issues | Sana + Zara + Arjun | 🔴 Blocks F04 |
| 3 | **MWC auto-generate on workspace expand is wasteful** — should be lakehouse click | Dev + Elena | 🟡 Design change needed |
| 4 | **No CI pipeline** — 9 agents shipping 7 features with no automated quality gate | Ren + Ines | 🟡 Ship-week risk |
| 5 | **F04 scope ("all in MVP") is unrealistic** — Phase C Internals should be explicitly post-MVP | Sana + Kael | 🟡 Schedule risk |