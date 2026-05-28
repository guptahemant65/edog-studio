# F28 / C06 — MITM-to-Scenario Recorder & Time-Travel Response Forgery

> **Author:** Sana (Architecture)
> **Status:** P1 Component Deep Spec — draft for review
> **Parent feature:** F28 HTTP MITM (`docs/specs/features/F28-http-mitm/`)
> **P0 foundation:** `research/p0-foundation.md` §6.3, §6.4
> **Priority tier:** Tier 1 "wow" (commit for v1 per §7.8)

---

## 0. Component summary

C06 packages the two interactive-MITM features that turn EDOG from a one-shot
testing tool into a **regression-test factory** and a **deterministic bug
reproducer**:

| Part | One-liner | Section |
|---|---|---|
| **A — MITM-to-Scenario Recorder** | Record an interactive MITM session, auto-generate a `QaScenarioSubmission` that reproduces it through `EdogQaExecutionEngine`. | S01 – S08 |
| **B — Time-Travel Response Forgery** | Right-click any captured HTTP response → forge it as the response for future matching requests. Combine with Causal Replay (C05 / §6.1). | S09 – S12 |
| **Cross-cutting** | Recording overhead, session cleanup. | S13 – S14 |

### Design anchors

- **No new interception path.** Recording observes the topics that already
  exist (`http`, `mitm`, `log`, `retry`, `flag`, `token`, `dag`). The
  recorder is a *consumer* of events, not a tap on the handler.
  Same observer pattern as `EdogQaRecordingSession.Create()`
  (`src/backend/DevMode/EdogQaRecordingSession.cs:90`).
- **Reuse the QA pipeline, do not fork it.** Generated scenarios are
  ordinary `QaScenarioSubmission` payloads handed to the existing
  `QaSubmitCuratedScenarios` RPC (`EdogPlaygroundHub.cs:639`). The execution
  path is the same 8-phase loop documented at `EdogQaExecutionEngine.cs:22-37`.
- **Forgery is a Forge rule.** A "Time-Travel" template is just a pre-filled
  `MitmRule { Action = Forge, … }` whose `Status`, `Headers`, and `Body`
  fields are seeded from a captured response. The handler already knows how
  to synthesize from this shape (`EdogHttpPipelineHandler.cs:160`).
- **Recorder is owned by the UI session.** Auto-clears on SignalR
  disconnect, same lifetime model as interactive MITM rules (C03).

### Capability gating

`QaCapabilityReport` returned by `QaGetCapabilities` (`EdogPlaygroundHub.cs:1055`)
gains two booleans:

```csharp
public bool IsMitmRecorderSupported { get; set; }
public bool IsForgeryTemplateLibrarySupported { get; set; }
```

Both default `true` whenever F28 interactive MITM is enabled. The frontend
hides the **Record** button and the **Use as Forgery Template** context-menu
item when either flag is false.

---

## 1. Data model additions

These types live in a new file `src/backend/DevMode/EdogMitmRecorderModels.cs`
and are wire-shared via the hub.

### 1.1 `MitmRecordingSession`

```csharp
public sealed class MitmRecordingSession
{
    public string SessionId { get; init; }            // "mitm-rec-{ulid}"
    public string OwnerConnectionId { get; init; }    // SignalR ConnectionId
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? StoppedAt { get; set; }
    public RecordingState State { get; set; }         // Active | Stopped | Aborted | Generated
    public string CorrelationFilter { get; init; }    // optional substring filter on URL/correlationId
    public int CapturedHttpCount { get; set; }
    public int CapturedMitmActionCount { get; set; }

    // Capture buffers — populated by observers, drained at Stop.
    internal List<TopicEvent> HttpEvents { get; } = new();
    internal List<MitmActionRecord> MitmActions { get; } = new();
    internal List<TopicEvent> ContextEvents { get; } = new(); // dag/flag/token/retry
}

public enum RecordingState { Active, Stopped, Aborted, Generated }
```

### 1.2 `MitmActionRecord`

One entry per MITM control-plane event observed during the session
(rule applied, breakpoint resumed, modify-and-forward, replay fired, …).

```csharp
public sealed class MitmActionRecord
{
    public DateTimeOffset Timestamp { get; init; }
    public string CorrelationId { get; init; }       // links to http event
    public MitmActionKind Kind { get; init; }        // Block, Forge, ModifyRequest, ModifyResponse, Delay, Replay, BreakpointResume
    public string TargetUrl { get; init; }
    public string Method { get; init; }
    public string RuleSnapshot { get; init; }        // JSON of the MitmRule used (post-edit), redacted
    public string UserNote { get; init; }            // optional inline annotation from the editor
}

public enum MitmActionKind { Block, Forge, ModifyRequest, ModifyResponse, Delay, Replay, BreakpointResume }
```

### 1.3 `ForgeryTemplate`

Saved Time-Travel template (Part B library).

```csharp
public sealed class ForgeryTemplate
{
    public string Id { get; init; }                  // "fgt-{ulid}"
    public string Name { get; set; }                 // user-supplied
    public string OriginUrl { get; init; }           // URL the response originally came from (redacted)
    public string OriginMethod { get; init; }
    public DateTimeOffset CapturedAt { get; init; }  // wall clock of source response
    public int StatusCode { get; set; }
    public Dictionary<string, string> Headers { get; set; } = new();
    public string Body { get; set; }                 // text content; binary captured-as-base64
    public string BodyContentType { get; set; }
    public int BodySizeBytes { get; set; }
    public string Notes { get; set; }
}
```

Persistence: in-memory only for v1, keyed by `OwnerConnectionId`. Survives
across reconnects within a 5-minute grace window keyed by user identity
(matches the MITM rule store's reconcile pattern, P0 §1.10).

---

## 2. New SignalR RPC surface

All on `EdogPlaygroundHub` (`src/backend/DevMode/EdogPlaygroundHub.cs`), same
result-envelope pattern as `QaSubmitCuratedScenarios`.

| Method | Returns | Purpose |
|---|---|---|
| `MitmStartRecording(MitmStartRecordingRequest)` | `MitmRecordingHandle` | S01 — open a session, attach observers. |
| `MitmStopRecording(string sessionId)` | `MitmRecordingResult` | S03 — detach observers, finalise buffers. |
| `MitmGenerateScenarioFromRecording(string sessionId)` | `QaScenarioSubmission` | S03/S04/S05 — synthesise scenario JSON. |
| `MitmDiscardRecording(string sessionId)` | `Ack` | S14 — manual cleanup. |
| `MitmCaptureResponseAsTemplate(MitmCaptureTemplateRequest)` | `ForgeryTemplate` | S09 — snapshot a captured response. |
| `MitmApplyForgeryTemplate(MitmApplyTemplateRequest)` | `MitmRule` | S10 — create a Forge rule from a template (returns the live rule). |
| `MitmListForgeryTemplates()` | `IReadOnlyList<ForgeryTemplate>` | S12 — library enumeration. |
| `MitmSaveForgeryTemplate(ForgeryTemplate)` | `ForgeryTemplate` | S12 — name and store a template. |
| `MitmDeleteForgeryTemplate(string templateId)` | `Ack` | S12 — remove a template. |

Control-plane events are published to the **`mitm`** topic (registered by C03
per P0 §1.3) using these event-type tags so the frontend can subscribe with
the existing `signalr.subscribeTopic('mitm')` plumbing:

- `mitm.recording.started`
- `mitm.recording.action_captured`  (one per `MitmActionRecord`)
- `mitm.recording.stopped`
- `mitm.recording.scenario_generated`
- `mitm.template.created`
- `mitm.template.applied`

---

## 3. Scenarios

Each scenario uses the standard format: **Name + ID + one-liner →
description → mechanism → source path → edge cases → interactions → revert
→ priority**.

---

### S01 — Start MITM recording session

**One-liner:** User clicks **● Record** in the HTTP tab toolbar. Server
opens a `MitmRecordingSession`, attaches observers, returns a handle. The
toolbar pill turns red and shows elapsed time + captured-action count.

**Description.** Recording is an *additive* capture layer over the live
MITM pipeline. It does not change interception behaviour; users still apply
rules and pause on breakpoints as usual. Recording captures *what they did*
plus *what the system did in response*, into three correlated buffers:
HTTP events, MITM control events, and ambient context events.

**Mechanism.**

1. Frontend `HttpPipelineTab` invokes
   `connection.invoke('MitmStartRecording', { correlationFilter? })`.
2. Hub creates `MitmRecordingSession { SessionId, OwnerConnectionId, StartedAt }`,
   stores in `MitmRecorderStore` (process-wide `ConcurrentDictionary` keyed
   by session id; index by connection id for cleanup).
3. The store registers three observers via `TopicBuffer.AddObserver()`
   (the same primitive used by `EdogQaRecordingSession.cs:118`):
   - On `http` → append to `session.HttpEvents`.
   - On `mitm` → if event type matches a `MitmActionKind`, project to a
     `MitmActionRecord` and append to `session.MitmActions`; publish a
     `mitm.recording.action_captured` envelope so the UI counter updates.
   - On `log`, `retry`, `flag`, `token`, `dag`, `nexus` → append only
     events whose `correlationId` already appears in `HttpEvents`
     (deferred join — see edge case below).
4. Hub publishes `mitm.recording.started` with the handle. Frontend pill
   flips to active state.

**Source code path.**
- Hub method: `EdogPlaygroundHub.cs` — new section ~L1070 (after QA RPCs).
- Store: new `src/backend/DevMode/MitmRecorderStore.cs`.
- Observer attachment: pattern at `EdogQaRecordingSession.cs:103-138`.
- Topic registry: `EdogTopicRouter.cs:26-45` already registers `http`,
  `log`, `retry`, `flag`, `token`, `dag`. `mitm` is registered by C03.

**Edge cases.**
- **Double-record.** A second `MitmStartRecording` from the same connection
  while one is already active returns `409 Conflict` envelope. UI must
  show the existing pill rather than offer "Record" again.
- **Recording with no rules.** Allowed — captures plain traffic with zero
  `MitmActions`. The generated scenario will then have no chaos block,
  effectively a "smoke replay" of whatever stimulus the user fired.
- **`correlationFilter` empty.** Captures everything. UI defaults filter to
  empty; advanced disclosure lets the user scope to e.g. `OneLake` substring.
- **Topic ring overflow.** The `http` topic ring is 2000 events. If a
  recording outlives the ring, older HTTP events scroll out of the buffer
  but the *recorder's own list* retains them — observers fire on every
  `Write()`, the ring is irrelevant to capture. Cap recorder list at
  `MaxRecorderEventsPerTopic = 10_000`; on overflow set
  `RecordingState = Aborted` with reason `"event_cap_exceeded"`.

**Interactions.**
- **C01 (MITM rule store):** unaffected; recorder reads from topics, not
  the store. Rules edited during recording show up in `MitmActions`
  because each apply emits a `mitm` event (per C03).
- **C04 (Breakpoint pause/resume):** every breakpoint resume emits
  `mitm.breakpoint.resumed`, projected to a `MitmActionRecord` with
  `Kind = BreakpointResume`. This is what makes the recorded scenario
  reproduce interactive decisions.
- **F27 QA recorder:** independent — F27 owns scenario *execution-time*
  recording (`EdogQaRecordingSession`); C06 owns *interactive session*
  recording. They never run at the same scope.

**Revert / undo.** Stop without generating: `MitmDiscardRecording`.
Closes observers, drops buffers, removes from store. Disposal pattern:
`EdogQaRecordingSession.Dispose()` (`:194-203`) — set `IsDisposed = true`
*before* unsubscribing so any in-flight observer callback no-ops.

**Priority:** P0 (must-ship). Without S01 the rest of Part A is dead.

---

### S02 — Capture MITM actions during recording (block / forge / modify / delay)

**One-liner:** While recording is active, every MITM action the user
performs is projected into a `MitmActionRecord` and appended to the
session. The toolbar action counter ticks per capture.

**Description.** This is the *core* of the recorder. Each interactive MITM
verb the user performs — Block, Forge, ModifyRequest, ModifyResponse,
Delay, Replay, Breakpoint-Resume — produces a control-plane `mitm` topic
event in C03/C04. S02 codifies the **projection contract**: which `mitm`
event types become `MitmActionRecord` rows, with which fields.

**Mechanism.**

| `mitm` event type | `MitmActionKind` | Fields populated |
|---|---|---|
| `mitm.rule.applied` (action=Block) | `Block` | `TargetUrl`, `Method`, `RuleSnapshot`, `CorrelationId` (of next match) |
| `mitm.rule.applied` (action=Forge) | `Forge` | + `RuleSnapshot.Status/Headers/Body` |
| `mitm.rule.applied` (action=Delay) | `Delay` | + `RuleSnapshot.LatencyMs` |
| `mitm.breakpoint.resumed` (kind=request, modified) | `ModifyRequest` | `RuleSnapshot` carries the request diff (header adds/removes, body delta) |
| `mitm.breakpoint.resumed` (kind=response, modified) | `ModifyResponse` | response diff |
| `mitm.breakpoint.resumed` (kind=request, unmodified) | `BreakpointResume` | bare-resume marker (no chaos rule generated) |
| `mitm.replay.fired` | `Replay` | `RuleSnapshot` carries the request that was replayed |

The projection runs synchronously inside the `mitm`-topic observer; cost
budget < 50 μs per event (see S13).

`RuleSnapshot` is a JSON of the rule **after** any user edits, with
authorisation headers redacted using the same redactor as
`EdogHttpPipelineHandler.RedactRequestHeaders` (`:270-298`). The recorder
must call the public redactor, not capture raw values.

**Source code path.**
- Projection table: `MitmRecorderStore.ProjectMitmEvent(TopicEvent)` —
  switch on `evt.Data.eventType`.
- Header redaction: reuse `EdogHttpPipelineHandler.RedactRequestHeaders`
  (extract to `HttpRedactor.Redact(headers)` static helper to share —
  see Part A §4.1 of the F28 master spec, the redaction policy ADR).

**Edge cases.**
- **Action with no subsequent HTTP match.** A Block rule applied but the
  matching URL is never called → `MitmActionRecord` still recorded
  (rule snapshot only). Scenario generation (S04) treats it as a
  pre-installed chaos rule with `expectMatchCount: 0` allowed.
- **Action edited multiple times before applying.** Only the *final*
  apply emits `mitm.rule.applied`. Intermediate edits don't pollute the
  record.
- **Replay during recording.** A replay is a synthetic stimulus; its
  outbound HTTP event flows through the pipeline normally and is captured
  in `HttpEvents`. The `Replay` action record carries the request that
  was sent so the scenario can re-issue it as a stimulus.
- **Action without a connection-scoped rule (e.g. global F24 rule).**
  Recorded with `RuleSnapshot.owner = "F24"`; scenario generation
  passes this through as a chaos rule unchanged (it works because F24
  and F28 share the same rule shape per P0 §1.11).

**Interactions.**
- **C03 MITM rule lifecycle:** depends on rule-applied / rule-removed
  events being published with the projected fields. Schema is owned by
  C03; C06 consumes it.
- **C04 breakpoint diff:** depends on `mitm.breakpoint.resumed` carrying
  a structured `requestDiff` / `responseDiff` payload. If C04 only
  publishes a boolean `modified: true`, S02 falls back to capturing the
  full final request/response (less precise but functional).

**Revert / undo.** Captured actions cannot be selectively removed during
recording. To "undo a recorded action" the user discards the recording
(`MitmDiscardRecording`) or edits the generated scenario before saving
(S08).

**Priority:** P0.

---

### S03 — Stop recording and generate scenario

**One-liner:** User clicks **■ Stop**. Server detaches observers, drains
buffers, runs the synthesis pass, returns a `QaScenarioSubmission`
preview to the frontend. Frontend opens the **Generated Scenario** modal.

**Description.** Stop is a two-phase operation: **finalise** the session
(observers off, `StoppedAt` stamped, state → `Stopped`) and **synthesise**
the scenario JSON. The two are separate RPCs so the UI can offer "Stop &
Review" vs. "Stop & Discard".

**Mechanism.**

1. `MitmStopRecording(sessionId)`:
   - Look up session by id and connection id (mismatch → 403).
   - Dispose observer subscriptions (the same `IDisposable` list pattern
     as `EdogQaRecordingSession.cs:200-202`).
   - Stamp `StoppedAt`, set state `Stopped`.
   - Return `MitmRecordingResult { sessionId, duration, counts, summary[] }`
     (no scenario JSON yet — preview only).
2. UI shows summary modal: N HTTP calls, M actions, K context events.
   Buttons: **Generate scenario**, **Discard**, **Resume** (deferred to
   v1.1).
3. On Generate, UI calls `MitmGenerateScenarioFromRecording(sessionId)`.
   Server runs the synthesis pipeline (see S04 + S05), returns full
   `QaScenarioSubmission`.
4. Server transitions state to `Generated` and publishes
   `mitm.recording.scenario_generated` so other connected tabs see the
   recording closed.

**Source code path.**
- Stop: `MitmRecorderStore.Stop(sessionId)`.
- Synthesis: new `MitmScenarioSynthesizer` class.
  - `BuildStimulus(HttpEvents, ContextEvents)` → S05 mechanism
  - `BuildChaosSetupSteps(MitmActions)` → S04 mechanism
  - `BuildExpectations(HttpEvents, MitmActions)` → S05 mechanism
  - `BuildMetadata(session)` → traceability fields

**Edge cases.**
- **Empty recording.** Zero HTTP events → return scenario with stimulus
  type `Manual` and a TODO marker. UI flags the scenario as
  `ScenarioLifecycle.Generated` with linter hint `LNT_RECORDER_EMPTY`.
- **Stop racing with a breakpoint pause.** If a breakpoint is currently
  awaiting user input when Stop fires, the *pending pause* is resumed
  with action `BreakpointResume` (unmodified) before observers detach,
  so the in-flight request completes naturally. Pattern matches how
  `EdogQaExecutionEngine` always runs teardown (`:32`).
- **Stop after disconnect.** Connection drop triggers S14 cleanup which
  also calls Stop; explicit Stop on a reconnected client returns 410
  Gone.

**Interactions.**
- **F27 QA panel:** generated scenario is delivered via the same shape
  the QA panel already renders (`QaScenarioSubmission`); no QA-side code
  changes required.
- **S07 export:** generation is local-only; user must explicitly export
  to QA (S07).

**Revert / undo.** Generated scenario is still in-memory only — until
S07 export, dismissing the modal discards it. Recording session itself
is preserved (state `Generated`) for 5 minutes in case the user wants
to regenerate after editing settings, then garbage-collected by S14
sweeper.

**Priority:** P0.

---

### S04 — MITM action → chaos rule mapping (synthesis: chaos block)

**One-liner:** Each `MitmActionRecord` is converted into a `ChaosRule`
inserted into the scenario's `Setup` steps. This is the bridge that
makes an interactive session deterministically reproducible.

**Description.** The synthesiser walks the action list in order and
emits a `SetupStep { Type = SetupStepType.ChaosRule, Payload = … }` for
each rule-bearing action. Bare `BreakpointResume` records are dropped
(they imply "no rule, just observe"). `Replay` records become an
additional stimulus or a `Wait` setup step depending on order.

**Mechanism — projection table.**

| Action kind | Generated `SetupStep` | Payload `ChaosRuleSpec` |
|---|---|---|
| `Block` | `ChaosRule` | `{ action: "block", target: <url>, method: <m>, statusCode: 0 }` |
| `Forge` | `ChaosRule` | `{ action: "http_error", target, method, statusCode, body, headers }` — maps to existing `HttpFaultEntry.Fault="http_error"` (`EdogHttpFaultStore.cs:60-66`) |
| `ModifyRequest` | `ChaosRule` | `{ action: "rewrite_request", target, headerPatch, bodyPatch }` — *new fault type*, requires C01 extension |
| `ModifyResponse` | `ChaosRule` | `{ action: "rewrite_response", target, statusOverride, headerPatch, bodyPatch }` — *new fault type* |
| `Delay` | `ChaosRule` | `{ action: "latency", target, delayMs }` — direct mapping to existing `Fault="latency"` (`:117-123`) |
| `Replay` | `Stimulus` (appended) or `SetupStep { Type=Wait }` (if interleaved) | request body |
| `BreakpointResume` | *nothing emitted* | bare resume is not a rule |

**Rule reduction.** Multiple `Block` actions against the same URL collapse
to a single rule. The synthesiser groups by `(action, target, method)` and
keeps the *last* RuleSnapshot (latest user edit wins).

**Teardown emission.** For every emitted `ChaosRule` setup step, a
matching `TeardownStep { Type = TeardownStepType.RemoveChaosRule, Payload = { ruleId } }`
is appended in reverse insertion order (LIFO unwind, matching engine
expectation at `EdogQaExecutionEngine.cs:32`).

**Source code path.**
- Synthesiser: `MitmScenarioSynthesizer.BuildChaosSetupSteps(...)`.
- Chaos integration target: scenarios submitted via `QaSubmitCuratedScenarios`
  flow into `ChaosIntegration.ApplyChaosRuleAsync` (P0 §6.3 cites
  `EdogQaExecutionEngine.cs:1450`). The rule shape mapping above is
  bound by what `ChaosIntegration` accepts.
- New fault types (`rewrite_request`, `rewrite_response`): require
  C01 to extend `HttpFaultEntry.Fault` accepted values and add
  corresponding branches in `EdogHttpPipelineHandler.SendAsync`
  (current branches at `:74-128`). If C01 ships those types, C06
  emits them; otherwise C06 degrades by emitting a `Forge` rule
  capturing the *final* response observed (lossy but functional).

**Edge cases.**
- **ModifyResponse on a request that was never re-fired.** Without C05
  Causal Replay, modify-response rules need a stimulus to fire. C06's
  synthesiser auto-appends a `Stimulus { Type = HttpRequest, … }`
  reconstructed from the original captured request, so the scenario
  re-runs end-to-end without external help.
- **Header redaction collisions.** If a recorded modify added a header
  whose value the redactor would mask (`Authorization`, SAS), the
  generated rule stores the **redacted** value with metadata
  `{ "value_redacted": true }`. On execute, `ChaosIntegration` either
  fills from the live token store (preferred) or leaves the request
  unauthenticated. UI surfaces a warning badge on the generated rule.
- **`Block` followed by `Forge` for same URL within session.** Treated
  as two separate rules in setup order; the engine applies them
  sequentially per the deterministic Setup-step ordering.

**Interactions.**
- **C01 (rule store schema):** must enumerate the action types this
  spec produces. If C01's set is smaller, C06's degrade-to-Forge path
  applies.
- **F24 (`ChaosRuleSpec`):** C06 emits the same wire shape F24 documents
  in `signalr-protocol.md`. The scenario engine already accepts that
  shape per P0 §1.2.

**Revert / undo.** Once a scenario is generated, removing a rule means
editing the scenario before save (S08).

**Priority:** P0 for Block/Forge/Delay/Replay mappings; P1 for
ModifyRequest/ModifyResponse (depend on C01 extension).

---

### S05 — MITM observation → expectation mapping (synthesis: stimulus + expectations)

**One-liner:** The synthesiser reads what *actually happened* during the
recording — first HTTP call became the stimulus, observed status codes
and response shapes became expectations.

**Description.** A scenario is `setup → stimulus → expectations`. S04
covered setup. S05 covers the other two.

**Stimulus selection.**

1. Sort `HttpEvents` by sequence id.
2. Identify the **trigger** — the first HTTP event whose `httpClientName`
   does *not* belong to an EDOG-internal client (the `EdogHttpClientFactoryWrapper`
   namespace is excluded so EDOG's own /api calls don't become stimuli).
3. If the user fired the request via the API Playground during recording,
   that event is preferred (it carries `correlationId` starting `pg-`).
4. The trigger becomes `Stimulus { Type = HttpRequest, Method, Url, Headers, Body }`.
5. If no candidate trigger exists, fall back to `Stimulus { Type = Manual }`
   and tag the scenario `Lifecycle = Generated` with a TODO note.

**Expectation generation.**

| Observation | Generated `Matcher` |
|---|---|
| Every captured HTTP response | `Matcher { TopicField = "http.statusCode", Assertion = Equals, Value = Scalar(<observed>) }` (per URL+method tuple, OR'd into `OneOf` if the same tuple returned multiple statuses across the session) |
| Response body shape (JSON) | `Matcher { TopicField = "http.body.<key>", Assertion = Exists }` for each top-level key (depth-1 only in v1) |
| Response timing | `Matcher { TopicField = "http.durationMs", Assertion = InRange, Value = Range(observed × 0.5, observed × 3.0) }` — wide bounds because timing is noisy |
| MITM `Block` action with matching request | `Matcher { TopicField = "http.statusCode", Assertion = Equals, Value = Scalar(0) }` and `http.synthesized = Exists` |
| Retry topic events observed | `Matcher { TopicField = "retry.attempt", Assertion = InRange, Value = Range(0, <observed max>) }` |

The synthesiser uses the new contract-vocabulary `Matcher` (`EdogQaModels.cs:245-250`)
not the legacy `Expectation` shape — F27 P11 has standardised on matchers.

**Metadata population.**

- `Scenario.Technique = ScenarioTechnique.RegressionGuard` (default; user
  can change in S08).
- `Scenario.Category = ScenarioCategory.Regression`.
- `Scenario.Description` auto-filled from `"Recorded MITM session at {StartedAt}: blocked X, forged Y, modified Z"`.
- `Scenario.GroundingEvidence` populated with `{ Kind = "MitmRecording", Ref = sessionId }`
  to satisfy `LNT004_GroundingEvidenceMissing` (`EdogQaModels.cs:336-340`).
- `Scenario.TimeoutMs` set to `max(10_000, recordingDurationMs × 1.5)`,
  clamped to the model's 60s ceiling (`:310`).

**Source code path.**
- `MitmScenarioSynthesizer.BuildStimulus(HttpEvents)` — selection rules above.
- `MitmScenarioSynthesizer.BuildMatchers(HttpEvents, MitmActions, ContextEvents)`
  — produces `List<Matcher>` (model: `EdogQaModels.cs:245`).
- Range maths: `RangeMatcherValue` (`:209-215`).

**Edge cases.**
- **Failure-only sessions.** All responses are 5xx (the user was reproducing
  a bug). Expectations encode the 5xx. The generated scenario then *passes*
  when the bug reproduces — a deliberate inversion the UI surfaces with a
  "Regression-Guard for known failure" badge.
- **No response body (HEAD / 204 / blocked).** Body matchers omitted.
- **Body too large or binary.** Captured preview is limited by
  `EdogHttpPipelineHandler.CaptureBodyPreview` to 4 KB and skips binary
  (`:356-392`). When the recording exceeded that limit, only structural
  matchers (status, content-type, length range) are emitted.
- **Stimulus body redaction.** The trigger's request body may contain a
  bearer token (rare but possible). The synthesiser runs body through a
  conservative regex strip (JWTs, SAS sigs) before embedding; if it
  cannot prove safety, body is replaced with `"<redacted-by-recorder>"`
  and a linter warning emitted.

**Interactions.**
- **C05 Causal Replay:** the stimulus selected here is the same shape
  Causal Replay needs to re-fire a request. C06 stimulus + C05 mutation
  variables = the §6.24 "four-step loop" payoff.
- **F27 linter:** generated scenarios pass through the same lints
  (`LNT003_TechniqueRequired`, `LNT002_InvariantCoverage`,
  `LNT004_GroundingEvidenceMissing`). C06 prefills technique and
  evidence; `LNT002` may surface if the diff has invariants the user
  must claim — UI surfaces these as TODO chips in S08.

**Revert / undo.** Edit in S08.

**Priority:** P0.

---

### S06 — Scenario validation (all required fields, valid JSON)

**One-liner:** Before the **Generate** modal opens, the generated
scenario is run through `EdogQaScenarioValidator` (the same validator
the QA submission RPC uses). Validation results decorate the UI.

**Description.** Validation is the safety net. C06 emits scenarios that
*should* already be valid, but the generated artefact must satisfy the
same checks as any human-curated scenario before being executable.

**Mechanism.**

1. After synthesis, server runs `EdogQaScenarioValidator.Validate(submission)`
   (existing validator invoked at `EdogPlaygroundHub.QaSubmitCuratedScenarios`
   path — `EdogPlaygroundHub.cs:639` onward).
2. Validation produces `IReadOnlyList<ValidationFinding>` with
   `{ Severity, Code, FieldPath, Message }`.
3. Findings are returned as part of `MitmGenerateScenarioFromRecording`
   response, *not* an error — the scenario is still delivered, but the UI
   highlights fields with findings (S08 editor honours `fieldPath` for
   error placement).
4. **Severity gating:**
   - `Error` findings disable the **Save to QA panel** button until fixed
     in S08.
   - `Warning` findings show a yellow badge; save is allowed.

**Required fields enforced.**

| Field | Rule | Source |
|---|---|---|
| `Id` | non-empty, matches `scn-{slug}-{4-char-hash}` | `EdogQaModels.cs:273` comment |
| `Title` | 1–120 chars | `:276` |
| `Description` | 1–500 chars | `:279` |
| `Category` | enum value | `:282` |
| `Technique` | not `NotSpecified` | `:323`, `LNT003` |
| `Stimulus` | non-null | `:298` |
| `Matchers` | ≥ 1 entry (or `Expectations` ≥ 1) | `:301-304` |
| `TimeoutMs` | 1000–60000 | `:309-310` |
| `GroundingEvidence` | ≥ 1 entry | `:336-340`, `LNT004` |

**Source code path.**
- Validator: existing `EdogQaScenarioValidator` (referenced by the
  submission RPC — file location to confirm in C03 of F27).
- Synthesis-time pre-pass: `MitmScenarioSynthesizer.Synthesize(...)` returns
  `(QaScenarioSubmission, IReadOnlyList<ValidationFinding>)`.

**Edge cases.**
- **Validator throws.** Synthesis treats throw as a single
  `Error` finding with `Code = "VALIDATOR_THROW"` and proceeds.
  Never block scenario delivery on validator bug — the safety contract
  says "never crash the host" (`EdogQaExecutionEngine.cs:35`).
- **JSON serialisation failure.** Final step before returning to the
  client serialises with `JsonSerializer`. Failure → `Error` finding
  `SCENARIO_NONSERIALIZABLE`. (Unlikely given typed models, but guarded.)
- **Schema version mismatch.** `Scenario.Metadata.SchemaVersion` set to
  current model version constant; if older models are loaded later it
  triggers `Warning` rather than `Error`.

**Interactions.**
- **F27 linter:** same finding codes (`LNT001`–`LNT004`); shared report
  UI in the QA panel.
- **S08 editor:** receives the findings list, maps to inline editor
  decorations.

**Revert / undo.** N/A — validation is read-only.

**Priority:** P0.

---

### S07 — Export to QA panel (deep link)

**One-liner:** User clicks **Save to QA panel** in the Generated Scenario
modal. The scenario is submitted via `QaSubmitCuratedScenarios`; the QA
panel opens with the new scenario selected and highlighted.

**Description.** Export is the bridge to the existing QA workflow. After
this step the scenario is indistinguishable from one a human curated —
visible in the QA list, executable via the existing run RPC, lintable,
editable, deletable through QA-panel mechanisms.

**Mechanism.**

1. Frontend invokes
   `connection.invoke('QaSubmitCuratedScenarios', { scenarios: [generated] })`
   (`EdogPlaygroundHub.cs:639`).
2. On success the RPC returns `QaSubmissionResult { acceptedIds, rejected[] }`.
3. Frontend navigates to the QA panel (existing tab-switch helper),
   passing a deep-link parameter `?scenarioId={acceptedIds[0]}&from=mitm-rec`.
4. QA panel scrolls the new scenario into view, expands its row, briefly
   highlights it with the existing "Recently added" flash animation
   (already implemented for QA P5 in `tab-qa-scenarios.js`).
5. C06 publishes `mitm.recording.scenario_exported` so the recording
   session can be marked `Generated → Exported` in its store entry, and
   the HTTP tab toolbar **Record** pill resets.

**Deep link contract.** URL fragment / query keys:
- `scenarioId` — the accepted scenario id
- `from=mitm-rec` — analytics + UI hint ("Imported from MITM recording at {ts}")
- `sessionId` — original recording session (optional, for traceability)

**Source code path.**
- Submission: reuse `QaSubmitCuratedScenarios` unchanged.
- Deep-link receiver: extend QA tab activation logic to consume the
  three keys (frontend only).
- Toolbar reset: HTTP tab updates the **Record** pill state on the
  `mitm.recording.scenario_exported` event.

**Edge cases.**
- **Submission rejected.** `QaSubmissionResult.rejected` non-empty →
  modal stays open; rejection reasons surface as inline errors mapped
  by `fieldPath` (reuse S06 decoration UI).
- **Deep link race.** QA panel may still be loading its scenario list
  when the deep link arrives; UI parks the highlight intent in a
  pending-id slot and applies it once the list renders (same pattern
  as the existing `pendingScenarioFocus` in tab-qa-scenarios.js, if
  present; otherwise add).
- **Multiple acceptances.** Generated submission always carries exactly
  one scenario from C06, but the RPC accepts arrays. If callers later
  batch, the deep link uses the first accepted id and lists the rest
  as a comma-separated tooltip.

**Interactions.**
- **F27 QA panel:** consumes the submitted scenario through its existing
  list query / cache; no special path needed.
- **S14 cleanup:** exported sessions are eligible for immediate cleanup
  (no 5-minute grace) since the scenario is now persisted on the QA side.

**Revert / undo.** Delete the scenario from the QA panel — that path
already exists. There is no "unexport" RPC.

**Priority:** P0.

---

### S08 — Edit generated scenario before save

**One-liner:** The Generated Scenario modal embeds an inline editor over
the synthesised JSON. The user can rename, retitle, change technique,
tweak matcher bounds, remove unwanted setup steps, add a description —
then save.

**Description.** Auto-generated scenarios are starting points. The editor
is the curation surface that turns "what I just did" into "what I want
to test forever". Without S08, recordings stay disposable.

**Mechanism.**

1. Modal renders four panes:
   - **Header** — Title, Description, Category, Technique, Priority,
     TimeoutMs (linked to `Scenario` fields at `EdogQaModels.cs:271-323`).
   - **Setup** — sortable list of `SetupStep`s with per-step inline edit
     (delete, edit JSON, reorder).
   - **Stimulus** — single editor pane (method/URL/headers/body)
     leveraging the existing `RequestBuilder` shell from
     `src/frontend/js/api-playground.js:442` (P0 §1.8 calls this out as
     the reuse target).
   - **Expectations** — list of `Matcher` rows with assertion + value
     editors keyed off `MatcherAssertion` (`EdogQaModels.cs:179-188`).
2. Every edit re-runs the validator (S06) client-side via a lightweight
   stub plus server-side on Save. Findings update inline live.
3. Save submits via S07 path.
4. Cancel discards edits but keeps the underlying recording session in
   `Generated` state so the user can re-open by clicking the persistent
   "Recording ready" pill.

**Editing constraints.**

- The recording session id and `GroundingEvidence` entry pointing to it
  are **read-only** in the editor (preserves traceability). User can
  add additional evidence entries, not remove the recorder-stamped one.
- Changing the Stimulus URL invalidates Matchers that pin `http.url`.
  UI shows a warning and offers "Regenerate matchers from new URL".

**Source code path.**
- Modal component: new `src/frontend/js/mitm-scenario-editor.js`,
  rendered above the HTTP tab via portal pattern.
- Reuse: `RequestBuilder` from `api-playground.js:442` for the stimulus
  pane (extract a shared `RequestEditor` subset per P0 §1.8).
- Matcher editor: new, mapping by `MatcherAssertion` enum.

**Edge cases.**
- **Modal closed by accident.** Browser-level "Are you sure?" guard if
  edits exist; recording session preserved per S03.
- **Edits make scenario invalid (drop required field).** Save disabled,
  inline errors surface from validator findings.
- **Concurrent recording.** If a *second* recording is in progress
  (different tab/connection), this modal does not interfere — recorders
  are scoped per `OwnerConnectionId`.

**Interactions.**
- **F27 QA editor:** if F27 already ships a QA scenario editor, C06
  should reuse its components rather than duplicate. Defer the
  reuse-vs-fork decision to the F28 master spec's `code-reuse-map`
  during build planning.

**Revert / undo.** Per-field undo within the editor; full discard via
modal Cancel.

**Priority:** P0 (recording without editing is too rigid to be useful).

---

### S09 — Time-Travel Forgery: capture response as template

**One-liner:** User right-clicks any row in the HTTP tab → **Use as
forgery template**. The captured response is snapshotted into a
`ForgeryTemplate` and the Forge rule editor opens pre-filled.

**Description.** Time-Travel Forgery's source of truth is the live `http`
ring buffer (2000 events). Captured rows already carry status, headers,
and body preview. S09 freezes one of those rows into a template object
that can be re-applied later regardless of whether the original event
ages out of the ring.

**Mechanism.**

1. Context-menu item is added in `tab-http.js` `_buildContextMenu` (extend
   the existing right-click handler around row rendering at
   `tab-http.js:907-943`).
2. On click, frontend invokes
   `MitmCaptureResponseAsTemplate({ eventSequenceId, eventTopicSnapshot? })`.
3. Server first tries to re-read the event from the `http` topic ring
   (`TopicBuffer.GetSnapshot()` — `TopicBuffer.cs:83-86`). If found, it's
   the source of truth. If the event has aged out, the server accepts the
   `eventTopicSnapshot` payload the frontend sent (the row entry already
   in the frontend's 2000-event ring per P0 §1.6, L42) as a fallback.
4. Construct `ForgeryTemplate { Id, OriginUrl, OriginMethod, CapturedAt,
   StatusCode, Headers, Body, BodyContentType, BodySizeBytes }`.
5. Store in `ForgeryTemplateStore` (in-memory, per-`OwnerConnectionId`).
6. Publish `mitm.template.created` event on the `mitm` topic.
7. Hub response delivers the template object; frontend opens the Forge
   rule editor pre-filled with `{ Action = Forge, Status = template.StatusCode,
   Headers = template.Headers, Body = template.Body }` and `Target` set
   to the captured URL pattern (defaults to exact-URL match; user can
   loosen to substring in S10).

**Source code path.**
- Context-menu: `src/frontend/js/tab-http.js` row event handlers.
- RPC: `EdogPlaygroundHub.MitmCaptureResponseAsTemplate`.
- Store: `src/backend/DevMode/MitmForgeryTemplateStore.cs`.
- Reuse: response shape comes from `tab-http.js _onEvent` row entry
  (P0 §1.6 row-shape).

**Edge cases.**
- **Captured response body was truncated.** The handler caps at 4 KB
  (`EdogHttpPipelineHandler.CaptureBodyPreview` — `:356-392`). Template
  carries the truncated body and a flag `BodyTruncated: true`. UI shows
  a yellow badge "Captured body was truncated at 4 KB" with an info
  tooltip explaining the cap. User can hand-extend the body in the
  editor.
- **Binary body.** Captured-as-base64 with `BodyContentType` set; UI
  warns "Forging binary body — preview disabled".
- **Redacted headers.** `Authorization` and SAS values are already
  redacted in published events. The template stores the redacted value;
  applying it would forge a fake `[redacted]` header. The Forge editor
  must let the user paste a real value if needed (with the same
  redaction-policy disclosure the P0 §1.1 ADR call-out lists).
- **Source row deleted from frontend ring.** Falls back to server ring;
  if both miss, returns `404 NotFound` envelope and UI toast.

**Interactions.**
- **S10:** template is the input to a Forge rule.
- **S12:** template can be saved with a name into the library.
- **C03 (rule store):** unaffected; template is *not* a rule until
  applied.

**Revert / undo.** Unnamed templates auto-expire after 30 minutes of
non-use. Saved templates (S12) are deleted explicitly.

**Priority:** P0.

---

### S10 — Time-Travel Forgery: create forge rule from template

**One-liner:** In the Forge editor opened from S09 (or from a saved
template in S12), the user edits the URL pattern, optionally tweaks
status/headers/body, and clicks **Apply**. A live `MitmRule` is created.

**Description.** S09 produces a template; S10 turns the template into a
running rule. The rule is exactly the same wire shape as any other Forge
rule produced by C03's editor.

**Mechanism.**

1. Frontend invokes
   `MitmApplyForgeryTemplate({ templateId, ruleOverrides: { target, method, statusCode?, headers?, body?, ttlSeconds? } })`.
2. Server fetches template from `MitmForgeryTemplateStore`, merges with
   overrides, builds a `MitmRule { Action = Forge, … }` matching the
   C01 rule schema.
3. Hands off to C03's rule store (`MitmRuleStore.AddRule(rule)`); store
   atomically swaps in the new immutable snapshot (pattern at
   `EdogHttpFaultStore.cs:109-136`).
4. Publishes `mitm.template.applied` event linking `templateId → ruleId`
   for the action recorder (S02) to project if a recording is active.
5. Returns the live `MitmRule` to the frontend; UI confirms with a
   toast "Forging future calls to {target}" and adds a row to the
   Active Rules side panel.

**Pre-fill defaults from template.**

| Editor field | Default from template |
|---|---|
| Target | exact URL of `template.OriginUrl` |
| Method | `template.OriginMethod` |
| Action | `Forge` |
| Status | `template.StatusCode` |
| Response headers | `template.Headers` (subset; UI lets user drop) |
| Response body | `template.Body` |
| Content-Type | `template.BodyContentType` |
| TTL | unset (rule lives until manually removed or session ends) |

**URL-pattern hint.** The default exact-URL match is too tight in
practice (a request rarely repeats with identical query parameters).
The editor shows a "Loosen" dropdown with three presets:

- **Exact** — `target = full URL`
- **Path-only** — strip query string
- **Substring** — keep only the path segment that the user highlights
  (default to the last path segment, e.g. `/Tables`)

**Source code path.**
- RPC: `EdogPlaygroundHub.MitmApplyForgeryTemplate`.
- Rule store insert: C01's `MitmRuleStore.AddRule` (mirrors
  `EdogHttpFaultStore.cs:109-136`).
- Editor UI: shared with C03's Forge rule editor — Time-Travel just
  enters it with pre-filled values.

**Edge cases.**
- **Template body truncated (S09 edge).** Applying a truncated body
  yields a forged response shorter than the original. UI warns
  prominently before Apply; saved templates can be edited to add the
  missing tail.
- **Status 0 in template** (the captured response was itself a synthesised
  block from a previous MITM action). Allowed — applying it forges
  another block. UI labels the action `Block (via template)` for clarity.
- **Apply while a request is currently in-flight.** The rule is now
  visible to the next `TryMatchFault` (`EdogHttpFaultStore.cs:174-194`);
  in-flight requests are unaffected. This is the documented invariant
  (rules apply forward only).

**Interactions.**
- **C01:** rule storage. **C03:** Forge editor reuse. **S02:** the apply
  event becomes a `MitmActionRecord` if a recording is live.

**Revert / undo.** Remove the rule via the Active Rules panel
(`MitmRemoveRule`, owned by C01). Template remains intact for re-apply.

**Priority:** P0.

---

### S11 — Time-Travel Forgery: combine with Causal Replay

**One-liner:** From a paused / completed request, click **Replay** (C05)
after applying a forgery template from S09/S10 — the original request
fires again, this time intercepted by the forgery rule.

**Description.** This is where Time-Travel becomes truly time-travel:
the rule was forged from yesterday's response, the request is the one
that just failed today, and the replay rewires the system to see
yesterday's response in today's iteration.

**Mechanism.**

1. The user has a captured request `R` in the HTTP tab.
2. From `R`, S09 → S10 produces a Forge rule `F` whose target matches
   `R`'s URL.
3. User invokes C05's Replay action on `R` (right-click → **Replay**).
4. C05 issues the request through `EdogHttpPipelineHandler` (it goes
   out as a real HTTP call but with the same correlation context).
5. The handler hits `TryMatchFault` (`EdogHttpFaultStore.cs:174`),
   finds `F`, synthesises via `SynthesizeErrorResponse`
   (`EdogHttpPipelineHandler.cs:160-173`).
6. The replay sees the forged response. The HTTP tab shows a *new* row
   (the replay) tagged `mitm.synthesized = true` and visually
   distinguished by the `http-row-forged` style (P0 §1.6 calls out).

**No new code path in C06.** The composition is purely emergent —
S10 produces a normal `MitmRule`, and C05 replays through the normal
handler. C06 documents the workflow and ensures S09's context-menu and
S10's rule editor are reachable from the same row C05 surfaces Replay on.

**UX glue.** The right-click menu on an HTTP row exposes both items
adjacent to each other:

```
▸ Use as forgery template          (S09)
▸ Apply template + replay…         (S09 + S10 + C05 one-shot, advanced)
▸ Replay                           (C05)
```

The compound **"Apply template + replay"** option is a frontend macro
that pipelines `MitmCaptureResponseAsTemplate` → `MitmApplyForgeryTemplate`
(with default Exact-URL target) → C05 Replay RPC. No new RPC required.

**Source code path.**
- Macro orchestration: frontend `tab-http.js` row context-menu handlers.
- All RPCs already exist (S09, S10) or are defined by C05.
- The "replay sees forged response" semantics depend on
  `EdogHttpPipelineHandler.SendAsync` matching the rule before forwarding —
  already the case for fault rules (`:74-128`).

**Edge cases.**
- **Forge target too tight to match the replay.** If the user picked
  Exact-URL but the replay sends slightly different query params, the
  rule misses. UI hint after compound macro fails: "Replay returned
  the real response — loosen forgery URL pattern? [Path-only] [Substring]".
- **Multiple rules match the same replay URL.** First-match wins per
  `EdogHttpFaultStore.cs:174-194` linear scan. C03's Active Rules panel
  shows order; the rule list can be reordered by the user.
- **Replay against a Block forgery.** Replay yields status 0 (timeout-like
  synthesis pattern). This is intentional — to reproduce a "this call
  never reached the service" condition.

**Interactions.**
- **C05 Causal Replay:** the *consumer* of the rule. C06 does not
  modify C05; they compose.
- **§6.24 narrative:** this scenario is the literal pivot in the
  four-step loop ("Make every retry of this URL succeed with the
  response from 10 minutes ago").

**Revert / undo.** Remove the rule (C01 owns rule removal).

**Priority:** P0 (this is the *wow* moment for Part B).

---

### S12 — Forgery template library (save / recall named templates)

**One-liner:** Templates can be named, saved, listed, searched, and
re-applied later within the same UI session.

**Description.** Without persistence, every forgery is one-shot. The
library lets users build a kit of "known responses" they can apply
across debug sessions: *"500 with Microsoft-Fabric error envelope"*,
*"empty Tables response"*, *"429 with Retry-After 30"*, etc.

**Mechanism.**

1. Templates start unnamed (from S09). The Forge editor sidebar shows a
   **"Save template"** button that opens a name prompt.
2. `MitmSaveForgeryTemplate({ template })` writes to the per-connection
   store and stamps an immutable `Id`. Saved templates skip the
   30-minute auto-expiry that unnamed templates have (S09 edge).
3. A new HTTP-tab side panel — **Forgery Library** — lists saved
   templates with: name, origin URL, status, captured-at, size.
   Filters: text search, status-code chip, only-mine vs. shared.
4. Click → opens read-only preview; **Apply** routes to S10 with the
   template's payload pre-filled.
5. `MitmDeleteForgeryTemplate(id)` removes; UI confirms.

**Persistence model.**

- v1: in-memory, per `OwnerConnectionId` with a 5-minute reconcile
  window across reconnects (matches MITM rule store P0 §1.10).
- v1.1 candidate: persist to `%LOCALAPPDATA%/edog-studio/forgery-templates.json`
  scoped per user; share by export/import.

**Sharing (deferred to v1.1).** Each saved template can be exported as a
single JSON file (`.fgt.json`) and imported by another tab. Schema is
exactly the `ForgeryTemplate` wire shape.

**Source code path.**
- Store: `MitmForgeryTemplateStore.cs` adds `Save`, `List`, `Delete`,
  `GetById`. The base structure already exists from S09.
- RPCs: `MitmSaveForgeryTemplate`, `MitmListForgeryTemplates`,
  `MitmDeleteForgeryTemplate`.
- UI: new sidebar panel in `tab-http.js`, opened by a toolbar button
  next to **Record**.

**Edge cases.**
- **Name collision.** Two saves with the same name → append `(2)`,
  `(3)`, … . Store keys by `Id`, not name.
- **Template references a body that exceeded the 4 KB capture cap.**
  Library shows truncated badge; warns on Apply.
- **Disconnect drops in-memory templates.** UI re-fetches with
  `MitmListForgeryTemplates` on reconnect; templates inside the
  5-minute window survive (server-side keyed by user identity, not
  connection id).

**Interactions.**
- **S09 → S10:** library entries are alternate entry points to S10.
- **S07 export:** scenarios can carry a baked-in forged response
  identical to a saved template; UI offers "Promote scenario forgery
  → library template" as a v1.1 affordance.

**Revert / undo.** Single-template Delete; no bulk-delete in v1.

**Priority:** P1 (Apply-from-capture in S10 is the P0 path; library is
quality-of-life).

---

### S13 — Performance (recording overhead < 1 ms per event)

**One-liner:** Recording must add < 1 ms per `http`/`mitm` event observed,
< 50 μs per synthesised `MitmActionRecord`, and must never block the
`TopicBuffer.Write` hot path.

**Description.** The recorder is observer-based on `TopicBuffer.AddObserver`,
which fires *synchronously* inside `TopicBuffer.Write`
(`TopicBuffer.cs:73-78`). Every microsecond the observer takes is paid
on the thread of whoever published the event — including HTTP request
threads. A slow recorder would tax the very pipeline it's recording.

**Performance contract.**

| Operation | Budget | Mechanism to hit it |
|---|---|---|
| Per `http` event observed | < 100 μs | Append to `List<TopicEvent>` under a per-session `lock`; no JSON, no projection |
| Per `mitm` event observed → `MitmActionRecord` | < 50 μs | Projection is field-extraction only; no string formatting beyond redaction |
| Context-event filter (drop if correlationId not in session set) | < 10 μs | `HashSet<string>` lookup |
| `MitmStopRecording` finalisation | < 50 ms | Drop observer subscriptions, no buffer copy |
| `MitmGenerateScenarioFromRecording` | < 500 ms for ≤ 1000 HTTP events | Synthesis is O(N) over events; no nested loops worse than O(N×actions) |
| `MitmCaptureResponseAsTemplate` | < 20 ms | Ring snapshot + object copy |

**Memory contract.**

| Quantity | Cap | Behaviour on cap |
|---|---|---|
| Events per topic per session | 10 000 | State → `Aborted("event_cap_exceeded")` |
| Concurrent active sessions per process | 4 | 5th `MitmStartRecording` returns 429 |
| Templates per user | 200 | Save returns 429; UI prompts delete-old |
| Total recorder heap | ~50 MB | Same ballpark as `EdogQaRecordingSession` `MaxEventsPerScenario = 50_000` cap (`EdogQaExecutionEngine.cs:76`) |

**Source code path.**
- Hot path: `MitmRecorderStore.OnHttpEvent / OnMitmEvent / OnContextEvent`.
- Microbenchmark target: < 1 μs added to `TopicBuffer.Write` when no
  recording is active (zero observers attached — falls through the
  observer list check at `:73`).
- Cap enforcement: `Interlocked.CompareExchange` counter pattern from
  `EdogQaRecordingSession.cs:128`.

**Edge cases.**
- **GC pressure.** Allocating a `MitmActionRecord` per `mitm` event
  could thrash gen-0. Mitigation: object-pool not used in v1 (recorder
  events are O(100s) per session); revisit if profiling shows hotness.
- **Observer throws.** `TopicBuffer.AddObserver` wraps callbacks — but
  C06 must verify: any throw inside observer is caught and logged,
  observer continues. Pattern: try/catch in the observer body, swallow,
  log to `_logger` at Warning.
- **Long recording sessions** (> 1 hour). State `Active` is fine as
  long as caps hold, but the UI auto-warns at 30 minutes ("Long
  recording — consider stopping").

**Interactions.**
- **C01/C03 hot path:** the no-recording case must add zero cost. C06
  installs observers only when a recording is active; the rest of the
  time `TopicBuffer.AddObserver` consumers list is empty.
- **Test harness:** Sentinel adds a perf-gate test that asserts
  per-event overhead < 100 μs on the dev box using `BenchmarkDotNet`
  (same convention used by other DevMode perf tests).

**Revert / undo.** N/A.

**Priority:** P0 — perf regressions here block ship.

---

### S14 — Recording session cleanup on disconnect

**One-liner:** When a SignalR connection drops (intentional or otherwise),
all active recording sessions, generated-but-unexported scenarios, and
unnamed forgery templates owned by that connection are cleaned up.

**Description.** The recorder is a process-side resource owned by a UI
session. If the UI goes away, the resource must go away too — otherwise
the process accumulates dead recorders that hold observers attached and
consume memory.

**Mechanism.**

1. `EdogPlaygroundHub.OnDisconnectedAsync` (extend the existing override
   near `EdogPlaygroundHub.cs:406`) calls
   `MitmRecorderStore.CleanupForConnection(connectionId, reason)` and
   `MitmForgeryTemplateStore.CleanupForConnection(connectionId, reason)`.
2. `MitmRecorderStore.CleanupForConnection`:
   - Enumerate sessions where `OwnerConnectionId == connectionId`.
   - For each `Active` session: dispose observer subscriptions; set
     state `Aborted("connection_closed")`. *Do not delete immediately* —
     hold for 5 minutes against reconnect.
   - For each `Stopped` / `Generated` session: hold for 5 minutes.
   - For each `Exported` session: delete immediately.
3. A background sweeper (single `Timer`, fired every 60 s, started at
   process init by `MitmRecorderStore`'s constructor) deletes held
   sessions older than 5 minutes.
4. On reconnect, the frontend calls `MitmGetActiveSessions` (a tiny
   helper RPC that returns sessions for the new connection by user
   identity) so a re-attached UI can resume showing the "Recording
   ready" pill.
5. `MitmForgeryTemplateStore.CleanupForConnection`:
   - Unnamed templates → delete immediately (they exist only for the
     duration of the modal that opened them).
   - Named (saved) templates → keyed by user identity, not connection
     id; survive reconnect natively.

**Reconnect path.**

The SignalR auto-reconnect schedule `[0, 1000, 2000, 5000, 10000, 30000]`
(`signalr-manager.js:53-122`) means most reconnects happen in ≤ 30 s.
The 5-minute hold window comfortably covers reasonable network blips
without surfacing data loss to the user.

**Source code path.**
- Hub hook: `EdogPlaygroundHub.OnDisconnectedAsync` (existing override).
- Store: `MitmRecorderStore.CleanupForConnection`,
  `MitmRecorderStore.SweepExpired`.
- Sweeper timer: started in `MitmRecorderStore` constructor; stopped
  on host shutdown via `IHostApplicationLifetime.ApplicationStopping`.
- Pattern reference: `EdogQaRecordingSession.Dispose` (`:194-203`) —
  same disposal-before-detach safety.

**Edge cases.**
- **Disconnect during scenario generation.** The synthesis call is
  in-flight, the connection drops. The hub method completes server-side
  and the resulting envelope is dropped (no client listening). State
  ends as `Generated` and is held 5 minutes; reconnecting client can
  call `MitmGetActiveSessions` and re-fetch the scenario via a new
  `MitmGetGeneratedScenario(sessionId)` helper RPC.
- **Process shutdown.** Sweeper timer stops; all in-memory state is
  discarded — no persistence in v1.
- **User logs out / identity changes.** Cleanup runs the same as
  disconnect; saved templates keyed by old identity remain orphaned in
  memory for 5 minutes then GC'd (no shared-identity leakage because
  the store keys by identity, not session).
- **Observer leak on partial Dispose.** If `Dispose` throws midway
  through the subscription list, the in-progress flag `IsDisposed` is
  already set so subsequent callbacks no-op; we still finish the
  Dispose loop in a `finally` block. Same defensive structure as
  `EdogQaRecordingSession.Dispose` (`:194-203`).

**Interactions.**
- **C01/C03 rule cleanup:** disconnect also clears interactive MITM
  rules (C03's contract). C06 cleanup must not assume rules persist —
  but it doesn't, because templates are independent of the rule store.
- **S07 export:** exported scenarios live in QA — they survive
  disconnect via QA's own persistence (not C06's concern).

**Revert / undo.** N/A — cleanup is the revert.

**Priority:** P0 — leak avoidance is a ship-blocker.

---

## 4. Open questions for review

| # | Question | Default decision | Owner |
|---|---|---|---|
| Q1 | Should `ModifyRequest` / `ModifyResponse` chaos actions ship in v1, or degrade to `Forge`-with-captured-final-response? | Degrade in v1; full action set in v1.1 once C01 lands rewriting | Sana + Vex |
| Q2 | Persist forgery library to disk in v1 or v1.1? | v1.1 (`%LOCALAPPDATA%` scoped) | Sana |
| Q3 | "Apply template + replay" compound macro — visible in v1 or behind an advanced flag? | Visible, but second-tier in the menu | Pixel |
| Q4 | 4 KB body cap is the same blocker P0 §1.1 / §4 raised — raise the cap (e.g. 64 KB) specifically for recorder-driven captures? | Add an opt-in `captureFullBody` flag on `MitmCaptureResponseAsTemplate`; defaults to false | Vex |
| Q5 | Multiple concurrent recordings (4-cap per process per S13) — UI to surface them all, or only the connection's own? | Only own (per-connection scoping) | Pixel |

---

## 5. Out of scope (explicit non-goals)

- **Persistent storage of recordings across process restarts.** Recordings
  exist only in-memory; export to QA is the persistence path.
- **Editing the captured *request* of a Time-Travel template.** Templates
  capture responses only. Editing the future request that triggers the
  forgery is C03's job via the rule editor.
- **AI-assisted scenario generation.** §6.5 Tier-1 idea is deferred to v1.1.
- **Comparing two recordings.** §6.9 Differential Replay is a separate
  component (Tier-2, deferred).
- **Sharing templates across users.** v1 keys everything per-identity;
  multi-user share is a v1.1 feature gated on Q2.

---

## 6. Cross-component dependency map

| Depends on | What from it | Status |
|---|---|---|
| **C01** — `MitmRule` model + `MitmRuleStore` | rule schema, `AddRule`/`RemoveRule`, capability flag | Required for S10. If `ModifyRequest`/`ModifyResponse` actions absent, S04 degrades. |
| **C02** — `mitm` topic registered | observer attachment point for S02 | Required for S01. |
| **C03** — Forge rule editor UI; control-plane event schema (`mitm.rule.applied`, `mitm.breakpoint.resumed`, …) | S02 projection table | Required for S02. |
| **C04** — Breakpoint pause/resume; `mitm.breakpoint.resumed` carries diff | S02 modify-action capture fidelity | Required for full-fidelity ModifyRequest/Response recording. Degrade path: capture final request/response objects without diff. |
| **C05** — Causal Replay RPC + Replay row context-menu action | S11 macro | Required for S11. |
| **F27 QA** — `QaSubmitCuratedScenarios`, `EdogQaScenarioValidator`, scenario lifecycle | S06 validation, S07 export | Already shipped; reuse without modification. |

---

## 7. Source code path index (quick reference)

| File | Sections |
|---|---|
| `src/backend/DevMode/EdogHttpPipelineHandler.cs:46-144` | Interception point — recorder consumes via topics, not direct hooks |
| `src/backend/DevMode/EdogHttpPipelineHandler.cs:160-173` | `SynthesizeErrorResponse` — Forge primitive used by S10/S11 |
| `src/backend/DevMode/EdogHttpFaultStore.cs:109-194` | Store insert/match — S10's rule lands here via C01 |
| `src/backend/DevMode/EdogTopicRouter.cs:74-95` | Publish used by `mitm.recording.*` events |
| `src/backend/DevMode/TopicBuffer.cs:73-95` | Observer hook — basis for recorder capture (S01/S02) |
| `src/backend/DevMode/EdogQaRecordingSession.cs:90-203` | Reference pattern for observer lifetime + dispose safety |
| `src/backend/DevMode/EdogQaExecutionEngine.cs:22-37` | 8-phase loop — generated scenarios execute through this |
| `src/backend/DevMode/EdogPlaygroundHub.cs:419-463` | `SubscribeToTopic` — used by frontend `mitm`-topic subscription |
| `src/backend/DevMode/EdogPlaygroundHub.cs:639-758` | `QaSubmitCuratedScenarios` — S07 export target |
| `src/backend/DevMode/EdogPlaygroundHub.cs:1055-1070` | `QaGetCapabilities` — capability flag delivery |
| `src/backend/DevMode/EdogQaModels.cs:245-260` | `Matcher` / `MatcherValue` — S05 generated assertions |
| `src/backend/DevMode/EdogQaModels.cs:271-340` | `Scenario` model — synthesis target |
| `src/frontend/js/tab-http.js:13-60` | Tab subscription bootstrap |
| `src/frontend/js/tab-http.js:194-397` | Toolbar — add **Record** pill (S01) |
| `src/frontend/js/tab-http.js:444-487` | Detail tabs — add forgery template pane (S09) |
| `src/frontend/js/tab-http.js:907-943` | Row rendering — context menu entry points (S09/S11) |
| `src/frontend/js/api-playground.js:442-555` | `RequestBuilder` — reuse for S08 stimulus editor |
| `src/frontend/js/signalr-manager.js:179-224` | `on()` / `subscribeTopic()` — frontend hook for `mitm` events |

---

*End C06 spec.*
