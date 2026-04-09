# EDOG Playground — Startup & Token Architecture

> **Name change:** EDOG Studio → **EDOG Playground**
> **Date:** 2026-04-09
> **Status:** CEO-defined, replaces previous startup flow

---

## Startup Flow

```
┌─────────────────────────────────────────────────────────┐
│  1. TENANT SELECTION                                     │
│     User picks EDOG tenant (e.g., FabricFMLV08PPE)       │
│     Configurable list of known tenants                   │
│     "Add Tenant" for new ones                            │
│                          │                               │
│                          ▼                               │
│  2. AUTHENTICATE                                         │
│     Playwright launches → cert-based auth                │
│     Bearer token captured and cached                     │
│     (PBI audience — works on redirect host)              │
│                          │                               │
│                          ▼                               │
│  3. DASHBOARD                                            │
│     Full UI loads immediately with Bearer token           │
│     Everything that uses Bearer works right away:         │
│     - Workspace Explorer (browse all workspaces)         │
│     - Capacity Command Center (health, utilization)      │
│     - Recent Items                                       │
│     - Feature Flags (local file parsing)                 │
│     - API Playground (Fabric APIs)                       │
│                          │                               │
│                          ▼                               │
│  4. USER SELECTS WORKSPACE + LAKEHOUSE                   │
│     Click in tree or favorites                           │
│     This triggers:                                       │
│                          │                               │
│                          ▼                               │
│  5. LAZY TOKEN ACQUISITION                               │
│     MWC token fetched ON DEMAND for that specific        │
│     workspace/lakehouse/capacity combo                   │
│     Cached per (wsId, lhId, capId) tuple                 │
│     Multiple MWC tokens cached simultaneously            │
│                          │                               │
│                          ▼                               │
│  6. CONNECTED FEATURES UNLOCK                            │
│     Tables (schema-enabled, via MwcToken)                │
│     Table details, preview (via MwcToken)                │
│     Deploy to Lakehouse (patches + builds + launches)    │
│     DAG Studio (after FLT deployed)                      │
│     Logs (after FLT deployed)                            │
│     System Files Explorer (after FLT deployed)           │
└─────────────────────────────────────────────────────────┘
```

---

## Token Cache Architecture

### Key Insight: MWC Tokens Are Scoped Per (Workspace, Lakehouse, Capacity)

A user browsing multiple lakehouses needs MULTIPLE MWC tokens simultaneously:

```
Bearer Token (1 per tenant)
├── cached in .edog-bearer-cache
├── audience: analysis.windows-int.net/powerbi/api
├── used for: redirect host APIs, metadata, workspace CRUD
└── TTL: ~1 hour, auto-refresh before expiry

MWC Token Pool (N per session)
├── cached in memory (Map keyed by wsId:lhId:capId)
├── each scoped to specific workspace + lakehouse + capacity
├── used for: capacity host APIs (tables, DAG, maintenance)
├── auth scheme: Authorization: MwcToken {token}
├── TTL: varies, refresh 5 min before expiry
└── fetched lazily on first need, reused across views

Example runtime state:
  mwcTokens = {
    "ws-abc:lh-123:cap-xyz": { token: "...", expiry: 1775740000, host: "capxyz.pbidedicated..." },
    "ws-abc:lh-456:cap-xyz": { token: "...", expiry: 1775739800, host: "capxyz.pbidedicated..." },
    "ws-def:lh-789:cap-qrs": { token: "...", expiry: 1775741000, host: "capqrs.pbidedicated..." },
  }
```

### Token Acquisition Flow

```javascript
class TokenManager {
  constructor(apiClient) {
    this._bearer = null;        // Single bearer token
    this._bearerExpiry = 0;
    this._mwcPool = new Map();  // Key: "wsId:lhId:capId" → { token, expiry, host }
    this._api = apiClient;
  }

  // Called once at startup after tenant selection + auth
  setBearerToken(token, expiry) {
    this._bearer = token;
    this._bearerExpiry = expiry;
  }

  // Called automatically when any view needs MWC access
  async getMwcToken(wsId, lhId, capId) {
    const key = `${wsId}:${lhId}:${capId}`;
    const cached = this._mwcPool.get(key);

    // Return cached if valid (with 5-min buffer)
    if (cached && Date.now() / 1000 < cached.expiry - 300) {
      return cached;
    }

    // Fetch new MWC token
    const result = await this._api.generateMwcToken(wsId, lhId, capId);
    const entry = {
      token: result.Token,
      host: result.TargetUriHost,
      expiry: new Date(result.Expiration).getTime() / 1000 || (Date.now() / 1000 + 3600),
    };
    this._mwcPool.set(key, entry);
    return entry;
  }

  // For views that need MWC: transparently get or refresh
  async withMwcToken(wsId, lhId, capId, fn) {
    const mwc = await this.getMwcToken(wsId, lhId, capId);
    return fn(mwc.token, mwc.host);
  }
}
```

### When Each Token Is Acquired

| Moment | What Happens | Token Acquired |
|--------|-------------|----------------|
| App start → tenant selection | User picks tenant | — |
| Authenticate button clicked | Playwright auth | **Bearer** (cached to disk) |
| Dashboard loads | All Bearer-based views populate | Bearer (from cache) |
| User clicks a lakehouse | Need tables, details | **MWC** for that ws:lh:cap (lazy) |
| User clicks different lakehouse | Need its tables | **MWC** for different ws:lh:cap (lazy) |
| User clicks "Deploy" | Need to patch + build + launch FLT | MWC (reuse if same lh) |
| DAG Studio opens | Need getLatestDag, metrics | MWC (reuse for same lh) |
| User switches to different workspace's lakehouse | New context | **New MWC** (different ws:lh:cap) |
| Any MWC token approaching expiry | Background refresh | **Refresh MWC** (5 min buffer) |
| Bearer token approaching expiry | Background re-auth | **Refresh Bearer** (auto Playwright) |

---

## Tenant Configuration

```json
// edog-config.json (or UI-managed)
{
  "tenants": [
    {
      "name": "FabricFMLV08PPE",
      "username": "Admin1CBA@FabricFMLV08PPE.ccsctp.net",
      "redirectHost": "https://biazure-int-edog-redirect.analysis-df.windows.net",
      "powerBiUrl": "https://powerbi-df.analysis-df.windows.net/",
      "isDefault": true
    },
    {
      "name": "FabricFMLV07PPE",
      "username": "Admin1CBA@FabricFMLV07PPE.ccsctp.net",
      "redirectHost": "https://biazure-int-edog-redirect.analysis-df.windows.net",
      "powerBiUrl": "https://powerbi-df.analysis-df.windows.net/",
      "isDefault": false
    }
  ],
  "activeTenant": "FabricFMLV08PPE",
  "favorites": [...],
  "recentLakehouses": [...]
}
```

---

## What's Available at Each Stage

| Stage | What Works | Token Used |
|-------|-----------|------------|
| **Before auth** | Tenant selector, offline config, feature flags (local files) | None |
| **After Bearer** | Workspace tree, capacity dashboard, recent items, API playground (Fabric), rename/delete/create, notifications, workload configs | Bearer |
| **After MWC (per lakehouse)** | Tables (schema-enabled), table details/preview, scheduled jobs, MWC token generation for other workloads | MwcToken |
| **After Deploy (FLT running)** | Logs, DAG Studio, Spark Inspector, maintenance, system files, connected features | MwcToken + FLT service |

---

## Naming

**EDOG Studio → EDOG Playground**

Update everywhere: HTML title, topbar brand, README, docs, commit messages, CLI help text.
