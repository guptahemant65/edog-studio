# Feature 30: EDOG Control Tower — Feature-Flag Intelligence Portal

> **Status:** P0 IN PROGRESS — foundation research being formalized; P0.3 (industry prior-art) dispatched
> **Phase:** V1 (build all surfaces at once — no v1/v2 phasing per CEO)
> **Owner:** Pixel (JS/CSS), Vex (data engine — ADO REST client + cache), Sana (architecture + FLT/FM internals), Sentinel (tests/veto)
> **SOP:** `hivemind/FEATURE_DEV_SOP.md` — this feature follows P0→P7 with hard gates
> **Idea origin:** Ram (M2) — "PMs should have a portal to check FF rollout anytime." Hemant scoped it read-only + git-derived.
>
> **Relationship to F11 (Environment Panel → C03 Feature Flags):** F11/C03 is the *in-studio, single-process, force-ON override* panel backed by `EdogFeatureOverrideStore` (one dev's local FLT process). **Control Tower is the opposite product**: a standalone, read-only, org-wide *intelligence* portal that reconstructs rollout truth from the **FeatureManagement git repo** for **all 15 environments**. They share the FM schema understanding (§ P0.2) but **do not** share data source, write model, or audience. Control Tower never reads EDOG override state.
>
> **Locked surfaces (planned):**
> - P0 research → `research/p0-foundation.md`
> - P1 component specs → `components/C0{1..N}-*.md` (one per view)
> - P2 architecture → `architecture.md` (ADO REST client, commitId cache, diff-mining attribution, inert dependency graph, FE↔BE contract, service-identity auth)
> - P3 state matrices → `states/*.md`
> - P4 visual mock → `mocks/control-tower.html` (Phantom — only after P0–P3 gates pass)
>
> **Hard constraints (locked with CEO):**
> - **READ-ONLY forever.** No toggle, no force-ON/OFF anywhere. These flags gate prod across sovereign clouds; a write surface is a non-starter.
> - **FLT-scoped.** Only the ~42 `FLT*.json` flags. Never surface or touch the other ~13,160 flags in the shared monorepo.
> - **No fabricated ownership.** There is no "Owner" field in FM. Use **"Last enabled by"** (git/PR-derived), never an invented owner.
> - **Source of truth is remote `master`**, fetched live via ADO REST API. No local clone; nothing "local" exists when this product runs.

---

## 1. Problem

There is no single place to answer *"where is FabricLiveTable feature flag X across all 15 environments, who enabled it, when, and is it actually doing anything?"* Today the truth lives only in the `FeatureManagement` monorepo as 42 JSON files buried among **13,000+** unrelated flags. To answer a rollout question a PM/TPM must:

| Question | Today's answer location |
|---|---|
| Is `FLTArtifactBasedThrottling` on in `prod`? | Find the file in a 13K-file repo, read raw JSON |
| Who enabled it in `dxt` and when? | `git log`/`git blame` the file by hand, cross-read PRs |
| Is it conditional or fully on in `prod`? | Eyeball the `Requires`/`Targets` block, decode it |
| Is this flag actually effective, or inert? | Read the Description prose, manually check its prerequisite flag's state |
| What changed across FLT flags this week? | Nothing — there is no activity view |

Five+ manual steps, deep repo knowledge required, zero insight layer. PMs cannot self-serve.

## 2. Objective

A standalone **read-only intelligence portal** that reconstructs FLT flag rollout from `master` live and presents it in three layers:

- **Layer 1 — Posture (where things are):** ① The Grid (42×15, 4-state) · ② Flag Dossier
- **Layer 2 — Motion (how things move):** ③ Rollout Ladder · ④ Activity Stream (+ date & flag filters) · ⑤ Time Travel (date scrubber → matrix as-of-date)
- **Layer 3 — Intelligence (what it means):** ⑦ Inert-flag detection (hero) · ⑧ Sovereign-cloud compliance lens · ⑨ Rollout velocity

Connective tissue: Cmd-K palette, deep links, F16 skin, light-default + dark toggle, a **Refresh** action (re-pull `master`, diff only new commits).

## 3. Explicitly out of scope (cut, not deferred)

- ⑥ **Drift detection** — KILLED. The FM pipeline already enforces ring order (test→…→prod); ring-skip is structurally impossible, so there is no drift to detect.
- **Any write path** — toggling, force-ON/OFF, editing descriptions.
- **Non-FLT flags** — the other ~13,160 flags in the shared repo.
- **EDOG override data** — `EdogFeatureOverrideStore` is a different product (F11/C03).
- **Runtime telemetry** — live evaluation counts / exposure numbers. We are git-derived; we do not have runtime data and will not fabricate it.
