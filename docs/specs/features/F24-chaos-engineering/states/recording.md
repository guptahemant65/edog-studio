# State Matrix: Recording & Playback

> **Prep Item:** P3.5
> **Author:** Staff UX Engineer (Recording/Playback specialist)
> **Status:** READY FOR REVIEW
> **Depends On:** `C05-observability.md` (OB-01, OB-02), `signalr-protocol.md` §1.3 + §2.3
> **Feeds Into:** `mocks/recording-viewer.html` (P4.4)

---

## 0. Overview

The Recording & Playback sub-view captures HTTP traffic to named sessions, enables post-hoc browsing and inspection, exports to HAR 1.2 for Chrome DevTools / Charles Proxy, supports import of external HAR files, and compares two recordings for before/after diff analysis.

**One recording at a time.** Starting a new recording while one is active auto-stops the current session. This mirrors Postman's collection runner model — simple, no confusion about which session is capturing.

---

## 1. State Diagram

```
                                ┌─────────────────────┐
                                │  recording.idle.empty │  No recordings exist
                                └──────────┬──────────┘
                                           │ User creates first recording
                                           ▼
  ┌──────────────────┐   Click Record   ┌──────────────────┐
  │  recording.idle   │ ───────────────► │ recording.starting│
  │  (list of saved)  │                  │ (initializing)    │
  └──┬─┬─┬──┬───┬────┘                  └────────┬─────────┘
     │ │ │  │   │                                 │ SignalR success
     │ │ │  │   │                                 ▼
     │ │ │  │   │                        ┌──────────────────┐
     │ │ │  │   │                        │ recording.active  │ ◄───── RecordingEntry events
     │ │ │  │   │                        │ (timer, counter)  │        stream in real-time
     │ │ │  │   │                        └───┬──────────┬───┘
     │ │ │  │   │                            │          │ Approaching limit
     │ │ │  │   │                            │          ▼
     │ │ │  │   │                            │  ┌──────────────────────┐
     │ │ │  │   │                            │  │ recording.active     │
     │ │ │  │   │                            │  │         .overflow    │
     │ │ │  │   │                            │  └───────────┬──────────┘
     │ │ │  │   │                            │              │
     │ │ │  │   │           User stops / ────┴──────────────┘
     │ │ │  │   │           limit reached / FLT exit
     │ │ │  │   │                            │
     │ │ │  │   │                            ▼
     │ │ │  │   │                   ┌──────────────────┐
     │ │ │  │   │                   │ recording.stopping│ Flushing buffer
     │ │ │  │   │                   └────────┬─────────┘
     │ │ │  │   │                            │ Flush complete
     │ │ │  │   │                            ▼
     │ │ │  │   │                   ┌──────────────────┐
     │ │ │  │   │                   │  recording.saved  │ Summary displayed
     │ │ │  │   │                   └────────┬─────────┘
     │ │ │  │   │                            │ Auto-transition (2s) or click
     │ │ │  │   │                            ▼
     │ │ │  │   │                   Back to recording.idle
     │ │ │  │   │
     │ │ │  │   │  Select recording
     │ │ │  │   └──────────────────► ┌───────────────────────┐
     │ │ │  │                        │  recording.reviewing   │ Entry list + timeline
     │ │ │  │                        └────┬──────────────────┘
     │ │ │  │                             │ Click entry
     │ │ │  │                             ▼
     │ │ │  │                        ┌───────────────────────┐
     │ │ │  │                        │  recording.reviewing   │
     │ │ │  │                        │            .detail     │ Req/res inspector
     │ │ │  │                        └────────────────────────┘
     │ │ │  │
     │ │ │  │  Click Export
     │ │ │  └──────────────────────► ┌───────────────────────┐
     │ │ │                           │  recording.exporting   │ Converting to HAR
     │ │ │                           └────────┬──────────────┘
     │ │ │                                    ▼
     │ │ │                           ┌───────────────────────┐
     │ │ │                           │ recording.export       │
     │ │ │                           │         .complete      │ Download triggered
     │ │ │                           └────────────────────────┘
     │ │ │
     │ │ │  Select two recordings
     │ │ └─────────────────────────► ┌───────────────────────┐
     │ │                             │  recording.comparing   │ Computing diff
     │ │                             └────────┬──────────────┘
     │ │                                      ▼
     │ │                             ┌───────────────────────┐
     │ │                             │ recording.comparing    │
     │ │                             │          .results      │ Diff table
     │ │                             └────────────────────────┘
     │ │
     │ │  Click Delete
     │ └───────────────────────────► ┌───────────────────────┐
     │                               │  recording.deleting    │ Confirm dialog
     │                               └────────────────────────┘
     │
     │  Click Import
     └─────────────────────────────► ┌───────────────────────┐
                                     │  recording.importing   │ File picker + parse
                                     └────────────────────────┘
```

---

## 2. State Definitions

### 2.1 `recording.idle.empty`

**When:** Panel opens and `ChaosGetRecordings` returns an empty array.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | `● Record` button (primary), `Import HAR` button (secondary) |
| **Data displayed** | Empty state illustration: "No recordings yet. Click Record to capture HTTP traffic." |
| **Toolbar** | Record button enabled, Export/Compare/Delete disabled (greyed) |
| **Keyboard** | `R` → focus Record button, `I` → Import HAR |
| **Transitions** | Click Record → `recording.starting`, Click Import → `recording.importing` |
| **Error states** | SignalR disconnected → Record button disabled, tooltip: "Reconnecting to FLT..." |

---

### 2.2 `recording.idle`

**When:** Panel opens and `ChaosGetRecordings` returns ≥1 session.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | `● Record` button, `Import HAR` button, recording list |
| **Data displayed** | Table of saved recordings, sorted newest-first |
| **Recording list columns** | Name, Status badge (`completed` / `truncated` / `interrupted`), Entry count, Size, Duration, Date |
| **Selection** | Click row → `recording.reviewing`, Checkbox → multi-select for compare/delete |
| **Toolbar** | Record (always), Export (1 selected), Compare (2 selected), Delete (≥1 selected), Import (always) |
| **Context menu** | Right-click row → Rename, Export as HAR, Export as JSONL, Set as Baseline, Delete |
| **Keyboard** | `R` → Record, `I` → Import, `↑↓` → navigate list, `Enter` → open selected, `Delete` → delete selected, `E` → export selected, `C` → compare (when 2 selected) |
| **Search** | Filter input above list — filters by name, tags, date. `Ctrl+F` focuses filter. |
| **Sorting** | Click column header to sort. Default: date descending. |
| **Transitions** | Click Record → `recording.starting`, Select 1 + Enter → `recording.reviewing`, Select 1 + E → `recording.exporting`, Select 2 + C → `recording.comparing`, Select ≥1 + Delete → `recording.deleting`, Click Import → `recording.importing` |
| **Error states** | SignalR disconnected → Record button disabled. List loads from last-known cache (stale indicator shown). |

**Recording list row detail:**

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☐  onelake-baseline-2026-07-28          completed  847   18 MB  5:12│
│    Tags: baseline, onelake    FLT v2026.07.15    hemant@microsoft…  │
├──────────────────────────────────────────────────────────────────────┤
│ ☐  dag-after-fix-2026-07-28             completed  792   16 MB  4:58│
│    Tags: dag-v2, after-fix    FLT v2026.07.15    hemant@microsoft…  │
├──────────────────────────────────────────────────────────────────────┤
│ ☐  stress-test-overnight                truncated  50000 100MB  8:42│
│    ▸ Truncated: entry limit reached                                  │
└──────────────────────────────────────────────────────────────────────┘
```

---

### 2.3 `recording.starting`

**When:** User clicked Record and the `ChaosStartRecording` invocation is in-flight.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | Recording config dialog (if first time) OR spinner overlay on Record button |
| **Config dialog fields** | Name (auto-generated: `rec-{YYYY-MM-DD}-{HHmmss}`, editable), Filter section (httpClientName dropdown, URL pattern, methods checkboxes, status code range), Limits section (max entries: 50000, max size: 100 MB — both editable), Body capture toggles (include request body, include response body, preview max bytes: 4096) |
| **Config dialog actions** | `Start` (primary), `Cancel` (secondary) |
| **Config keyboard** | `Enter` → Start, `Escape` → Cancel, `Tab` → cycle fields |
| **Spinner state** | After clicking Start: button shows spinner, all fields disabled, "Initializing recording..." text |
| **Duration** | Typically < 200ms (SignalR invoke round-trip) |
| **Transitions** | Success → `recording.active`, Failure → back to `recording.idle` with toast error |
| **Error states** | `"Recording name is required"` → inline validation on name field, `"Invalid URL filter pattern"` → inline on pattern field, `"Cannot create recording file"` → toast with disk error detail, SignalR timeout (>5s) → toast "Failed to start recording. FLT may be unresponsive." |
| **Auto-stop previous** | If a recording is already active, the dialog shows a warning: "Recording '{name}' is active. Starting a new recording will stop it." Proceed/Cancel buttons. |

---

### 2.4 `recording.active`

**When:** `RecordingStarted` event received. Recording is capturing traffic.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | `■ Stop` button (danger/red), live counter, elapsed timer, size indicator, live preview list |
| **Recording indicator** | **Global `● REC` badge** in the top bar (visible across ALL panels, not just Recording sub-view). Red pulsing dot + "REC" + elapsed time. Clicking it navigates to Recording panel. |
| **Live counter** | Entry count (increments per `RecordingEntry` event). Format: `847 entries` |
| **Elapsed timer** | `mm:ss` format, ticks every second. Shows `05:12` not `00:05:12` (under 1 hour). |
| **Size indicator** | Current size / max size. Format: `18.2 / 100 MB`. Progress bar under the counter. |
| **Live preview list** | Last 20 entries in a compact table (method, URL truncated, status code, duration). New entries slide in at top with a subtle fade animation. Renders at max 5 fps (throttled per signalr-protocol.md §2.3). |
| **Filter badge** | If recording has a filter, show badge: "Filtered: OneLakeRestClient, GET+PUT only" |
| **Toolbar** | Stop (primary), Pause disabled (v2 — not in MVP), all other buttons disabled |
| **Keyboard** | `S` or `Escape` → Stop recording, `K` → Kill switch (stops ALL chaos + recording) |
| **Transitions** | Click Stop → `recording.stopping`, Size/entry limit → `recording.stopping` (auto), FLT exit → `recording.stopping` (auto), Click Record again → confirm dialog then `recording.stopping` → `recording.starting` |
| **Error states** | FLT disconnect → badge changes to `● REC (disconnected)` amber, recording continues server-side. Reconnect resumes live counter. Write channel full (10K buffer) → entries dropped, UI shows "⚠ Buffer overflow — some entries may be lost" |

**Live preview row:**

```
┌─────────────────────────────────────────────────────────────┐
│ 10:31:05  PUT  onelake.dfs.fabric.../Tables/mytable/...  201  145ms │
│ 10:31:04  GET  api.fabric.../v1/workspaces/...           200  230ms │
│ 10:31:03  PUT  onelake.dfs.fabric.../Tables/mytable/...  201  132ms │
│ 10:31:02  GET  api.fabric.../v1/lakehouses/...           200  89ms  │
│   ⋯ 843 more entries                                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 2.5 `recording.active.overflow`

**When:** Recording reaches ≥80% of any configured limit (entries, size, or duration if configured).

| Aspect | Detail |
|--------|--------|
| **Inherits from** | `recording.active` (all controls identical) |
| **Visual changes** | Size/counter indicator turns amber. Progress bar turns amber. Warning banner: "Recording approaching limit — {N}% of max {entries|size}. Recording will auto-stop at limit." |
| **Thresholds** | 80% → amber warning, 95% → red warning + more urgent text: "Recording will stop in ~{estimate}" |
| **Keyboard** | Same as `recording.active` |
| **Transitions** | 100% of any limit → `recording.stopping` (auto-stop, reason: `size_limit` or `entry_limit`), User stops → `recording.stopping` |
| **Notification** | If user is on a different panel when overflow triggers, the global `● REC` badge pulses amber and shows a system notification (if permitted): "Recording 'name' approaching size limit." |

---

### 2.6 `recording.stopping`

**When:** Stop triggered (user, auto-stop, or FLT exit). `ChaosStopRecording` invocation is in-flight.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | Stop button disabled with spinner, "Stopping recording... flushing {N} pending entries" |
| **Duration** | Typically < 500ms. Large recordings with deep write buffers may take 1–2 seconds. |
| **Live preview** | Frozen — no new entries rendered. Last known state preserved. |
| **Global badge** | `● REC` badge changes to `● STOPPING...` |
| **Transitions** | `RecordingStopped` event received → `recording.saved` |
| **Error states** | Flush timeout (>10s) → force-stop, status `interrupted`, toast: "Recording force-stopped. Some entries may be missing." |
| **FLT crash during flush** | Status → `interrupted`. Whatever was flushed to JSONL is preserved. |

---

### 2.7 `recording.saved`

**When:** `RecordingStopped` event received with final session metadata.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | Summary card with quick actions |
| **Summary card** | Recording name (editable — click to rename), Status badge, Entry count, Total size, Duration, Start/stop timestamps, Filter applied (if any), Stop reason (`user` / `size_limit` / `entry_limit` / `flt_exit` / `disk_full`) |
| **Quick actions** | `Browse Entries` → `recording.reviewing`, `Export as HAR` → `recording.exporting`, `Compare with...` → recording picker then `recording.comparing`, `Back to List` → `recording.idle` |
| **Auto-transition** | None — stays until user acts. (Unlike a toast, this is a deliberate review moment.) |
| **Truncation notice** | If status is `truncated`: amber banner explaining why — "Recording stopped: {reason}. {N} entries captured before limit." |
| **Interruption notice** | If status is `interrupted`: red banner — "Recording interrupted: FLT process exited. {N} entries recovered." |
| **Keyboard** | `B` → Browse, `E` → Export, `C` → Compare, `Escape` → Back to list |
| **Global badge** | `● REC` badge disappears. |

---

### 2.8 `recording.reviewing`

**When:** User opens a saved recording from the list or from the saved summary.

| Aspect | Detail |
|--------|--------|
| **Layout** | Two-pane: left = entry list (scrollable, virtualized), right = detail panel (collapsed until entry selected) |
| **Entry list columns** | # (sequence), Time (relative to recording start: `+00:01.234`), Method, URL (truncated), Status (color-coded), Duration (ms), Client name |
| **Entry list features** | Virtual scroll (handles 50K entries), column sorting, text filter (URL, method, status code), status code filter chips (2xx / 3xx / 4xx / 5xx) |
| **Timeline scrubber** | Horizontal bar above the entry list — visual representation of all entries over time. Click/drag to scroll to that time region. Density shown as bar height. Color = status code distribution. |
| **Metadata panel** | Collapsible header above the list showing session name, date, entry count, duration, filter, tags, FLT version, git SHA |
| **Toolbar** | `Back` (to list), `Export` (HAR), `Compare`, `Delete`, `Set as Baseline` |
| **Keyboard** | `↑↓` → navigate entries, `Enter` → open detail, `Escape` → back to list, `F` or `Ctrl+F` → focus filter, `/` → focus search, `T` → toggle timeline, `[` / `]` → prev/next entry in detail view |
| **Chaos rule badges** | Entries that matched a chaos rule show a small `◆ chaos` badge with the rule name on hover |
| **Transitions** | Click entry → `recording.reviewing.detail` (right pane opens), Back → `recording.idle`, Export → `recording.exporting`, Delete → `recording.deleting` |
| **Error states** | JSONL file missing → "Recording data file not found. The .jsonl file may have been deleted." with option to delete the orphaned metadata. Corrupt entry → skipped with inline marker: "⚠ Entry #{N} unreadable (corrupt JSONL line)" |

**Entry list with timeline scrubber:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ onelake-baseline-2026-07-28  ·  847 entries  ·  5:12  ·  18.2 MB   │
│ Tags: baseline, onelake  ·  FLT v2026.07.15  ·  hemant@microsoft…  │
├─────────────────────────────────────────────────────────────────────┤
│ ▁▂▃▅▇▅▃▂▁▂▃▅▇█▇▅▃▂▁▂▃▅▇▅▃▁  Timeline: 00:00 ─────────────── 05:12│
│                    ▲ scrubber position                               │
├─────┬──────┬──────────────────────────────────────┬──────┬──────────┤
│  #  │ Time │ Request                              │ Code │ Duration │
├─────┼──────┼──────────────────────────────────────┼──────┼──────────┤
│   1 │+0:01 │ PUT onelake.dfs.fabric.../Tables/... │  201 │   145 ms │
│   2 │+0:01 │ GET api.fabric.../v1/workspaces/...  │  200 │   230 ms │
│   3 │+0:02 │ PUT onelake.dfs.fabric.../Tables/... │  201 │   132 ms │
│   4 │+0:02 │ PUT onelake.dfs.fabric.../Tables/... │  429 │    45 ms │
│     │      │ ◆ "Rate limit test" rule matched     │      │          │
│  ⋯  │      │                                      │      │          │
│ 847 │+5:12 │ GET api.fabric.../v1/lakehouses/...  │  200 │    89 ms │
└─────┴──────┴──────────────────────────────────────┴──────┴──────────┘
```

---

### 2.9 `recording.reviewing.detail`

**When:** User clicks an entry in the reviewing list.

| Aspect | Detail |
|--------|--------|
| **Layout** | Right pane expands (split view). Left pane narrows to show entry list with active row highlighted. |
| **Tabs** | `Headers`, `Request Body`, `Response Body`, `Timing`, `Raw` |
| **Headers tab** | Two sections: Request headers (table: name/value) and Response headers (table: name/value). General info at top: method, full URL (not truncated), status code + text, HTTP version, httpClientName, correlationId. |
| **Request Body tab** | Body preview (up to `bodyPreviewMaxBytes`). Syntax-highlighted if JSON. Size displayed. If body is `null`: "No request body" or "Binary content — body not captured." |
| **Response Body tab** | Body preview. JSON auto-formatted. If truncated: "Showing first 4 KB of {size} response." |
| **Timing tab** | Duration bar visualization. Only `total` available from DelegatingHandler (no sub-timing decomposition). Shows: started at, completed at, total duration. If recording has multiple entries to same endpoint, shows sparkline of all durations with this entry highlighted. |
| **Raw tab** | Raw JSONL line for this entry (JSON-formatted). Includes `_edog` extension fields. Copy button. |
| **Copy actions** | Copy as cURL, Copy URL, Copy headers, Copy body, Copy full entry JSON |
| **Chaos indicator** | If `_edog.chaosRulesMatched` is non-empty: amber banner "Chaos rules active: {rule names}. Response may be mutated." |
| **Keyboard** | `[` / `]` → prev/next entry, `Escape` → close detail (back to `recording.reviewing`), `1-5` → switch tabs, `Ctrl+C` → copy focused content |
| **Transitions** | Close detail → `recording.reviewing`, Navigate to other entry → stays in `recording.reviewing.detail` |

---

### 2.10 `recording.exporting`

**When:** User triggers export on a completed recording.

| Aspect | Detail |
|--------|--------|
| **Trigger** | Export button in toolbar, context menu, or saved summary quick action |
| **Format options** | HAR 1.2 (default, importable in Chrome DevTools), JSONL (raw, EDOG-native) |
| **Visible controls** | Modal or inline spinner: "Exporting as HAR 1.2... {progress}%" |
| **Progress** | For >1000 entries, show percentage based on entries processed. Below 1000: indeterminate spinner. |
| **SignalR call** | `ChaosExportRecording(sessionId, 'har')` — returns `ExportResult` with content string |
| **Duration** | <1s for small recordings, 1–3s for 10K entries (per performance budget) |
| **Transitions** | Success → `recording.export.complete`, Failure → back to previous state with toast |
| **Error states** | `"Recording not found"` → toast error, `"Cannot export active recording"` → toast "Stop the recording first", `"Recording file is corrupted"` → toast with partial recovery count, SignalR timeout → toast "Export timed out. Try again or export as JSONL (faster)." |
| **Keyboard** | `Escape` → cancel export (if still in-flight) |

---

### 2.11 `recording.export.complete`

**When:** `ExportResult` received with `success: true`.

| Aspect | Detail |
|--------|--------|
| **Behavior** | Browser download triggered immediately via `Blob` + `URL.createObjectURL` + `<a>` click. |
| **Filename** | `{recording-name}.har` for HAR, `{recording-name}.jsonl` for JSONL |
| **Toast** | Success toast: "Exported '{name}' as HAR 1.2 ({size}). Download started." |
| **Duration** | Momentary — auto-dismissed toast (5 seconds) |
| **Transitions** | Auto-returns to previous state (reviewing or idle) |
| **Large file handling** | For >50 MB exports: warning before starting "This export is large ({estimate}). Continue?" |

---

### 2.12 `recording.comparing`

**When:** User selects two recordings and clicks Compare, or clicks "Compare with..." from a recording's context.

| Aspect | Detail |
|--------|--------|
| **Selection UX** | If initiated from list with 2 checkboxes: both recordings already selected. If initiated from single recording context menu: shows a picker to choose the second recording. The picker labels them "A (before)" and "B (after)". User can swap A/B. |
| **Visible controls** | Spinner: "Computing diff... analyzing {N} + {M} entries" |
| **SignalR call** | `POST /api/recordings/diff { recordingIdA, recordingIdB }` (REST, not SignalR — diff is computed on-demand) |
| **Duration** | O(A + B), typically < 2 seconds for 10K + 10K entries |
| **Transitions** | Success → `recording.comparing.results`, Failure → back to previous state with toast |
| **Error states** | Either recording not found → toast error, Either recording still active → toast "Stop recording '{name}' before comparing", Empty result (no endpoints) → proceed to results with "No HTTP traffic in either recording" message |
| **Keyboard** | `Escape` → cancel |

---

### 2.13 `recording.comparing.results`

**When:** Diff computation complete.

| Aspect | Detail |
|--------|--------|
| **Layout** | Header: "A: {name-A} vs B: {name-B}" with swap button (↔). Summary bar. Two-column diff table. |
| **Summary bar** | Chips: `+{N} added` (green), `−{N} removed` (red), `~{N} changed` (amber), `={N} unchanged` (grey). Total call delta. Average latency delta. |
| **Diff table columns** | Endpoint (signature), Status (`added`/`removed`/`changed`/`same`), Calls Δ, Latency Δ (avg), Error Δ |
| **Row colors** | `added` → green-left-border, `removed` → red-left-border + strikethrough, `changed` → amber-left-border, `same` → no border (grey text) |
| **Row expansion** | Click any row → expands to show: per-status-code breakdown for A and B, latency percentile comparison (P50/P95/P99), sample entries from each recording (first 3 matches) |
| **Filters** | Filter chips to show only added/removed/changed/all. "Hide unchanged" toggle (default: on). |
| **Significance markers** | `▲▲` for statistically significant latency changes (per C05 §OB-02 thresholds). `▲` for volume changes >20%. |
| **Toolbar** | `Back`, `Export Diff` (as JSON), `Swap A↔B`, `New Comparison` |
| **Keyboard** | `↑↓` → navigate rows, `Enter` → expand/collapse row, `A` → toggle show all, `Escape` → back to list, `X` → swap A/B |
| **Transitions** | Back → `recording.idle`, New Comparison → `recording.comparing` (picker), Swap → re-renders with A/B swapped (no re-computation — just flips the sign on deltas) |
| **Edge cases** | Comparing a recording with itself → all endpoints show `same`, all deltas zero. Very different recordings (no common endpoints) → UI shows warning: "These recordings share no common endpoints. Consider comparing recordings from similar operations." |

**Diff table:**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ A: "Before DAG fix" (847 entries)  vs  B: "After DAG fix" (792 entries)  ↔  │
├──────────────────────────────────────────────────────────────────────────────┤
│ +2 added  −1 removed  ~5 changed  =18 unchanged  │  −55 calls  −12ms avg   │
├──────────────────────────────────────────────────┬────────┬────────┬────────┤
│ Endpoint                                         │ Calls Δ│ Lat. Δ │ Err. Δ │
├──────────────────────────────────────────────────┼────────┼────────┼────────┤
│ ● PUT onelake/.../Tables/{path}          changed │ −25 ▼  │−46ms▲▲│  −2 ▼  │
│ ✕ GET .../lakehouses/{guid}              removed │ −12 ✕  │   —    │   —    │
│ + POST .../semanticModels                added   │  +3 ▲  │   —    │   —    │
│ ~ GET .../ListDirs                       changed │  +1    │  −2ms  │   0    │
│ ⋯ 18 unchanged endpoints (hidden)                │        │        │        │
└──────────────────────────────────────────────────┴────────┴────────┴────────┘
```

---

### 2.14 `recording.deleting`

**When:** User triggers delete on one or more recordings.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | Confirmation dialog: "Delete {N} recording(s)? This removes the JSONL data files permanently." |
| **Dialog content** | List of recording names being deleted. Warning if any recording is set as a baseline: "'{name}' is the active baseline. Deleting it will disable regression detection." |
| **Actions** | `Delete` (danger button), `Cancel` |
| **REST call** | `DELETE /api/recordings/{id}` per recording |
| **Transitions** | Confirm → removes files, refreshes list → `recording.idle` (or `recording.idle.empty` if all deleted), Cancel → back to `recording.idle` |
| **Keyboard** | `Enter` → confirm delete, `Escape` → cancel |
| **Error states** | File already missing → silent success (idempotent), Disk permission error → toast with detail |

---

### 2.15 `recording.importing`

**When:** User clicks Import HAR.

| Aspect | Detail |
|--------|--------|
| **Visible controls** | File picker dialog (accepts `.har`, `.json`, `.jsonl`) |
| **Validation on select** | Parse file, validate structure. HAR: check `log.version` and `log.entries`. JSONL: check first line is valid `RecordingEntry`. |
| **Import preview** | After validation: "Import '{filename}': {N} entries, {size}. Name: [editable field, default=filename]" |
| **Import actions** | `Import` (primary), `Cancel` |
| **Processing** | HAR → convert to EDOG JSONL format + generate `.meta.json`. JSONL → copy directly + generate `.meta.json`. |
| **Imported session metadata** | `status: "completed"`, `metadata.importedFrom: "har"`, `metadata.originalFilename: "..."` |
| **Transitions** | Success → `recording.idle` with new recording highlighted + toast "Imported '{name}' ({N} entries)", Cancel → back to previous state |
| **Error states** | Invalid file format → "Not a valid HAR/JSONL file. Expected HAR 1.2 format or EDOG JSONL.", File too large (>200 MB) → "File exceeds 200 MB import limit.", Parse errors → "Imported with warnings: {N} of {total} entries could not be parsed." |
| **Keyboard** | `Escape` → cancel |

---

## 3. Global Recording Indicator

The recording indicator is visible **across all panels** whenever a recording is active. This follows the Safari Web Inspector model — a persistent red dot that you can't miss.

| Aspect | Detail |
|--------|--------|
| **Location** | Top bar, right side, next to connection status indicators |
| **Idle (no recording)** | Not visible — no indicator rendered |
| **Active** | Red pulsing circle `●` + `REC` + elapsed time (`05:12`). CSS animation: `opacity` pulse 1s ease-in-out infinite, between `1.0` and `0.6`. |
| **Active + overflow** | Amber pulsing circle `●` + `REC` + elapsed time + `⚠` icon |
| **Stopping** | Grey circle `●` + `STOPPING...` (no pulse) |
| **Click behavior** | Navigates to the Recording & Playback sub-view. If currently in another panel, switches to Chaos Panel → Recording tab. |
| **Tooltip** | "Recording: '{name}' — {entryCount} entries, {size}. Click to view." |
| **CSS** | `--rec-indicator-active: oklch(0.65 0.25 25)` (red), `--rec-indicator-overflow: oklch(0.75 0.18 85)` (amber) |

---

## 4. Auto-Stop Configuration

Recordings auto-stop when any configured limit is reached. Defaults are designed for typical FLT dev sessions (30 min DAG execution ≈ 10K entries ≈ 20 MB).

| Limit | Default | Configurable Range | Stop Reason |
|-------|---------|-------------------|-------------|
| Max entries | 50,000 | 100 – 500,000 | `entry_limit` |
| Max size | 100 MB | 1 MB – 500 MB | `size_limit` |
| Max duration | None (unlimited) | 1 min – 24 hours | `duration_limit` |
| Disk full | N/A (system) | N/A | `disk_full` |

**Behavior on limit:**
1. `RecordingStopped` event fires with the corresponding `reason`.
2. Session status set to `truncated` with `truncationReason` in metadata.
3. UI shows amber/red warning (see `recording.active.overflow`).
4. If user is on another panel, system notification (if permitted) + global badge change.

**Configuration location:** Set per-recording in the config dialog (`recording.starting`). Defaults pulled from `edog-config.json`:

```jsonc
{
  "recording": {
    "defaults": {
      "maxEntries": 50000,
      "maxSizeMB": 100,
      "maxDurationSeconds": null,
      "includeRequestBody": true,
      "includeResponseBody": true,
      "bodyPreviewMaxBytes": 4096
    }
  }
}
```

---

## 5. Naming Convention

| Aspect | Detail |
|--------|--------|
| **Auto-generated name** | `rec-{YYYY-MM-DD}-{HHmmss}` using local time. Example: `rec-2026-07-28-103005` |
| **Rename** | Available in recording list (double-click name, or context menu → Rename), in `recording.saved` summary, and in `recording.reviewing` header. Inline editing — click name, it becomes an input, `Enter` to save, `Escape` to cancel. |
| **Allowed characters** | Alphanumeric, hyphens, underscores, dots, spaces. Max 100 characters. |
| **Validation** | No empty names. No duplicate names (append `-2`, `-3` if collision). No path separators (`/`, `\`). |
| **SessionId** | Derived from name: `rec-{date}-{sanitized-name}`. Immutable after creation (renaming only changes display name in `.meta.json`, not file paths). |

---

## 6. Storage

### 6.1 On-Disk Layout

```
.edog/recordings/
├── rec-2026-07-28-onelake-baseline.jsonl       ← Entry data (one JSON per line)
├── rec-2026-07-28-onelake-baseline.meta.json   ← Session metadata
├── rec-2026-07-28-dag-after-fix.jsonl
├── rec-2026-07-28-dag-after-fix.meta.json
└── index.json                                  ← Quick listing of all recordings
```

### 6.2 File Descriptions

| File | Purpose | Size | Created |
|------|---------|------|---------|
| `{sessionId}.jsonl` | Line-delimited recording entries. Append-only during recording. | Up to `maxSizeMB` | On `ChaosStartRecording` |
| `{sessionId}.meta.json` | Session metadata (name, status, timestamps, filter, tags, counts). Small, read frequently. | < 4 KB | On `ChaosStartRecording`, finalized on stop |
| `index.json` | Array of session IDs + names + status for fast listing without reading every `.meta.json`. | < 50 KB | Updated on every start/stop/delete/rename |

### 6.3 Retention Policy

| Policy | Default | Configurable |
|--------|---------|-------------|
| Max recordings kept | 50 | 10 – 500 |
| Max total disk usage | 2 GB | 100 MB – 10 GB |
| Auto-cleanup trigger | On new recording start | — |
| Cleanup strategy | Delete oldest non-baseline recordings first | — |
| Baseline protection | Recordings marked as baseline are never auto-deleted | — |

When a new recording would exceed limits, the oldest non-baseline recordings are deleted (oldest first) until enough space is freed. The user is not prompted — cleanup is silent, matching Chrome DevTools' behavior with network recording.

Configurable in `edog-config.json`:

```jsonc
{
  "recording": {
    "retention": {
      "maxRecordings": 50,
      "maxTotalSizeMB": 2048,
      "protectBaselines": true
    }
  }
}
```

---

## 7. Import

### 7.1 Supported Formats

| Format | Extension | Detection |
|--------|-----------|-----------|
| HAR 1.2 | `.har`, `.json` | Presence of `log.version` and `log.entries` array |
| EDOG JSONL | `.jsonl` | First line parses as valid `RecordingEntry` with `sequenceId` field |

### 7.2 HAR → EDOG Conversion

| HAR Field | EDOG Field | Notes |
|-----------|-----------|-------|
| `entry.startedDateTime` | `startedDateTime` | Parsed as ISO 8601 |
| `entry.time` | `durationMs` | Total round-trip |
| `entry.request.method` | `method` | Verbatim |
| `entry.request.url` | `url` | Verbatim (no redaction on import) |
| `entry.request.httpVersion` | `httpVersion` | Strip `"HTTP/"` prefix if present |
| `entry.request.headers[]` | `requestHeaders` | `[{name,value}]` → `{name: value}` dict |
| `entry.request.bodySize` | `requestBodySize` | `-1` if not present |
| `entry.request.postData.text` | `requestBodyPreview` | Truncated to `bodyPreviewMaxBytes` |
| `entry.response.status` | `statusCode` | Integer |
| `entry.response.statusText` | `statusText` | Verbatim |
| `entry.response.headers[]` | `responseHeaders` | Array → dict |
| `entry.response.content.text` | `responseBodyPreview` | Truncated to `bodyPreviewMaxBytes` |
| `entry.response.content.size` | `responseBodySize` | `-1` if not present |
| N/A | `httpClientName` | Set to `"imported"` |
| N/A | `correlationId` | Extract from headers if present, else `null` |
| N/A | `_edog` | `{ "imported": true, "originalFormat": "har" }` |

### 7.3 Import Limitations

- Imported recordings cannot be used as mock data sources (C06 AD-02) unless they contain full response bodies.
- HAR files from browser DevTools will have more timing detail than EDOG can produce — sub-timings are preserved in `_edog.originalTimings` for display but not used in diff/regression analysis.
- No deduplication — importing the same HAR twice creates two recordings.

---

## 8. Keyboard Shortcut Summary

| Shortcut | Context | Action |
|----------|---------|--------|
| `R` | Idle / Empty | Open Record config dialog |
| `I` | Idle / Empty | Open Import file picker |
| `S` | Active recording | Stop recording |
| `Escape` | Active recording | Stop recording |
| `Escape` | Any dialog/detail | Close/cancel/back |
| `↑` / `↓` | Recording list | Navigate rows |
| `Enter` | Recording list | Open selected recording |
| `Delete` | Recording list (selection) | Delete selected recording(s) |
| `E` | Recording list (1 selected) | Export selected recording |
| `C` | Recording list (2 selected) | Compare selected recordings |
| `Ctrl+F` / `F` | Reviewing entries | Focus search/filter |
| `/` | Reviewing entries | Focus search |
| `[` / `]` | Detail view | Previous / next entry |
| `1`–`5` | Detail view | Switch tabs (Headers, Req Body, Res Body, Timing, Raw) |
| `T` | Reviewing entries | Toggle timeline scrubber |
| `A` | Comparing results | Toggle show all / changed only |
| `X` | Comparing results | Swap A ↔ B |
| `K` | Any (global) | Kill switch — stops all chaos rules AND recording |

---

## 9. Error State Summary

| Error | Source | User Impact | Recovery |
|-------|--------|-------------|----------|
| SignalR disconnected | Network / FLT crash | Record button disabled, stale list | Auto-reconnect; recording continues server-side |
| Disk full | OS | Recording auto-stops (`disk_full`) | Free disk space, start new recording |
| Write channel overflow | High traffic + slow disk | Entries dropped | Warning badge; entries lost are noted in metadata |
| JSONL corrupt | Crash during write | Partial recording | Skip bad lines; count in export/review |
| Recording file missing | Manual deletion | Cannot review/export | Delete orphaned metadata |
| Export timeout | Very large recording | Export fails | Retry, or export as JSONL (no conversion overhead) |
| Name collision | Duplicate name | Rejected | Auto-suffix `-2`, `-3`, etc. |
| Filter regex invalid | Bad user input | Recording not started | Inline validation in config dialog |
| Import parse failure | Malformed HAR | Partial import | Report count of skipped entries, import what's valid |
| Max recordings exceeded | Retention policy | Oldest deleted silently | Increase limit or manually manage |

---

## 10. Data Flow Summary

```
User clicks Record          SignalR            FLT Process
─────────────────           ───────            ───────────
Config dialog → Start  ──►  ChaosStartRecording(config)
                       ◄──  RecordingResult { success, sessionId }
                       ◄──  RecordingStarted broadcast event
                                                │
                            ... traffic flows ...│ TryAppend() per request
                       ◄──  RecordingEntry (10/sec throttle)
                                                │ → background writer → JSONL
UI: counter, timer,                             │
    live preview                                │
                                                │
User clicks Stop       ──►  ChaosStopRecording()
                       ◄──  RecordingResult { session metadata }
                       ◄──  RecordingStopped broadcast event
                                                │ Flush + close file
                                                │ Finalize .meta.json
User clicks Export     ──►  ChaosExportRecording(id, 'har')
                       ◄──  ExportResult { content: HAR JSON string }
                            → Blob → download

User clicks Compare    ──►  POST /api/recordings/diff { A, B }
                       ◄──  DiffResult { endpoints[], summary }
                            → render diff table
```

---

## 11. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2025-07-28 | Staff UX Engineer | Initial state matrix — 15 states defined |
