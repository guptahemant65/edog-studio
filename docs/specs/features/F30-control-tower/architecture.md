# F30 Control Tower — P2 Architecture

> **Status:** P2 — DRAFT
> **Phase:** Architecture (P0 ✅ → P1 ✅ → **P2** → P3)
> **Owner:** Sana (architecture + FLT domain), Vex (data engine — ADO REST client, cache, miner)
> **Authority:** This file is the **single source of truth** for system topology, data-engine design, auth flow, caching, and API implementation. Component specs (C01–C09) declare the shapes they consume; this file specifies how those shapes are produced.
> **Canonical data model:** [`data-model.md`](./data-model.md) — CellState enum, 15-env model, Attribution interface, StaleReason type, route table, `/api/ct/` prefix, dwell rule. **This architecture consumes `data-model.md` verbatim and never contradicts it.**
> **Last updated:** 2026-06-13

---

## Table of Contents

1. [System Topology & Hosting](#1-system-topology--hosting)
2. [Auth Architecture](#2-auth-architecture)
3. [ADO REST Client & Git-History Miner](#3-ado-rest-client--git-history-miner)
4. [Inert / Dependency Parser](#4-inert--dependency-parser)
5. [Derivation Layer](#5-derivation-layer)
6. [Refresh & Caching Strategy](#6-refresh--caching-strategy)
7. [API Surface](#7-api-surface)
8. [End-to-End Data Flow](#8-end-to-end-data-flow)
9. [OSS Build-vs-Buy Track](#9-oss-build-vs-buy-track)
10. [P2 Open Questions](#10-p2-open-questions)

---

## 1. System Topology & Hosting

### 1.1 Hosting recommendation: Azure App Service (primary) — not Vercel

| Criterion | Azure App Service | Vercel |
|---|---|---|
| **MS-internal alignment** | Native. Same tenant, same compliance boundary, same network. | External vendor. Data-residency and compliance review required for an internal tool that handles delegated Entra tokens server-side. |
| **Managed Identity (app infra)** | ✅ Available. Use MI for KeyVault (session secrets), Application Insights, and any future Azure-hosted infra dependency. Zero secret rotation for app-level identity. | ❌ Not available. App secrets must be stored as Vercel environment variables — encrypted at rest but not MI-rotatable. |
| **Next.js support** | Full. App Service supports Node.js 20 LTS via custom startup. `next start` runs as a long-lived process with in-memory caching (critical for our warm-store model — §6). | Native. Serverless functions per route handler. Cold starts on every route handler after idle. In-memory warm store requires an external cache (Redis / KV). |
| **In-memory warm store** | ✅ Single long-lived Node.js process = in-process `Map<commitId, FlagContent>` with zero serialisation cost. The 42-flag corpus (~2–4 MB) fits trivially. | ❌ Serverless functions are stateless. Each invocation starts cold. Warm store requires Vercel KV (Redis) or Vercel Blob — added latency, cost, and operational surface. |
| **Cost** | F1 free tier is sufficient for internal PM tool (~10 concurrent users). B1 ($13/mo) if F1 is too constrained. | Free tier: 100 GB bandwidth, 100 hrs serverless. Likely sufficient but not controllable via Azure RBAC/billing. |
| **Auth proximity** | Same Entra tenant. App registration is a 1st-party registration with no cross-tenant trust. | Same Entra tenant (works), but token exchange happens outside the Azure network boundary. Acceptable but less ideal. |
| **Deployment** | GitHub Actions → `az webapp deploy`. Standard. | `vercel deploy` or GitHub integration. Simpler DX but outside Azure DevOps ecosystem. |

**Decision: Azure App Service** as the primary hosting target. Vercel remains a viable fallback if Azure provisioning is blocked. The architecture abstracts the hosting choice (§1.3) so switching is a deployment-config change, not a code change.

**Rationale summary:** The in-memory warm store (§6) is architecturally central — it avoids serialisation overhead and external-cache complexity for a corpus of only ~42 flags. App Service's long-lived process model supports this natively. Vercel's serverless model would force an external cache, adding latency, cost, and a failure mode for zero benefit at our scale. MI for KeyVault secrets is a bonus.

### 1.2 Serverless vs. long-lived process

Control Tower runs as a **single long-lived Node.js process** (`next start`), not as individually deployed serverless functions. Reasons:

1. **Warm store.** The attribution miner builds an in-memory corpus on first request and refreshes incrementally (§6). A serverless model would discard this on every cold start.
2. **Scale.** ~10 concurrent PM users. A single B1 App Service instance handles this with margin.
3. **Simplicity.** One deployment artifact. No function-app plumbing, no durable-functions orchestration.

### 1.3 Hosting abstraction layer

To keep the hosting choice swappable:

```
src/
  platform/
    platform.ts          # PlatformAdapter interface
    azure-app-service.ts # Azure MI for KeyVault, App Insights
    vercel.ts            # Env-var secrets, Vercel Analytics
```

```typescript
interface PlatformAdapter {
  /** Retrieve a secret (session secret, etc.). MI on Azure; env var on Vercel. */
  getSecret(name: string): Promise<string>;
  /** Structured logging. App Insights on Azure; console + Vercel Log Drain on Vercel. */
  log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
  /** Health-check metadata for /api/ct/health. */
  healthMeta(): Promise<Record<string, unknown>>;
}
```

**Rule:** Application code imports `platform.ts`, never a provider-specific module. The provider is selected at build time via `PLATFORM=azure|vercel` env var. Next.js `next.config.js` tree-shakes the unused provider.

### 1.4 Deployment topology (Azure App Service)

```
┌─────────────────────────────────────────────────────────────┐
│  Azure App Service (B1 / F1)                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Node.js 20 LTS — `next start`                       │  │
│  │  ┌─────────┐  ┌───────────┐  ┌──────────────────┐   │  │
│  │  │ Next.js │  │ MSAL Node │  │ Warm Store (Map) │   │  │
│  │  │ Router  │  │ + token   │  │ commitId→content │   │  │
│  │  │         │  │ cache     │  │ + derived data   │   │  │
│  │  └────┬────┘  └─────┬─────┘  └────────┬─────────┘   │  │
│  │       │             │                  │              │  │
│  │  ┌────▼─────────────▼──────────────────▼──────────┐  │  │
│  │  │           /api/ct/* route handlers              │  │  │
│  │  │  (server-side only — tokens never reach browser)│  │  │
│  │  └────────────────────┬───────────────────────────┘  │  │
│  └───────────────────────┼──────────────────────────────┘  │
│                          │ HTTPS                            │
│  ┌───────────────────────▼──────────────────────────────┐  │
│  │  Azure Key Vault (via Managed Identity)               │  │
│  │  - NextAuth session secret                            │  │
│  │  - MSAL client secret (Entra app registration)        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         ▲ browser (HTTPS)              │ ADO REST (HTTPS)
         │                              ▼
   ┌─────┴──────┐             ┌─────────────────────┐
   │  PM user   │             │ ADO Git API          │
   │  (browser) │             │ powerbi.visualstudio │
   │  No tokens │             │ .com                 │
   └────────────┘             └─────────────────────┘
```

---

## 2. Auth Architecture

### 2.1 Two-identity model

Control Tower operates with **two distinct identities** that must never be collapsed:

| Identity | Purpose | Credential type | Where it lives |
|---|---|---|---|
| **App identity** | Infra-level: KeyVault access, App Insights telemetry, session secret retrieval | Azure Managed Identity (on App Service) or Entra app client-secret (on Vercel) | Server process only. Never browser. |
| **Data identity** | Read FM repo via ADO REST API as the signed-in PM user | Delegated per-user Entra token (auth-code flow with ADO scope) | Server-side token cache only. **Never reaches browser.** |

**Why two identities:**
- **App identity** exists only for infrastructure plumbing (KeyVault, logging). It has no ADO permissions.
- **Data identity** is the signed-in user. Every ADO call is audited under the real user. This is the P0.2 resolution: all PMs have FM-repo read, so no service principal is needed for data access. The delegated model ensures least-privilege and per-user audit trails.

**Hard rule (from P0.2, non-negotiable):** The ADO access token (data identity) is stored in the server-side MSAL token cache and used exclusively in Next.js route handlers. It never appears in cookies, response bodies, or browser-accessible storage.

### 2.2 Auth flow — step by step

```
  Browser                    Next.js Server                  Entra ID          ADO REST
    │                             │                             │                  │
    │  1. GET /                   │                             │                  │
    │ ───────────────────────────>│                             │                  │
    │                             │  2. No session cookie →     │                  │
    │  3. 302 → /auth/signin     │     redirect to Entra       │                  │
    │ <───────────────────────────│                             │                  │
    │                             │                             │                  │
    │  4. 302 → Entra /authorize │                             │                  │
    │     scope: openid profile  │                             │                  │
    │     + 499b84ac-.../.default│                             │                  │
    │ ──────────────────────────────────────────────────────────>│                  │
    │                             │                             │                  │
    │  5. User authenticates     │                             │                  │
    │     (MS login, MFA)        │                             │                  │
    │ <──────────────────────────────────────────────────────────│                  │
    │                             │                             │                  │
    │  6. 302 → /api/auth/       │                             │                  │
    │     callback?code=XXXX     │                             │                  │
    │ ───────────────────────────>│                             │                  │
    │                             │  7. MSAL acquireTokenByCode │                  │
    │                             │     (code → access_token   │                  │
    │                             │      + refresh_token)      │                  │
    │                             │ ────────────────────────────>│                  │
    │                             │ <────────────────────────────│                  │
    │                             │                             │                  │
    │                             │  8. Store tokens in         │                  │
    │                             │     server-side MSAL cache  │                  │
    │                             │     (in-memory + encrypted  │                  │
    │                             │      session cookie ref)    │                  │
    │                             │                             │                  │
    │  9. Set-Cookie: session     │                             │                  │
    │     (encrypted, httpOnly,   │                             │                  │
    │      sameSite=lax, secure)  │                             │                  │
    │ <───────────────────────────│                             │                  │
    │                             │                             │                  │
    │  10. GET /api/ct/grid       │                             │                  │
    │ ───────────────────────────>│                             │                  │
    │                             │  11. Decrypt session →      │                  │
    │                             │      look up MSAL cache →   │                  │
    │                             │      get user's ADO token   │                  │
    │                             │      (refresh if expired)   │                  │
    │                             │                             │                  │
    │                             │  12. ADO REST calls         │                  │
    │                             │      (as signed-in user)    │                  │
    │                             │ ─────────────────────────────────────────────── >│
    │                             │ <────────────────────────────────────────────── │
    │                             │                             │                  │
    │  13. 200 GridResponse      │                             │                  │
    │     (rendered data only,   │                             │                  │
    │      no token, no FM JSON) │                             │                  │
    │ <───────────────────────────│                             │                  │
```

### 2.3 MSAL configuration

```typescript
// src/auth/msal-config.ts
import { ConfidentialClientApplication } from '@azure/msal-node';

const msalConfig = {
  auth: {
    clientId: process.env.ENTRA_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}`,
    // Client secret retrieved via PlatformAdapter.getSecret() at startup
    clientSecret: '<loaded from KeyVault via MI>'
  },
  cache: {
    // In-memory cache plugin — sufficient for single-instance App Service
    // If scaling to >1 instance, replace with Redis-backed distributed cache
    cachePlugin: inMemoryCachePlugin
  }
};

const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
```

### 2.4 Auth.js (NextAuth) integration

Auth.js v5 is the session-management layer. It handles the browser session cookie and the OAuth callback flow. MSAL is the token-acquisition layer underneath.

```typescript
// src/auth/auth-options.ts
import { AuthOptions } from 'next-auth';

export const authOptions: AuthOptions = {
  providers: [
    // Custom Entra provider wired to MSAL
    {
      id: 'entra',
      name: 'Microsoft',
      type: 'oauth',
      authorization: {
        url: `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`,
        params: { scope: `openid profile email ${ADO_SCOPE}` }
      },
      token: {
        // Delegate to MSAL acquireTokenByCode
        async request({ params }) { /* ... */ }
      },
      userinfo: { /* Entra /me endpoint */ }
    }
  ],
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 }, // 8h session
  callbacks: {
    async jwt({ token, account }) {
      // On initial sign-in: store MSAL cache key in JWT
      // On subsequent calls: MSAL handles refresh transparently
      return token;
    },
    async session({ session, token }) {
      // Expose only user profile to browser — never tokens
      return { user: session.user, expires: session.expires };
    }
  }
};
```

### 2.5 Token lifecycle & security posture

| Concern | Design |
|---|---|
| Access-token storage | Server-side MSAL in-memory token cache. Keyed by user OID. Never serialised to cookie or response body. |
| Refresh | MSAL `acquireTokenSilent` handles refresh transparently. Refresh token stored only in MSAL cache. |
| Session cookie | Auth.js encrypted JWT cookie. `httpOnly`, `secure`, `sameSite=lax`. Contains user profile + MSAL cache key — never the access token itself. |
| Multi-instance scaling | Single App Service instance → in-memory MSAL cache is sufficient. If scaled to 2+ instances, plug in `@azure/msal-node-extensions` with a Redis-backed distributed cache. This is a config change, not an architecture change. |
| Token lifetime | ADO access tokens: ~1h. Refresh tokens: ~24h. Auth.js session: 8h. User re-authenticates on session expiry. |
| Revocation | Entra Continuous Access Evaluation (CAE) is supported by MSAL Node. If the user's access is revoked in Entra, the next `acquireTokenSilent` call fails, and the route handler returns 401 → Auth.js triggers re-auth. |
| Tenant restriction | `authority` is set to a specific tenant ID. Only users in the PowerBI org tenant can sign in. |

### 2.6 Hosting-swappable auth

The auth design is hosting-agnostic:
- **On Azure App Service:** Client secret loaded from KeyVault via MI at startup. MSAL cache in-process.
- **On Vercel:** Client secret from `ENTRA_CLIENT_SECRET` env var. MSAL cache in-process per serverless invocation (requires Vercel KV for cross-invocation persistence — acceptable degradation).

The only code difference is the `PlatformAdapter.getSecret()` implementation (§1.3).

---

## 3. ADO REST Client & Git-History Miner

This is **Vex's domain** — the data engine. This section specifies it precisely enough for Vex to implement without re-deriving.

### 3.1 ADO REST client layer

```typescript
// src/engine/ado-client.ts

interface AdoClient {
  /** List all items under a path, one level deep. */
  listItems(scopePath: string): Promise<AdoItem[]>;

  /** Get file content at a specific version (branch or commitId). */
  getContent(path: string, version: VersionDescriptor): Promise<string>;

  /** Get commit history for a specific file path. */
  getPathCommits(path: string, branch: string): Promise<AdoCommit[]>;
}

interface VersionDescriptor {
  versionType: 'branch' | 'commit';
  version: string;  // 'master' or full SHA
}
```

**Base URL:** `https://dev.azure.com/powerbi/Power%20BI/_apis/git/repositories/FeatureManagement`

**API version:** `api-version=7.1` (stable).

**Auth header:** `Authorization: Bearer <user's ADO access token>` — obtained from the MSAL token cache for the signed-in user (§2).

**Rate-limit posture:** ADO REST has a [per-user, per-5-minute sliding-window rate limit](https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits). With 42 flags and ~50 commits per flag, the initial cold-load issues ~42 (content) + ~42 (commit lists) + ~2100 (historical content for attribution) ≈ 2,184 requests. This is within ADO's limits for a single user but is the peak load scenario. Mitigations:

1. **Immutable-commit cache** (§3.4): after cold-load, incremental refreshes issue only new-commit content requests (typically 0–5 per refresh).
2. **Parallel fetch with concurrency cap:** `Promise.allSettled` with a concurrency limiter (max 10 concurrent ADO requests per user) to avoid burst-triggered 429s.
3. **429 retry with exponential backoff:** if ADO returns `Retry-After`, honour it. Max 3 retries. Surface partial data with a degraded-state banner if retries are exhausted.

### 3.2 Flag discovery

**Algorithm (from P0.2, verified live):**

```
1. GET /items?scopePath=/Features/Configuration/Features
           &recursionLevel=OneLevel
           &versionDescriptor.version=master
           &versionDescriptor.versionType=branch
   → ~13,282 items

2. Filter: path matches regex /FLT[^/]+\.json$/
   → ~42 paths (the FLT flag set)

3. Store as flagRegistry: Map<flagId, fmPath>
   e.g. "FLTArtifactBasedThrottling" → "Features/Configuration/Features/FLTArtifactBasedThrottling.json"
```

**Refresh:** Re-run step 1–2 on each `/api/ct/refresh`. New flags (added since last discovery) are appended to the registry. Removed flags (deleted from FM) are marked as `deleted` in the warm store but never purged within a session (the user should see them with a "Removed from master" badge).

### 3.3 Per-flag current state

```
For each flagPath in flagRegistry:
  GET /items?path={flagPath}
            &versionDescriptor.version=master
            &versionDescriptor.versionType=branch
  → raw JSON string

  Parse JSON → { Id, Description, Environments }
  
  For each of the 15 canonical envKeys:
    envBlock = Environments[envKey] ?? {}
    state = classifyState(envBlock)
      if (envBlock.Enabled === true)  → 'on'
      if (envBlock.Requires?.length)  → 'conditional'
      if (envBlock.Targets)           → 'targeted'
      else                            → 'off'
```

**Normalisation rule:** If any of the 15 canonical env keys is absent from the JSON `Environments` object, P2 normalises it to `{ state: 'off' }`. C01–C09 always receive all 15 keys. This is a P2 responsibility; no component should handle missing env keys.

### 3.4 Attribution mining — the consecutive-commit diff engine

This is the core data engine. It reconstructs **who changed what environment, when, and via which PR** by diffing the `Environments` block between consecutive commits for each flag file.

#### 3.4.1 Algorithm (from P0.2, verified live — reused verbatim)

```
For each flagPath in flagRegistry:
  1. commits = GET /commits?searchCriteria.itemPath={flagPath}
                           &searchCriteria.itemVersion.version=master
     → commit list, newest-first

  2. Reverse to oldest-first: commits.reverse()

  3. For i = 0 to commits.length - 1:
       currentCommit = commits[i]
       
       // Fetch content at this commitId (immutable — cache forever)
       currentContent = cache.get(currentCommit.commitId)
                     ?? fetchAndCache(flagPath, currentCommit.commitId)
       currentEnvs = parse(currentContent).Environments

       if i === 0:
         // First commit = file creation
         emit FileCreationEvent(currentCommit)
         previousEnvs = {}  // empty — everything is "new"
       else:
         previousCommit = commits[i - 1]
         previousContent = cache.get(previousCommit.commitId)
                        ?? fetchAndCache(flagPath, previousCommit.commitId)
         previousEnvs = parse(previousContent).Environments

       // Semantic diff: compare env blocks
       for each envKey in CANONICAL_15_ENVS:
         prevBlock = normaliseBlock(previousEnvs[envKey] ?? {})
         currBlock = normaliseBlock(currentEnvs[envKey] ?? {})
         
         if !deepEqual(prevBlock, currBlock):
           prevState = classifyState(prevBlock)
           currState = classifyState(currBlock)
           
           emit AttributionEvent {
             flagId, envKey,
             prevState, currState,
             author:   currentCommit.author.name,
             commitId: currentCommit.commitId,
             date:     currentCommit.author.date,
             prNumber: extractPR(currentCommit.comment),
             prUrl:    prNumber ? buildPrUrl(prNumber) : null
           }
```

#### 3.4.2 Normalisation for reformat-proofing

```typescript
function normaliseBlock(block: Record<string, unknown>): string {
  // Sort keys recursively + stringify for deep-equal comparison
  // This neutralises whitespace changes, key reordering, and
  // trailing-comma differences that would break naive JSON.stringify
  return JSON.stringify(sortKeysDeep(block));
}
```

This is the P0 risk R3 mitigation: line-`git blame` is explicitly disallowed because reformatting commits produce false attribution changes. The semantic `Environments`-diff approach is immune to reformatting.

#### 3.4.3 PR linkage

```typescript
function extractPR(commitMessage: string): number | null {
  const match = commitMessage.match(/Merged PR (\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function buildPrUrl(prNumber: number): string {
  return `https://powerbi.visualstudio.com/Power%20BI/_git/FeatureManagement/pullrequest/${prNumber}`;
}
```

#### 3.4.4 Immutable-commit content cache

```typescript
// src/engine/commit-cache.ts

/**
 * In-memory Map<commitId, ParsedFlagContent>.
 * commitId is a full 40-char SHA. Content at a given SHA is immutable —
 * once cached, NEVER re-fetched. This is the cornerstone optimisation:
 * after cold-load, incremental refreshes only fetch content for NEW commits.
 *
 * Memory budget: ~42 flags × ~50 commits × ~2 KB per parsed content ≈ 4.2 MB.
 * Well within a B1 App Service instance (1.75 GB RAM).
 */
const commitCache = new Map<string, ParsedFlagContent>();

interface ParsedFlagContent {
  id: string;
  description: string;
  environments: Record<string, Record<string, unknown>>;
  rawJson: string;  // kept for diff endpoint (C02 §2.8, C04 §3.2)
}
```

#### 3.4.5 Incremental refresh

On `POST /api/ct/refresh`:

```
For each flagPath in flagRegistry:
  1. Re-fetch commit list (GET /commits?... for this path)
  2. Compare with last-known commit list
  3. New commits = commits not in commitCache
  4. For each new commit: fetch content, cache by commitId, run attribution diff
  5. Append new AttributionEvents to the warm event store
```

Only new commits trigger content fetches. The immutable cache means a refresh after zero FM changes issues only 42 commit-list requests (lightweight) and zero content requests.

### 3.5 Warm event store

```typescript
// src/engine/event-store.ts

interface WarmEventStore {
  /** All attribution events across all flags, newest-first. */
  events: AttributionEvent[];
  /** Per-flag index for fast dossier/ladder lookups. */
  byFlag: Map<string, AttributionEvent[]>;
  /** Per-env index for sovereign-lens and activity-stream filtering. */
  byEnv: Map<EnvKey, AttributionEvent[]>;
  /** The newest commitId processed — used as the `since` cursor for incremental refresh. */
  headCommitId: string;
  /** ISO timestamp of last successful build/refresh. */
  builtAt: string;
}
```

The warm event store is built on first request (cold-load) and updated incrementally on each refresh. It is the single in-memory data structure from which all 8 API endpoints derive their responses. No endpoint re-walks commit history on its own.

---

## 4. Inert / Dependency Parser

This is the hardest, least-certain piece of the architecture. Dependencies are declared in **free-form English prose** in the `Description` field of FM JSON files. There is no structured `depends_on` field. The parser must extract structured dependency edges from unstructured text.

### 4.1 Honest assessment of uncertainty

**What we know (high confidence):**
- Of the 42 FLT flags, exactly **2** declare a hard prerequisite using "must be enabled" phrasing. Both point to the same non-FLT flag (`EnableFMVServiceAPIThrottling`).
- One flag (`FLTInsightsEngine`) uses negation language ("without requiring").
- The remaining 39 flags have no detectable dependency language.

**What is uncertain:**
- Future flag Descriptions may use novel phrasings we haven't seen.
- Non-FLT prerequisite flags may not exist in FM (unresolvable).
- Conditional×conditional overlap cannot be determined from config alone.

**Design posture:** Build a regex-based parser that handles all observed patterns with high confidence. Accept that novel phrasings will be missed. Err toward silence (no false positives) rather than coverage (catching every edge case). Monitor parse misses and add patterns iteratively.

### 4.2 Parser implementation

```typescript
// src/engine/dependency-parser.ts

interface DependencyEdge {
  sourceId: string;           // flag declaring the dependency
  prerequisiteId: string;     // referenced prerequisite
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  confidence: 'high' | 'medium' | 'low';
  negated: boolean;
  sourceExcerpt: string;      // exact matched sentence
  matchPattern: string;       // regex that matched (for auditability)
}

/**
 * Pattern tiers — ordered by confidence, applied sequentially.
 * (Defined by C06 §2.2.1 — reproduced here for Vex's implementation reference.)
 */
const PATTERN_TIERS: PatternTier[] = [
  {
    tier: 'T1',
    confidence: 'high',
    // "EnableFMVServiceAPIThrottling must be enabled"
    pattern: /(\b[A-Z][A-Za-z0-9_]+)\s+must\s+be\s+enabled/gi,
  },
  {
    tier: 'T2',
    confidence: 'high',
    // "requires EnableX" / "depends on EnableX" / "prerequisite: EnableX"
    pattern: /(?:requires|depends\s+on|prerequisite[:\s]+)\s*(\b[A-Z][A-Za-z0-9_]+)/gi,
  },
  {
    tier: 'T3',
    confidence: 'medium',
    // "when EnableX is enabled" / "if EnableX is on" / "only works with EnableX"
    pattern: /(?:when|if|only\s+works?\s+with)\s+(\b[A-Z][A-Za-z0-9_]+)\s+(?:is\s+)?(?:enabled|on|true)/gi,
  },
  // T4 is handled separately via token overlap with known flag IDs
];

/**
 * Negation patterns — if detected before a flag reference, the edge is marked negated.
 * (C06 §2.4)
 */
const NEGATION_PATTERNS = [
  /without\s+requiring/i,
  /does\s+not\s+depend\s+on/i,
  /independent\s+of/i,
  /no\s+dependency\s+on/i,
];
```

#### 4.2.1 Parse pipeline

```
function parseDescription(flagId: string, description: string, allKnownFlagIds: Set<string>):
  DependencyEdge[]

  edges = []

  // 1. Apply T1–T3 regex patterns
  for each tier in PATTERN_TIERS:
    for each match of tier.pattern in description:
      prereqId = match[1]
      if prereqId === flagId: continue  // self-reference — discard
      
      // Check for negation in the surrounding sentence
      sentence = extractSentence(description, match.index)
      negated = NEGATION_PATTERNS.some(p => p.test(sentence))
      
      edges.push({
        sourceId: flagId, prerequisiteId: prereqId,
        tier: tier.tier, confidence: tier.confidence,
        negated, sourceExcerpt: sentence, matchPattern: tier.pattern.source
      })

  // 2. T4: token overlap with known flag IDs (informational only)
  for each token in tokenize(description):
    if allKnownFlagIds.has(token) AND token !== flagId
       AND !edges.some(e => e.prerequisiteId === token):
      edges.push({
        sourceId: flagId, prerequisiteId: token,
        tier: 'T4', confidence: 'low', negated: false,
        sourceExcerpt: extractSentence(description, description.indexOf(token)),
        matchPattern: 'token-overlap'
      })

  return edges
```

#### 4.2.2 Known-flag-ID set for T4 matching

T4 matches against **all ~13,200 flag IDs** in FM (not just FLT-42). This set is built during flag discovery (§3.2) by including all item names (not just FLT-prefixed ones) from the `recursionLevel=OneLevel` listing. The full list is cached — it changes rarely and is cheap to fetch (it's the same API call as discovery, just without the FLT filter for the ID set).

**Perf note:** Storing 13K string IDs ≈ 500 KB. Tokenisation + set lookup is O(n·m) where n = description tokens (~50) and m = 1 (hash set lookup). Negligible.

### 4.3 Prerequisite resolution

```typescript
type PrereqResolution = 'resolved-flt' | 'resolved-external' | 'unresolved';

async function resolvePrerequisite(
  prereqId: string,
  fltRegistry: Map<string, string>,  // flagId → fmPath
  adoClient: AdoClient
): Promise<ResolvedPrerequisite> {

  // Case 1: prerequisite is in our FLT-42 set
  if (fltRegistry.has(prereqId)) {
    return {
      id: prereqId,
      resolution: 'resolved-flt',
      envStates: getEnvStatesFromWarmStore(prereqId),
      fmPath: fltRegistry.get(prereqId)!
    };
  }

  // Case 2: prerequisite is a non-FLT flag in FM
  const externalPath = `Features/Configuration/Features/${prereqId}.json`;
  try {
    const content = await adoClient.getContent(externalPath, { versionType: 'branch', version: 'master' });
    const parsed = JSON.parse(content);
    return {
      id: prereqId,
      resolution: 'resolved-external',
      envStates: classifyAllEnvs(parsed.Environments),
      fmPath: externalPath
    };
  } catch (e) {
    // Case 3: not found or fetch failed
    return { id: prereqId, resolution: 'unresolved', envStates: null };
  }
}
```

**Fetch strategy (resolves C06 §8.1 Q1):** On-demand with cache. External prerequisites are fetched only when a T1/T2 edge references them. The resolved state is cached by `(prereqId, masterHeadCommitId)` — invalidated on refresh. Currently only 1 external flag is referenced (`EnableFMVServiceAPIThrottling`), so this adds exactly 1 ADO request to the cold-load.

### 4.4 Chain walking

```
function walkChain(flagId, env, edges, resolvedStates, visited, depth):
  if depth > 3: log warning, return []  // hard cap per C06 §2.3
  if flagId in visited: return [CYCLE_DETECTED]  // cycle detection
  visited.add(flagId)
  
  chain = []
  for each edge where edge.sourceId === flagId AND edge.confidence >= 'medium' AND !edge.negated:
    prereqState = resolvedStates[edge.prerequisiteId]?.[env]
    
    if prereqState === undefined:
      chain.push({ flagId: edge.prerequisiteId, stateInEnv: 'unknown', isBlocker: false })
    else if prereqState === 'off':
      chain.push({ flagId: edge.prerequisiteId, stateInEnv: 'off', isBlocker: true })
    else:
      // Prereq is on — recurse into its dependencies
      subChain = walkChain(edge.prerequisiteId, env, edges, resolvedStates, visited, depth + 1)
      chain.push({ flagId: edge.prerequisiteId, stateInEnv: prereqState, isBlocker: false })
      chain.push(...subChain)
  
  return chain
```

### 4.5 Fallback and graceful degradation

| Failure mode | Behaviour |
|---|---|
| Description is empty or has no detectable pattern | No edges emitted. Flag shows no dependency information. Not an error. |
| External prerequisite fetch fails (network/auth) | Edge is emitted but prerequisite resolution = `unresolved`. Finding is `INFORMATIONAL`, never `INERT`. A banner: "External prerequisite states could not be fetched." |
| Parser matches a false flag name (e.g., "Enable" in prose is not a flag) | T1/T2/T3 regexes require a CamelCase token starting with uppercase. Short words like "Enable" alone won't match without the surrounding pattern. T4 checks against the known-flag-ID set, so random words are filtered. |
| Novel phrasing not covered by T1–T3 | Missed. Parser logs Descriptions containing flag-name tokens that matched no T1–T3 pattern (potential misses) for human review. |

### 4.6 Parser diagnostics

On every parse run, the parser emits a diagnostics payload:

```typescript
interface ParserDiagnostics {
  flagsAnalyzed: number;
  edgesExtracted: number;
  prerequisitesResolved: number;
  prerequisitesUnresolved: number;
  externalFlagsFetched: number;
  /** Descriptions containing known flag IDs but no T1–T3 match (potential misses). */
  potentialMisses: Array<{ flagId: string; mentionedIds: string[]; excerpt: string }>;
  /** Negation patterns detected. */
  negationsDetected: Array<{ flagId: string; prereqId: string; sentence: string }>;
  /** Chain depth warnings (depth > 3). */
  chainDepthWarnings: Array<{ rootFlagId: string; depth: number }>;
}
```

This is logged server-side and included in the `InertIntelligencePayload.parserMeta` response (C06 §5.5) for transparency.

---

## 5. Derivation Layer

All derivations are computed **server-side** from the warm event store (§3.5). No derivation logic runs in the browser. The browser receives pre-computed values.

### 5.1 StaleReason derivation

**Authority:** C06 §4.3 is canonical. This section references it without redefinition.

```typescript
// src/engine/stale-reason.ts

function deriveStaleReason(
  flagId: string,
  envStates: Record<EnvKey, CellState>,
  daysSinceLastChange: number
): StaleReason {
  const mainlineEnvs: EnvKey[] = ['onebox', 'test', 'cst', 'daily', 'dxt', 'msit', 'prod'];
  const allEnvs = CANONICAL_15_ENVS;

  const mainlineOnCount = mainlineEnvs.filter(e => envStates[e] !== 'off').length;
  const allOffCount = allEnvs.filter(e => envStates[e] === 'off').length;
  const hasPartialMainline = mainlineOnCount >= 1 && mainlineOnCount < 7;

  // Priority order (first match wins — C06 §4.3)
  if (daysSinceLastChange < 30 && hasPartialMainline) return 'ACTIVE_ROLLOUT';
  if (allOffCount === 15 && daysSinceLastChange >= 90) return 'PROBABLY_DEAD';
  if (mainlineOnCount === 7 && daysSinceLastChange >= 90) return 'PROBABLY_LAUNCHED';
  if (hasPartialMainline && daysSinceLastChange >= 180) return 'PROBABLY_FORGOTTEN';
  return null;  // STABLE — no label
}
```

**Thresholds:** `30 / 90 / 180` days. Per C06 §8.1 Q3, these ship as initial values and are stored in a server-side config object (`src/engine/config.ts`) so PMs can tune without code changes:

```typescript
// src/engine/config.ts
export const STALE_THRESHOLDS = {
  activeRolloutDays: 30,
  probablyDeadDays: 90,
  probablyLaunchedDays: 90,
  probablyForgottenDays: 180,
};
```

### 5.2 Dwell computation

**Authority:** `data-model.md` §7 (canonical dwell rule).

```typescript
function computeDwell(
  flagId: string,
  events: AttributionEvent[]
): RungDwell[] {
  const ladderOrder: LadderEnv[] = ['test', 'cst', 'daily', 'dxt', 'msit', 'prod'];
  
  // For each rung, find firstEnabledDate = earliest event where state ∈ {on, conditional, targeted}
  const firstEnabled: Map<LadderEnv, Date> = new Map();
  for (const rung of ladderOrder) {
    const enableEvent = events
      .filter(e => e.env === rung && e.currState !== 'off')
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];
    if (enableEvent) firstEnabled.set(rung, new Date(enableEvent.date));
  }
  
  // Compute dwell between consecutive enabled rungs
  const dwells: RungDwell[] = [];
  const enabledRungs = ladderOrder.filter(r => firstEnabled.has(r));
  
  for (let i = 0; i < enabledRungs.length; i++) {
    const rung = enabledRungs[i];
    const nextRung = enabledRungs[i + 1];
    const rungDate = firstEnabled.get(rung)!;
    
    if (nextRung) {
      const nextDate = firstEnabled.get(nextRung)!;
      const dwellDays = Math.round((nextDate.getTime() - rungDate.getTime()) / 86400000);
      dwells.push({ rung, nextRung, dwellDays, dwellLabel: formatDwell(dwellDays), isCurrent: false });
    } else {
      // Current highest rung — dwell is ongoing
      const dwellDays = Math.round((Date.now() - rungDate.getTime()) / 86400000);
      dwells.push({ rung, dwellDays, dwellLabel: formatDwell(dwellDays), isCurrent: true });
    }
  }
  
  return dwells;
}
```

**Contract anchor (from C03 §1.4):** `FLTArtifactBasedThrottling` must produce: test dwell=8d, cst=0d, daily=12d, dxt=7d, msit=7d. Total test-to-prod=37d.

### 5.3 Velocity metrics

Computed in the `/api/ct/velocity` handler from the warm event store:

- **Time-to-prod (TTP):** `prodFirstFullyOnDate - testFirstEnabledDate` (calendar days).
- **Partial TTP:** `prodFirstNonOffDate - testFirstEnabledDate` (when prod is targeted/conditional but not yet fully on).
- **Cohort statistics:** median, p25, p75, fastest, slowest — computed only when ≥3 fully-rolled-out flags exist.
- **Per-rung median dwell:** median of `dwellDays` across all flags that have dwelt at each rung.
- **Quarterly trend:** flags reaching `prod=on` bucketed by quarter.

All computed per C08 §3.1 type definitions. No recomputation in the browser.

### 5.4 Sovereign gap analysis

Per C07 §2.2: for each `(flag, sovereignEnv)`, compare the sovereign cell state to the `prod` cell state and emit a `GapKind` classification:

```typescript
function classifyGap(prodState: CellState, cloudState: CellState): GapKind | null {
  if (prodState === cloudState) return null;
  if (prodState === 'off' && cloudState === 'off') return null;
  
  const key = `${prodState}_${cloudState}` as const;
  const GAP_MAP: Record<string, GapKind> = {
    'on_off':          'prod_on_cloud_off',
    'on_conditional':  'prod_on_cloud_cond',
    'on_targeted':     'prod_on_cloud_target',
    'conditional_off': 'prod_cond_cloud_off',
    'targeted_off':    'prod_target_cloud_off',
    'off_on':          'cloud_on_prod_off',
    'conditional_on':  'cloud_on_prod_cond',   // re-mapped to cloud_on_prod_cond per C07
    'off_conditional': 'cloud_cond_prod_off',
  };
  return GAP_MAP[key] ?? null;
}
```

---

## 6. Refresh & Caching Strategy

### 6.1 Cache taxonomy

| Cache layer | Keyed by | TTL | Invalidation | Contents |
|---|---|---|---|---|
| **Commit content cache** | `commitId` (40-char SHA) | ∞ (immutable) | Never. A commit SHA maps to exactly one content snapshot forever. | `ParsedFlagContent` — the parsed JSON of a flag file at a specific commit. |
| **Flag discovery cache** | `masterHeadCommitId` | Until next refresh | `POST /api/ct/refresh` | The list of ~42 FLT flag paths. |
| **Warm event store** | (global singleton) | Until next refresh | Rebuilt incrementally on refresh | All `AttributionEvent[]`, indexed by flag and env. |
| **Derived data cache** | `masterHeadCommitId` | Until next refresh | Rebuilt from warm store on refresh | Grid rows, dossier payloads, ladder data, velocity records, inert findings, stale observations, sovereign-lens data. |
| **Time Travel memos** | `asOfDate + commitListHash` | Until next refresh | Refresh invalidates memos (commit lists may have changed) but not the commit content cache. | `TimeTravelResponse` per requested date. |

### 6.2 Fresh-from-`master` model

Control Tower maintains data freshness through a lightweight passive poll, explicit refresh, and optional auto-refresh:

1. **Cold-load:** The first request after server start triggers a full build of the warm store. Subsequent requests within the same server lifetime are served from the warm store.
2. **Passive freshness poll (V1):** The client polls `GET /api/ct/updates` on a **60-second** interval to detect whether `master` HEAD has advanced beyond the warm store's `headCommitId`. This endpoint makes exactly **one cheap ADO call** — the "get latest commit on the FLT scope path" query (`searchCriteria.itemPath` + `$top=1`) — and compares the remote HEAD to the warm store's `headCommitId`, returning `{ newerHeadAvailable, pendingCommitCount }`. It does **not** trigger a mine or touch the warm store. When `newerHeadAvailable` is true, the shell surfaces a non-blocking banner: `"N new events — Refresh"`. Polling is paused via the Page Visibility API when the tab is hidden. (The freshness *chip* itself is driven separately by `GET /api/ct/freshness`, which is metadata-only and never calls ADO.)
3. **Explicit refresh:** The user clicks the Refresh button (C09 §5) or responds to the freshness banner. This triggers `POST /api/ct/refresh`, which incrementally fetches new commits per flag and **atomically** applies the result — all staged updates are committed only if every flag succeeds; on any failure the warm store is unchanged (rolled back to the last-good vintage).
4. **Opt-in auto-refresh (V1):** C04's auto-refresh toggle (default OFF) allows the user to opt in to automatic refreshes. When enabled and the passive poll detects new commits, the atomic refresh is triggered automatically without user interaction.

FM changes are infrequent (~1–3 per day for FLT flags), and the audience is small (~10 PMs). The 60-second poll is cheap because `/api/ct/updates` issues a single `$top=1` commit query (not a mine); at ~10 active users that is ~10 ADO requests/minute — negligible against the per-user 5-minute rate window. Polling pauses on hidden tabs, so idle sessions cost nothing.

### 6.3 Stale indicator

Per C09 §7.2: if `(now - syncedAt) > 60 minutes`, the freshness chip in the shell turns amber and shows "Data as of [time] — Refresh". If the last refresh failed, the chip turns red.

### 6.4 Cold-load performance budget

| Phase | ADO requests | Estimated time (p95) |
|---|---|---|
| Flag discovery | 1 | 1s |
| Current state (42 flags) | 42 | 3s (parallel, 10 concurrent) |
| Commit lists (42 flags) | 42 | 3s (parallel) |
| Historical content (~50 commits × 42 flags) | ~2,100 | 20s (parallel, 10 concurrent, throttled) |
| Attribution diffing | 0 (CPU-only) | 2s |
| Derivation (stale, dwell, velocity, inert, sovereign) | 0–1 (external prereq) | 1s |
| **Total cold-load** | **~2,185** | **~30s** |

**Mitigation for cold-load latency:**
- Show the Grid immediately from current-state data (42 requests, ~4s). Attribution, timeline, dwell, and stale columns populate progressively as the historical walk completes.
- A progress indicator in the shell: "Building attribution history… 23/42 flags complete."

### 6.5 ADO rate-limit posture

ADO's documented rate limit is a per-user, per-5-minute sliding window. The exact limit varies by ADO org tier but is typically 1,000–5,000 requests per 5 minutes. Our cold-load of ~2,185 requests fits within a single window. However:

- **Concurrency cap:** Max 10 concurrent requests per user. This prevents burst-triggered 429 responses.
- **429 handling:** If a 429 is received, the client reads the `Retry-After` header and backs off. Max 3 retries per request. If exhausted during a **cold-load** (first build), the missing flag is marked as a gap and the Grid renders the rest with the R1 loading interstitial for incomplete flags — this is a cold-load gap, NOT a refresh state. (An explicit **refresh** is atomic per §7.2: a 429 during refresh rolls the whole batch back to last-good; it never serves mixed-vintage data.)
- **After cold-load:** Incremental refreshes issue ~42 commit-list requests + 0–5 content requests. Well within limits.

---

## 7. API Surface

All endpoints live under `/api/ct/` (data-model.md §6). All are Next.js server-side route handlers. All require an authenticated session (§2). All ADO calls use the signed-in user's delegated token. The browser never receives ADO tokens or raw FM JSON.

### 7.1 Endpoint catalogue

| # | Method + Path | Source spec | Response type | Cache behaviour |
|---|---|---|---|---|
| 1 | `GET /api/ct/grid` | C01 §2.2 | `ControlTowerGridResponse` | Served from derived cache. Stale after 60 min. |
| 2 | `GET /api/ct/flag/:flagId/dossier` | C02 §2.7 | `DossierPayload` | Served from derived cache. Timeline entries are commitId-keyed (immutable). |
| 3 | `GET /api/ct/flag/:flagId/timeline/:commitId/diff` | C02 §2.8 | `EnvsDiff` | Immutable. Browser may cache indefinitely. |
| 4 | `GET /api/ct/ladder/distribution` | C03 §2.4 | `LadderDistributionResponse` | Served from derived cache. |
| 5 | `GET /api/ct/ladder/flag/:flagId` | C03 §2.4 | `PerFlagLadderResponse` | Served from derived cache. |
| 6 | `GET /api/ct/activity` | C04 §3.1 | `ActivityStreamResponse` | Not browser-cached. Server filters from warm event store. |
| 7 | `GET /api/ct/activity/diff/:eventId` | C04 §3.2 | `EnvDiffDetail` | Immutable (commitId-anchored). |
| 8 | `GET /api/ct/activity/timeline` | C04 §3.3 | `TimelineSummaryResponse` | Not browser-cached. |
| 9 | `GET /api/ct/time-travel/bounds` | C05 §2.4 | `TimeTravelBounds` | Served from derived cache until refresh. |
| 10 | `POST /api/ct/time-travel/reconstruct` | C05 §2.4 | `TimeTravelResponse` | Memoized by `asOfDate + commitListHash`. |
| 11 | `GET /api/ct/inert` | C06 §5.5 | `InertIntelligencePayload` | Served from derived cache. |
| 12 | `GET /api/ct/sovereign-lens` | C07 §2.1 | `SovereignLensResponse` | Served from derived cache. |
| 13 | `GET /api/ct/velocity` | C08 §3.2 | `VelocityResponse` | Served from derived cache. |
| 14 | `GET /api/ct/freshness` | C09 §7.2 | `FreshnessPayload` | Live — reads warm store metadata directly. Never calls ADO. |
| 15 | `GET /api/ct/updates` | C09 §7.2 | `UpdatesCheckPayload` | Live — one cheap ADO `$top=1` HEAD check. Drives the 60s passive poll + "N new events" banner. |
| 16 | `POST /api/ct/refresh` | C09 §7.4 | `RefreshResponse` | N/A — triggers atomic warm store advance. |
| 17 | `GET /api/ct/health` | (new — ops) | `{ status, uptime, cacheStats }` | Live. |

### 7.2 Error response convention

All endpoints return a consistent error shape on failure:

```typescript
interface ApiError {
  ok: false;
  error: string;       // machine-readable code: 'ADO_UNREACHABLE' | 'RATE_LIMITED' | 'PARSE_ERROR' | 'NOT_FOUND' | 'UNAUTHORIZED'
  message: string;     // human-readable detail
  retryAfterSeconds?: number;  // present when error = 'RATE_LIMITED'
  staleData?: unknown;         // last-known-good data when available (graceful degradation)
  staleSyncedAt?: string;
}
```

**Graceful degradation rule:** Refresh is **atomic** (all-or-nothing). The warm store either advances to the new HEAD in full, or rolls back to the last-good vintage — there is no partial-commit state. On refresh failure, endpoints continue serving last-good data from the warm store with `stale: true` in their metadata. The browser shows `"Refresh incomplete — showing last-good data from {relativeTime}. ↻ Try again"` and `appState → stale-error`. A total failure with no warm store (i.e. first cold-load failed) returns the error shape above with no `staleData`.

### 7.3 Read-only enforcement

**Hard constraint (spec.md §3):** Zero POST/PUT/DELETE endpoints that modify FM data or any external system. The only POST endpoints are:
- `POST /api/ct/refresh` — reads from ADO; writes nothing.
- `POST /api/ct/time-travel/reconstruct` — a query with a body (POST because of the body shape); writes nothing.

Sentinel must block any PR that introduces a write path to any external system.

---

## 8. End-to-End Data Flow

### 8.1 Sequence: "User opens portal for the first time"

```
 Browser          Next.js Server           MSAL / Entra        ADO REST API
   │                    │                       │                    │
   │ 1. GET /           │                       │                    │
   │ ──────────────────>│                       │                    │
   │                    │ 2. No session →        │                    │
   │ 3. 302 /auth/signin                        │                    │
   │ <──────────────────│                       │                    │
   │                    │                       │                    │
   │ 4. Entra login + consent                   │                    │
   │ ──────────────────────────────────────────>│                    │
   │                    │                       │                    │
   │ 5. Callback + code │                       │                    │
   │ ──────────────────>│                       │                    │
   │                    │ 6. acquireTokenByCode  │                    │
   │                    │ ─────────────────────>│                    │
   │                    │ 7. access + refresh   │                    │
   │                    │ <─────────────────────│                    │
   │                    │                       │                    │
   │ 8. Set-Cookie      │                       │                    │
   │ <──────────────────│                       │                    │
   │                    │                       │                    │
   │ 9. Client renders  │                       │                    │
   │    shell + GET     │                       │                    │
   │    /api/ct/grid    │                       │                    │
   │ ──────────────────>│                       │                    │
   │                    │                       │                    │
   │                    │ 10. Cold-load: warm store empty            │
   │                    │     a. Discover flags (1 req)              │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │                    │     b. Fetch current state (42 req)       │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │ 11. Partial: grid  │                                            │
   │     (state-only,   │                                            │
   │      no attribution│                                            │
   │      yet)          │                                            │
   │ <──────────────────│                                            │
   │                    │                                            │
   │                    │     c. Fetch commit lists (42 req)        │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │                    │     d. Walk history, fetch content,       │
   │                    │        build attribution (~2100 req)      │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │                    │     e. Run derivations (CPU-only)         │
   │                    │        - StaleReason per flag             │
   │                    │        - Dwell per flag                   │
   │                    │        - Velocity metrics                 │
   │                    │        - Inert / dependency parse         │
   │                    │        - Sovereign gap analysis           │
   │                    │                                            │
   │ 12. Full: grid     │                                            │
   │     (with attrib,  │                                            │
   │      stale hints,  │                                            │
   │      prereqs)      │                                            │
   │ <──────────────────│                                            │
   │                    │                                            │
   │ 13. User navigates │                                            │
   │     to /flag/X     │                                            │
   │ ──────────────────>│                                            │
   │                    │ 14. Serve DossierPayload                  │
   │ 15. Rendered       │     from warm store (instant)             │
   │ <──────────────────│                                            │
```

### 8.2 Sequence: "User clicks Refresh"

```
 Browser          Next.js Server                                ADO REST API
   │                    │                                            │
   │ POST /api/ct/      │                                            │
   │   refresh          │                                            │
   │ ──────────────────>│                                            │
   │                    │ 1. Re-discover flags (1 req)              │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │                    │ 2. Re-fetch commit lists (42 req)         │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │                    │ 3. Identify new commits                   │
   │                    │    (commits not in commitCache)           │
   │                    │                                            │
   │                    │ 4. Fetch new commit content (0–5 req)     │
   │                    │ ─────────────────────────────────────────>│
   │                    │ <─────────────────────────────────────────│
   │                    │                                            │
   │                    │ 5. Diff new commits → new events          │
   │                    │ 6. Append to warm event store             │
   │                    │ 7. Re-derive all cached payloads          │
   │                    │                                            │
   │ RefreshResponse    │                                            │
   │ <──────────────────│                                            │
   │                    │                                            │
   │ GET /api/ct/grid   │                                            │
   │ ──────────────────>│                                            │
   │ Fresh grid data    │                                            │
   │ <──────────────────│                                            │
```

### 8.3 Data flow summary (one-liner per layer)

```
ADO Git REST ──► ADO Client ──► Flag Discovery + Content Fetch
                                        │
                                        ▼
                              Attribution Miner (commit-diff engine)
                                        │
                                        ▼
                              Warm Event Store (in-memory)
                                        │
                 ┌──────────┬───────────┼───────────┬──────────┐
                 ▼          ▼           ▼           ▼          ▼
            Dependency   StaleReason  Dwell /    Sovereign   Time Travel
            Parser       Derivation   Velocity   Gap Analyzer Reconstructor
                 │          │           │           │          │
                 ▼          ▼           ▼           ▼          ▼
              Derived Data Cache (per masterHeadCommitId)
                                        │
                                        ▼
                              /api/ct/* Route Handlers
                                        │
                                        ▼
                              Browser (rendered data only)
```

---

## 9. OSS Build-vs-Buy Track

### 9.1 Guiding principle

> **"Buy the plumbing, build the intelligence."**

**Validated.** The plumbing (auth, HTTP client, data-fetching, grid rendering, command palette) is well-served by world-class OSS. The intelligence (attribution miner, prose→dependency parser, inert evaluator, stale-reason classifier) encodes FLT-specific semantics that no OSS library knows. Building these is our moat.

### 9.2 Recommendation table

| # | Layer | Decision | Chosen tool | Rationale | World-class? Why |
|---|---|---|---|---|---|
| 1 | **Framework** | BUY | **Next.js 14+** (App Router) | F30 is a standalone hosted web app, framework-eligible (ADR-002/003 govern the embedded EDOG studio, not this portal). Next.js gives us file-based routing, server-side route handlers (critical for token-hiding), and static optimisation for the shell. | ✅ Industry standard. 1M+ weekly downloads. Vercel and Azure both support it natively. |
| 2 | **Auth (Entra login)** | BUY | **@azure/msal-node** + **Auth.js v5** | MSAL is Microsoft's own Entra SDK — no alternative for correct auth-code + refresh-token lifecycle with ADO scope. Auth.js handles session cookies on top. Using both is standard in MS-internal Next.js apps. | ✅ MSAL is the canonical Entra client. Auth.js is the dominant Next.js auth framework (24K GitHub stars). |
| 3 | **ADO REST calls** | BUILD (light) | **Native `fetch`** with a thin typed wrapper (`src/engine/ado-client.ts`) | The official `azure-devops-node-api` SDK is heavyweight (pulls in many sub-packages) and its Git API typing is shallow — we'd still write wrappers. A thin `fetch` wrapper with typed request/response interfaces is simpler, smaller, and gives us full control over retry/throttle logic. | N/A — bespoke, but trivial. ~200 lines. |
| 4 | **Server-state management** | BUY | **TanStack Query v5** (React Query) | Handles client-side cache, stale-while-revalidate, background refresh, error/loading states, and deduplication. Eliminates hand-rolled `useEffect` + `useState` fetch boilerplate for all 16 endpoints. | ✅ The industry standard for server-state in React (36K GitHub stars, 3M+ weekly downloads). |
| 5 | **Grid (C01)** | BUY | **TanStack Table v8** | Headless, zero-CSS, fully typed. Handles sorting, filtering, column pinning, and column visibility — all things C01 needs. 42 rows × 15 columns is small enough that we don't need virtualisation. | ✅ The industry standard headless table for React (25K GitHub stars). |
| 6 | **Virtualisation** | SKIP | — | 42 rows do not need virtualisation. TanStack Virtual is excellent but adds complexity for zero benefit at this scale. Revisit only if the flag count exceeds 200. | N/A |
| 7 | **Cmd-K palette (C09)** | BUY | **cmdk** | Tiny (~3 KB gzipped), composable, accessible, keyboard-first. Exactly what C09 §3 specifies. No alternative is as purpose-built or as small. | ✅ Created by Rauno Freiberg (Vercel). Used by Vercel, Linear, Raycast. Best-in-class for this exact use case. |
| 8 | **Timeline / diff viz (C03, C04, C05)** | BUILD | **Bespoke SVG/Canvas** | visx is powerful but heavy (~180 KB) and brings a d3 abstraction layer we don't need. Our timeline is a simple horizontal dot strip (C04 §4.1) and a linear track with dwell segments (C03 §3.2). These are 50–100 lines of inline SVG each — far simpler than pulling in a charting library. The diff view (C02, C04) is JSON key-value comparison, not a chart. | N/A — bespoke, but intentionally minimal. visx is world-class for complex data-viz; our viz needs are simple enough that visx would be over-engineering. |
| 9 | **Attribution miner** | BUILD | **Bespoke** (`src/engine/attribution-miner.ts`) | The consecutive-commit `Environments`-diff algorithm (§3.4) is FLT-specific. No OSS library mines git history for per-key JSON diffs with reformat-proofing and PR linkage. This is the data engine's core. | N/A — this is the moat. |
| 10 | **Prose → dependency parser** | BUILD | **Bespoke** (`src/engine/dependency-parser.ts`) | No OSS library parses FM flag Description prose for prerequisite flag references with tiered confidence, negation detection, and chain walking. This is the hero intelligence feature. | N/A — this is the other moat. |
| 11 | **Inert evaluator + stale classifier** | BUILD | **Bespoke** (`src/engine/inert-evaluator.ts`, `src/engine/stale-reason.ts`) | These encode C06 §3–4 business rules. Trivial code (~150 lines each) but wholly domain-specific. | N/A — domain logic, not infrastructure. |
| 12 | **Styling** | BUY (light) | **CSS Modules** (built into Next.js) + design-bible tokens | No CSS framework (Tailwind, etc.). The design bible defines a token system; CSS Modules scope styles per component. This matches the house style and avoids a dependency for ~2,000 lines of CSS. | ✅ Built into Next.js. Zero-config. |
| 13 | **Date handling** | BUY | **date-fns** | Lightweight (~5 KB tree-shaken), immutable, pure-function API. Used for dwell formatting, relative-time display, and calendar-day arithmetic. Moment.js is dead; dayjs is fine but date-fns tree-shakes better. | ✅ 34K GitHub stars, 25M+ weekly downloads. The de-facto replacement for Moment. |

### 9.3 Dependency budget

```
@azure/msal-node     ~150 KB   (auth — non-negotiable)
next-auth             ~80 KB   (session management)
@tanstack/react-query ~40 KB   (server-state)
@tanstack/react-table ~30 KB   (headless grid)
cmdk                  ~3 KB    (command palette)
date-fns              ~5 KB    (tree-shaken date utils)
─────────────────────────────
Total added deps     ~308 KB   (pre-gzip; ~90 KB gzipped)
```

**Principle:** Every dependency on this list is best-in-class for its exact purpose, actively maintained, and has a clear upgrade path. No "just-in-case" dependencies. visx is explicitly excluded because our viz needs are simpler than its complexity warrants.

---

## 10. P2 Open Questions

### 10.0 CEO Rulings (P2 gate — RESOLVED 2026-06-13)

| # | Ruling |
|---|---|
| OQ-01 | ✅ **Azure App Service.** Vercel retained as code-swappable fallback via `PlatformAdapter`. |
| OQ-02 | ✅ **App Service Easy Auth.** Use built-in App Service Authentication to auto-provision the Entra OAuth client (registration is the OAuth front door only — data is still read as the delegated signed-in user; no service principal touches FM). **Design refinement:** Easy Auth performs the auth-code exchange and stores the ADO access token in the App Service token store; the app retrieves it from the token store rather than running its own MSAL auth-code flow. MSAL/Auth.js reduce to session glue + token-refresh handling. §2 to be refined accordingly in P3. |
| OQ-03 | ✅ **Progressive rendering approved.** Grid in ~4s (state-only), attribution fills asynchronously. |
| OQ-04 | ✅ **256 KB max diff payload.** Larger → "View raw in repo ↗" link. |
| OQ-05 | ✅ **30 / 90 / 180 day thresholds.** Configurable post-launch. |
| OQ-06 | ✅ **Skip visx for V1** (bespoke inline SVG). Re-evaluate only if a future view needs scatter/area charts. |
| OQ-07 | ✅ **Single instance for V1** (in-memory warm store). Migrate to Redis only past ~50 users or under memory pressure; seam already in place. |

**P2 GATE: PASSED.**

---

Items needing a **CEO ruling** at the P2 gate before P3 can start:

| # | Question | Context | Sana's recommendation | Impact if deferred |
|---|---|---|---|---|
| OQ-01 | **Final hosting target: Azure App Service or Vercel?** | §1.1 presents the trade-off. Architecture is designed to be swappable, but provisioning and deployment pipeline differ. | **Azure App Service (B1).** In-memory warm store is simpler, MI is available, same-tenant compliance. | Blocks deployment pipeline setup. Does not block P3–P5 (code is hosting-agnostic). |
| OQ-02 | **Entra app registration: create now or defer?** | §2.3 requires an Entra app registration with ADO scope. This is an Azure AD admin action, not a code change. | **Create now.** It's a 5-minute portal action and is the longest-lead dependency for end-to-end auth testing. | Blocks integration testing of auth flow. |
| OQ-03 | **Cold-load progressive rendering: show grid immediately with state-only data, or wait for full attribution?** | §8.1 shows a ~30s cold-load. Progressive rendering shows the grid in ~4s with attribution filling in. | **Progressive rendering.** 30s of blank screen is unacceptable. Grid state is useful without attribution. | UX decision. Affects C01 loading states in P3. |
| OQ-04 | **Maximum diff payload size for C02/C04 detail panels?** | C02 §2.8 mentions 256 KB hard limit. Some flag JSONs with large `Targets` blocks could exceed this. | **256 KB.** Anything larger gets a "View raw in repo ↗" link instead. | Minor. Affects edge-case UX only. |
| OQ-05 | **Stale-reason day thresholds: 30/90/180 or different?** | C06 §8.1 Q3 recommends these as initial values. They're stored in config (§5.1) and can be changed without a code deploy. | **Ship 30/90/180.** Tune based on PM feedback after V1 launch. | None — configurable post-launch. |
| OQ-06 | **Should visx be adopted for future viz needs (C03 timeline, C04 dot strip)?** | §9.2 row 8 recommends bespoke SVG. If future views require more complex charting (e.g., stacked area for velocity trends), visx becomes more justified. | **Skip for V1. Re-evaluate if C08 velocity requires scatter/area charts in a future version.** | None for V1. |
| OQ-07 | **Multi-instance scaling: in-memory cache vs. Redis?** | §2.5 notes that a single B1 instance is sufficient for ~10 users. If the audience grows, a distributed cache is needed. | **Single instance for V1.** The architecture is pluggable (MSAL cache plugin, warm store behind an interface). Migrate to Redis only if user count exceeds 50 or if App Service health checks show memory pressure. | None for V1. Architectural seam is in place. |

### 10.1 Risks carried forward from P0/P1

| # | Risk | Severity | Mitigation (from this architecture) |
|---|---|---|---|
| R1 | False-positive inert claims | CRITICAL | §4 parser design: T4 never promotes to inert; negation detection; `unresolved` → `INFORMATIONAL` only; credibility contract (C06 §3.3) enforced by Sentinel. |
| R2 | Cold-load takes 30s | HIGH | §8.1 progressive rendering: grid in ~4s, attribution fills in. §6.4 performance budget. Concurrency-capped parallel fetch. |
| R3 | ADO rate-limit hit during cold-load | MEDIUM | §6.5: concurrency cap (10), 429 retry with backoff, partial-data fallback. |
| R4 | MSAL token refresh fails mid-session | LOW | §2.5: MSAL handles refresh transparently. On failure → 401 → Auth.js re-auth redirect. User sees "Session expired — sign in again." |
| R5 | External prerequisite flag doesn't exist in FM | LOW | §4.3: resolution = `unresolved`, finding = `INFORMATIONAL`. No false positive. |

---

*Sana — architecture lead. Vex implements the data engine (§3–§5). Pixel wires the views to the API surface (§7). Sentinel gates every commit.*
