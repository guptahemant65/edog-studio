# P0 — Foundation Research (F30 Control Tower)

> **Gate status:** P0.1 ✅ · P0.2 ✅ (live, incl. RESOLVED Vercel+Entra delegated auth) · P0.3 ✅ · **P0 GATE PASSED — CEO signed off 2026-06-13. P1 open.**
> Everything below P0.1/P0.2 was proven by reading real code and running real ADO REST calls — not designed in the abstract.

---

## P0.1 — Existing-code audit (what exists, what to reuse, what NOT to reuse)

### EDOG's own flag mechanism — and why Control Tower must NOT reuse it
- `EdogFeatureFlighterWrapper.cs:61-67` short-circuits the real `IFeatureFlighter`: if a flag is in the local override store it returns the override **before** delegating to the real flighter.
- `EdogFeatureOverrideStore.cs` is an **in-memory `FrozenDictionary`** living inside **one developer's running FLT process**. It is the F11/C03 force-ON panel's backend.
- **Verdict:** wrong data source for a PM portal. It reflects one dev's local overrides for one process, not org-wide rollout truth. Control Tower reads the **FM repo**, never this store. (This is the single most important "don't fork it" finding — Ram's idea, when grounded, points to a *separate* product.)

### The FLT flag registry (reusable as a display-name / description source)
- `workload-fabriclivetable/Service/Microsoft.LiveTable.Service/FeatureFlightProvider/FeatureNames.cs` maps wire name ↔ C# const with rich XML doc-comments (sometimes deeper than the FM JSON `Description`). Useful as a **secondary** display/description source, and to confirm which flags are genuinely FLT-owned. Not the source of rollout state.

### Prior art to mirror (process + format)
- **F11-environment-panel** is the closest existing feature and the format template (`research/p0-foundation.md`, `components/C0N-*.md`, `architecture.md`, `states/`, `mocks/`). Control Tower mirrors its house structure.

---

## P0.2 — Data-source map (the FeatureManagement repo) — verified live

### The repo
- **Repo:** `https://powerbi.visualstudio.com/DefaultCollection/Power%20BI/_git/FeatureManagement` (ADO org `powerbi`, project `Power BI`, repo `FeatureManagement`).
- **Default branch is `master`** (not `main`). All reads pin `versionDescriptor.version=master`.
- It is a **giant shared monorepo: ~13,203 feature files** under `Features/Configuration/Features/`. **Only ~42–43 match `FLT*.json`.** Curation to the FLT prefix is mandatory; we never surface the rest.

### Per-flag schema (verified by reading sample + complex flags)
One JSON file per flag:
```jsonc
{
  "Id": "FLTArtifactBasedThrottling",
  "Description": "<human-written, often detailed — already in-repo>",
  "Environments": { "test": {...}, "cst": {...}, /* …15 envs… */ }
}
```
- **The `Description` is already human-authored in the repo** — no separate `flags.json` metadata file is needed (an earlier idea, now killed). Where the JSON Description is thin, fall back to `FeatureNames.cs` XML docs.

### 15 environments (ladder + region order — verified)
`onebox, test, cst, daily, dxt, msit, prod, mc (Mooncake), gcc, gcchigh, dod, usnat, ussec, bleu, usgovcanary`
- **Promotion ladder (6, the spine of the Rollout Ladder view):** `test → cst → daily → dxt → msit → prod`.
- **Sovereign clouds (7, the Compliance lens):** `mc, gcc, gcchigh, dod, usnat, ussec, usgovcanary`.

### 4 env-state shapes (not boolean — this drives every cell render)
| Shape in JSON | Meaning | Grid render | FLT-file frequency |
|---|---|---|---|
| `{}` (empty / key absent) | **Off** | empty/neutral | — |
| `{"Enabled": true}` | **On** (full) | filled | 188 blocks |
| `{"Requires": [ … ]}` | **Conditional** (gated, e.g. "prod only UK South") | half/ring + tooltip of the condition | 20 blocks |
| `{"Targets": { … }}` | **Targeted** (specific tenant GUIDs / regions) | dotted/target + tooltip of targets | 2 blocks |

### Extraction mechanism — ADO REST API, proven live end-to-end (no clone)
The product reads remote `master` only; nothing local exists at runtime.

1. **Auth:** `az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798"` → ~2.5KB bearer. (Productionized, this becomes a **service identity / PAT with read access to the repo** — see Risks; that access grant is the real dependency, the code is trivial.)
2. **Discover flags:** `GET .../items?scopePath=/Features/Configuration/Features&recursionLevel=OneLevel&versionDescriptor.version=master&versionDescriptor.versionType=branch` → ~13,282 items → regex-filter `/FLT[^/]+\.json$` → ~42–43 paths.
3. **Current state:** `GET .../items?path=<path>&versionDescriptor.version=master&versionDescriptor.versionType=branch` → full JSON content.
4. **Per-file history:** `GET .../commits?searchCriteria.itemPath=<path>&searchCriteria.itemVersion.version=master` → only commits touching that file, newest-first.
5. **Per-env change attribution (reformat-proof):** for each consecutive pair of path-commits, fetch content at each `commitId` (`versionDescriptor.versionType=commit`) and **diff the `Environments` blocks**. This attributes the *semantic* change (env X went off→on), immune to whitespace/reorder reformatting that line-`git blame` gets wrong. Each commit is **immutable** → cache content by `commitId` forever; **refresh = re-pull the commits list and diff only new commits.**
6. **PR linkage:** the merge-commit comment carries `Merged PR <NNNNNNN>` → deep-link to the PR that flipped the env.

**Gold sample (proven, use in mock/tests) — `FLTArtifactBasedThrottling`:**
`test` off→on (Ayush Singhal, 2026-02-04) · `cst` cond→on (02-12) · `daily` off→on (02-12) · `dxt` off→on (02-24) · `msit` off→on (03-03) · `prod` off→targeted (03-10) → targeted→on (03-13) · `bleu` off→on (Jayaprakash Kupparaju, 05-05).

### "Last enabled by" / timestamps — confirmed
- **Who:** derived from the commit/PR that flipped an env (step 5/6), labeled **"Last enabled by"** — never "Owner" (no such field exists).
- **File creator:** `--diff-filter=A` (or first commit in the path history) gives who created the flag file.
- **Catch:** any **shallow fetch** loses history → the API `/commits` path-history approach (full, server-side) avoids this; we never rely on a shallow local clone.

### Hosting & auth model (RESOLVED — delegated, zero provisioning)
- **Hosting:** Vercel (serverless Next.js). MS login via **Microsoft Entra** (NextAuth/Auth.js Entra provider), tenant-restricted.
- **Two identities were considered:** (1) who may open the portal, (2) what credential reads ADO. These collapse into one because **the entire audience (PM/TPM/eng) already has read access to the `FeatureManagement` repo** (confirmed by CEO).
- **Decision — delegated, per-user:** the auth-code flow requests the Azure DevOps scope (`499b84ac-1321-427f-aa17-267ca6975798/.default`); the code exchange returns an access token with `aud`=ADO. The server then calls the ADO REST API **as the signed-in user**. Refresh token kept server-side; tokens refreshed as needed.
- **Why not a service principal / app-only:** only needed if some users lacked repo read. They don't → **no SP, no client secret, no provisioning ask, no shared identity.** Bonus: every read is audited under the real user and naturally least-privilege.
- **Note (correction to an earlier assumption):** Vercel **cannot** use an Azure Managed Identity (MI exists only for workloads on Azure compute). The fallback "service identity" — if ever needed — would be an **Entra app registration + client secret** doing client-credentials, *not* an Azure MI. Not needed under the current decision.
- **Hard rule:** all ADO calls happen **server-side** (Next.js route handlers); the access token never reaches the browser. Browser sees rendered data only.
- Full token lifecycle / route-handler design → deferred to P2 `architecture.md`.

### Inert-flag detection — data feasibility (the hero feature)
- Dependencies are declared in **Description prose** (e.g. "EnableFMVServiceAPIThrottling must be enabled"). Inert = flag is `Enabled` in env X but its declared prerequisite is **off** in env X → it's doing nothing.
- **Nuance:** prerequisite flags may **not** be `FLT`-prefixed (e.g. `EnableFMVServiceAPIThrottling`), so they're outside our 42. Treat an absent/unknown prerequisite as **"unknown"** (surface it, don't claim inert with false confidence). Parsing strategy (prose → dependency graph) is a P2 architecture problem; P0 only confirms the signal exists and is extractable.

---

## P0.3 — Industry prior-art (LaunchDarkly / Statsig / Unleash / Vercel / Flagsmith / Split) ✅

Surveyed 6 products (code + docs, cited). Core finding: **the whole industry splits flag insight into two buckets — config-derived and runtime-telemetry-derived. We live entirely in the first bucket, and that is fine: our Time-Travel matrix is something none of them have.**

### How they each show "flag across N environments" (our Grid + Ladder + Dossier)
| Product | Pattern | Takeaway for us |
|---|---|---|
| LaunchDarkly | "Overview across environments" = single-flag **table, one row per env**, with **pin-env-to-top**. Plus a 2-env side-by-side diff. | Pin-env is a cheap, high-value Dossier affordance. Their cross-env view is per-flag (row-per-env) — **our 42×15 Grid is more ambitious than anything they ship.** |
| Unleash | Per-flag **vertical accordion of env cards** (toggle + strategies + metrics). | Good Dossier layout; not a grid. |
| Statsig | Env handled **per-rule**, not per-flag-instance. No grid. | N/A — confirms grid is our differentiator. |
| Flagsmith | Single env at a time via a dropdown. | Weakest cross-env story. |

### Stale / inactive detection — the gold for our Inert hero ⑦
- **Runtime-based (can't replicate):** LD's New/Active/Launched/Inactive and Statsig's "0 checks in 30 days" both key off **SDK evaluation telemetry we will never have.** Don't fake it.
- **Config/age-based (CAN replicate from git — adopt these):**
  - **Unleash age-based staleness** — `(now − createdAt) ≥ expectedLifetime(type)`. **No telemetry.** We already get `createdAt` from git (`--diff-filter=A`). The only missing input is a flag *type→lifetime* map, which we'd have to introduce (see "new ideas" below).
  - **Statsig "stale-reason taxonomy"** — don't just say "stale," say *why*: `PROBABLY_LAUNCHED` (Enabled in all envs, untouched > N days), `PROBABLY_DEAD` (off everywhere, untouched > N days), `PROBABLY_FORGOTTEN` (partially rolled out, untouched for months). **All three derive purely from our 42×15 state + git dates.** → fold these as labels inside ⑦.
- **Our ⑦ Inert (flag ON but prerequisite OFF)** has **no exact analog** in any product — LD has prerequisite *flags* but only blocks archival; nobody surfaces "on-but-doing-nothing." Confirmed differentiator.

### Prerequisite / dependency visualization (informs ⑦)
- Only **LaunchDarkly** has true prerequisite flags: a dependent serves its OFF variation if the prereq isn't met; UI prevents circular deps and **blocks archival while dependents exist**, showing the blocking chain. → borrow the **blocking-chain visualization** for our inert dependency view. Statsig has "chained flags" (parent disables children) but lighter.

### Activity / audit (our Activity Stream ④ + Dossier timeline)
- **LaunchDarkly:** audit log with **"Details → JSON patch diff (old vs new)"** + **annotations overlaid on the timeline** marking when changes happened. → we already diff git commits; adopt the **"click a change → see the JSON Environments diff"** affordance and timeline annotations.
- **Unleash:** **horizontal Event Timeline** — event dots plotted by time, **grouped when close**, filterable by env + time span, auto-refresh. → strong visual model for ④ (we already locked date+flag filters; add env filter + grouped dots).
- **Flagsmith Feature Versioning v2** is the closest thing to time-travel anyone ships (browse/rollback past versions) — but per-flag-per-env, **not a cross-env as-of-date matrix.** → **our ⑤ Time Travel is genuinely novel.**

### "Who changed this" naming (validates our constraint)
- LD = "Maintainer" (assigned owner) **separate from** per-change actor; Unleash/Flagsmith = `createdBy`/`author` per event. **Nobody derives ownership from last-touch.** → keep **"Last enabled by"** for enablement; consider **"Last modified by"** for the general (any-change) case. **Never "Owner"/"Maintainer"** (implies assigned responsibility we can't truthfully derive).

### CANNOT / SHOULD-NOT replicate (no runtime telemetry — stay out)
Live evaluation counts · evaluation time-series graphs · metric-lift/impact analysis · live-events debugger · "if user X, what variation?" eval playground · SDK-key mgmt · any write/toggle/approval workflow (we show PR links instead). All confirmed out-of-scope and consistent with our READ-ONLY, git-only stance.

### New ideas the research surfaced (beyond our locked set — for CEO ruling in P1)

> **CEO RULING (LOCKED 2026-06-13): ADOPT 1, 3, 4, 5 into P1. PARK 2, 6, 7.**
> Rationale: 1/3/4/5 are git-derivable, read-only-safe, and near-free. 2/6/7 depend on metadata FM JSON does not have (permanent marker, flag type, tags) → upkeep burden with no clear payoff for a read-only tool. **#2 specifically: we are read-only and never drive cleanup, so stale/inert findings are presented as *neutral observations* (e.g. "Enabled 15/15, unchanged 8mo"), NOT prescriptive "clean me up" nudges → no permanent marker needed in V1. Revisit Option B (side-annotation file) only if PMs report false-positive noise.**

These are git-derivable and read-only-safe, but they're *additions* to the locked scope:
1. **Stale-reason labels on ⑦** (Statsig taxonomy) — almost free given our data. *Strong recommend.*
2. **"Permanent" flag marker** — suppress inert/stale nudges for operational flags that are meant to live forever. Needs a small annotation source (we have no such field in FM JSON). *Recommend, low cost.*
3. **JSON-diff "Details" on each Activity entry** (LD) — show the exact `Environments` diff for a change. *Strong recommend — we already compute it.*
4. **Env filter + grouped dots on the Activity timeline** (Unleash). *Recommend.*
5. **URL-encoded filter state / saved views** (LD shareable dashboards) — pairs with our deep-links. *Recommend.*
6. **Flag type → expected-lifetime → age-based staleness** (Unleash) — powerful, but **requires introducing a flag-type taxonomy FM doesn't have** (we'd infer or annotate). *Park as optional; flag the data gap.*
7. **Tags/labels** — every product has them; **FM JSON has no tags field.** *Park — would need a derived/external source.*

**Data-gap honesty:** items 2, 6, 7 depend on metadata that does **not** exist in the FM JSON (flag type, permanent marker, tags). We either infer heuristically, add a small side-annotation file, or cut them. Decide in P1, don't assume.

---

## P0 — Risks & dependencies

| # | Risk / dependency | Mitigation |
|---|---|---|
| R1 | ~~Service identity with read access to the FM repo is the real gate.~~ **RESOLVED — dissolved.** | Hosting is Vercel + Entra MS login; the full audience already has FM-repo read, so we use **delegated per-user auth** (auth-code → ADO scope → call as the user). No PAT, no service principal, no Azure MI, no provisioning ask. See P0.2 "Hosting & auth model". |
| R2 | Shallow/partial fetch loses git history. | Use server-side `/commits` path history (full); never depend on a shallow clone. |
| R3 | Line-`git blame` mis-attributes on reformat. | Use semantic `Environments`-diff between commitIds, not blame. |
| R4 | Prerequisite flags fall outside the FLT-42 set. | "unknown" state for absent prerequisites; never assert inert without the prerequisite's actual state. |
| R5 | 13K-file repo scale. | `recursionLevel=OneLevel` + regex filter; only ~42 flags fetched in full; immutable commitId cache. |
| R6 | Local clone is on the user's own feature branch (would leak in-flight work). | Always pin `master`; never read working tree. |

## P0 — Gate checklist (must all be ✅ to advance to P1)
- [x] Existing-code audit done; reuse/no-reuse decided (P0.1)
- [x] Data source + schema + env/state model verified against real files (P0.2)
- [x] Extraction + attribution mechanism proven live end-to-end (P0.2)
- [x] Real seed dataset built (`session files/control-tower-seed.json`, 42 flags) for P4
- [x] Industry prior-art synthesized; "patterns to steal" + "can't replicate" lists (P0.3)
- [x] CEO sign-off on P0 → **P1 OPEN.** Ruling on new ideas: ADOPT 1,3,4,5 · PARK 2,6,7.
