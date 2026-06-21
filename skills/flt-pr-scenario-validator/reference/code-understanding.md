# Code Understanding — the Beat 2 engine (gates · signals · what-reaches-it)

Beat 2 must **understand the change without guessing**. This is the guide to the
tools that make that grounded. The rule everywhere: *facts are read from code and
the real flag cache; the live run (Beat 5) is the judge of anything static can't
settle.*

## The one entry point — `qa_change_understanding`

Server-free. Call it in Beat 2 with the changed `.cs` files + changed symbols
(from `qa_pr_diff`), and the changed project's `.csproj` when you want entry points.

```bash
python scripts/qa_change_understanding.py \
  --files "a.cs;b.cs" \
  --symbols "ChangedTypeA,ChangedMethodB" \
  --added-flags "FLTNewFlag" \
  --project "<repo>/Service/Microsoft.LiveTable.Service/Microsoft.LiveTable.Service.csproj" \
  --entry-symbols "ChangedTypeA"            # trace 'what reaches it'
# add --json for the structured handoff to Beat 3/5; default prints the plain summary.
```

It returns one grounded structure:

- **`gates`** — feature flags that gate the changed code, each with its **real EDOG
  state** (see below) and the code sites that prove it.
- **`watchChecklist`** — the change's **signal footprint** mapped to the streams
  Beat 5 must watch (with file:line anchors).
- **`entryPoints`** — what reaches each changed symbol (the door to trigger it).
- **`honestNotes`** — the completeness caveats (the run is the judge).

Use `render_plain(cu)` for the terminal summary, or feed `assemble(...)`'s dict to
Beat 3 (design tests) and Beat 5 (trigger · watch · prove).

## The two Roslyn tools underneath (you rarely call them directly)

| Tool | Answers | Cost | Door |
|---|---|---|---|
| **ChangeScanner** (`scripts/qa_codegraph/ChangeScanner`) | feature-flag gates + the **signal footprint** (the streams the change touches) | fast, syntax-only, no warm-up | one pass over the changed files |
| **PreciseEngine** (`scripts/qa_codegraph/PreciseEngine`) | **what reaches the changed code** (callers / references, cross-file) | loads the changed project semantically (seconds; precise) | Roslyn `SymbolFinder` over the `.csproj` |

Both are committed as **source**; `qa_codegraph_build.py` (and the skill's
`install.py`) builds them, and the runners build them on first use. If `dotnet`
is missing they degrade honestly — no fabricated answers.

`scripts/qa_codegraph/signal_vocabulary.json` is the **editable** map from FLT call
/ namespace / text patterns to evidence streams (grounded in `Tracer.Log*`,
`Microsoft.ServicePlatform.Telemetry`, the `OneLake` / `Throttling` / `RetryPolicy`
namespaces, `GetTokenAsync`, …). Extend it as FLT grows — it is a *hint* layer;
the runtime interceptors are the ground truth.

## The flag-state fact that kills the Beat 2 hallucination

A feature flag's state is **per-environment**, and **EDOG == the FM `test`
environment**. So a flag's EDOG default is its `test` entry in
`~/.edog-cache/feature-management/Features/**/<Id>.json` (resolved by `Id`, not
filename; `classify_env` gives on/off/empty/partial). `qa_flag_gates.edog_state`
does exactly this — never read `prod`/`onebox`, never answer from memory.

- `on` / `off` / `empty` → the EDOG default.
- `partial` (Targets/Requires) → depends on the workspace → **confirm live in
  Beat 5** before relying on it.
- The authoritative *effective* state (overrides + workspace targeting) is the
  live catalog at Beat 5; Beat 2 gives the grounded default.

## Two layers, by design (never claim static completeness)

1. **Static (this engine, Beat 2):** surface the gates and signals it can see;
   label everything else *unknown*. A change can be gated by more than a flag — a
   `ParametersManifest`/config key, an internal check, a capacity/tenant
   condition. Surface those as honest unknowns; **never silently assume the
   changed code runs.**
2. **Dynamic (Beat 5, the judge):** set the gates you found, run it, and read the
   actual footprint from the interceptors around the changed code's marker
   (`qa_execution_proof`). An **expected-but-absent** signal (no Spark session, no
   file landed) — or a marker that never fired — is a **finding**, not a pass:
   there is a gate you missed.

The static footprint is Beat 5's **watch-checklist**. The run completes what
reading the code could not.
