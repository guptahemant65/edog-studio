# Export Manager — State Matrix

> **Feature:** F12 — Error Intelligence
> **Component:** `ExportManager` (C04)
> **States:** 16
> **Author:** Pixel (Frontend)
> **Status:** SPEC — READY FOR REVIEW
> **Date:** 2025-07-28
> **Parent:** `LogViewerApp` class, inline dropdown anchored to `#export-btn`
> **Children:** None (leaf component). Produces file download side-effect.
> **Source:** `src/frontend/js/main.js` (`exportLogs`, `handleKeydown`, `bindEventListeners`)
> **Depends On:** `../components/C04-export-manager.md`, `../architecture.md` §7.5, `../research/p0-foundation.md`

---

## 1. State Inventory

| # | State | Description |
|---|-------|-------------|
| S01 | `export.idle` | No dropdown visible. Export button ready in toolbar. |
| S02 | `export.dropdown.opening` | Dropdown enter animation (fade + slide). |
| S03 | `export.dropdown.open.default` | Dropdown visible with last-used (or default JSON) format pre-selected. |
| S04 | `export.dropdown.open.format-json` | JSON format explicitly selected. |
| S05 | `export.dropdown.open.format-csv` | CSV format explicitly selected. |
| S06 | `export.dropdown.open.format-text` | Plain Text format explicitly selected. |
| S07 | `export.dropdown.closing` | Dropdown exit animation (fade-out). |
| S08 | `export.size-warning` | Native `confirm()` dialog shown for exports estimated >10 MB. |
| S09 | `export.generating` | Content generation in progress (string building from FilterIndex). |
| S10 | `export.downloading` | Blob created, browser download triggered via `<a>` click. |
| S11 | `export.complete` | Toast shown: "Exported N entries as Format". |
| S12 | `export.error.empty-data` | No entries match current filters. Warning toast. |
| S13 | `export.error.generation-failed` | `JSON.stringify` or CSV builder threw. Error toast. |
| S14 | `export.error.download-failed` | Blob creation or `<a>` click download failed. Error toast. |
| S15 | `export.error.serialization` | Per-entry serialization error (circular reference in `customData`). |
| S16 | `export.disconnected` | Overlay — FLT disconnected during export. No log data to export. |

---

## 2. State Transition Diagram

```
                        ┌──────────────────────────────────────────────────────────────────┐
                        │              FORMAT STATES (one active while dropdown open)       │
                        │                                                                  │
                        │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
                        │   │ format-json  │  │  format-csv  │  │  format-text │           │
                        │   │    (S04)     │  │    (S05)     │  │    (S06)     │           │
                        │   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
                        │          │                 │                 │                    │
                        │          │◄── radio btn ───┤◄── radio btn ───┤                    │
                        │          │─── selection ──►│─── selection ──►│                    │
                        │                                                                  │
                        │   Any format ──[select format]──► Any other format                │
                        └──────────────────────────────────────────────────────────────────┘
                                        │ (active alongside dropdown.open)
                                        │
  ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
  │                                  PRIMARY LIFECYCLE                                             │
  │                                                                                                │
  │  ┌────────┐ click export /  ┌──────────────┐           ┌───────────────────┐                   │
  │  │  idle  │─Ctrl+Shift+E──►│   dropdown    │──────────►│  dropdown.open    │                   │
  │  │ (S01)  │                │   .opening    │  anim     │    .default       │                   │
  │  └────┬───┘                │    (S02)      │  done     │     (S03)         │                   │
  │       ▲                    └───────────────┘           └────────┬──────────┘                   │
  │       │                                                        │                              │
  │       │                         ┌──────────────────────────────┤                              │
  │       │                         │                              │                              │
  │       │                    outside click /                select format                        │
  │       │                    Escape / 2nd click              (radio btn)                         │
  │       │                         │                              │                              │
  │       │                         ▼                              ▼                              │
  │       │                    ┌──────────────┐           entries.length === 0?                    │
  │       │◄───────────────────│   dropdown   │              │            │                        │
  │       │    anim done       │   .closing   │            yes           no                        │
  │       │                    │    (S07)     │              │            │                        │
  │       │                    └──────────────┘              ▼            ▼                        │
  │       │                         ▲                  ┌──────────┐  estimated > 10MB?             │
  │       │                         │                  │  error.   │    │          │               │
  │       │                         │                  │ empty-data│  yes         no               │
  │       │                         │                  │  (S12)    │    │          │               │
  │       │                         │                  └──────────┘    ▼          │               │
  │       │                         │                           ┌──────────┐     │               │
  │       │                         │                           │  size-   │     │               │
  │       │                         │◄─── user cancels ─────────│ warning  │     │               │
  │       │                         │                           │  (S08)   │     │               │
  │       │                         │                           └────┬─────┘     │               │
  │       │                         │                                │ confirm   │               │
  │       │                         │                                ▼           ▼               │
  │       │                         │                           ┌───────────────────┐             │
  │       │                         │                           │    generating     │             │
  │       │                         │                           │      (S09)        │             │
  │       │                         │                           └────────┬──────────┘             │
  │       │                         │                              ┌────┴────┐                    │
  │       │                         │                            ok        error                   │
  │       │                         │                              │         │                    │
  │       │                         │                              ▼         ▼                    │
  │       │                         │                     ┌─────────────┐ ┌────────────────┐      │
  │       │                         │                     │ downloading │ │ error.gen-fail │      │
  │       │                         │                     │   (S10)     │ │    (S13)       │      │
  │       │                         │                     └──────┬──────┘ └────────────────┘      │
  │       │                         │                        ┌───┴───┐                            │
  │       │                         │                      ok       error                          │
  │       │                         │                        │         │                           │
  │       │                         │                        ▼         ▼                           │
  │       │                         │                  ┌──────────┐ ┌────────────────────┐        │
  │       │◄────── toast auto ──────┤◄─── toast auto ──│ complete │ │ error.download-fail│        │
  │       │        dismiss          │      dismiss     │  (S11)   │ │      (S14)         │        │
  │       │                         │                  └──────────┘ └────────────────────┘        │
  │                                                                                                │
  └────────────────────────────────────────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
  │                              OVERLAY STATE (independent layer)                                 │
  │                                                                                                │
  │   ┌────────────────────┐                                                                       │
  │   │   disconnected     │   Can activate at any time. Suppresses export trigger —               │
  │   │      (S16)         │   export button disabled, Ctrl+Shift+E ignored.                       │
  │   └────────────────────┘   ──[FLT disconnects / no logs in buffer]──► active                   │
  │                            ──[FLT reconnects + logs available]──► inactive                     │
  │                                                                                                │
  └────────────────────────────────────────────────────────────────────────────────────────────────┘

  Transitions summary:

  idle ──[click export btn / Ctrl+Shift+E]──────────────► dropdown.opening
  dropdown.opening ──[animation complete ~120ms]────────► dropdown.open.default
  dropdown.open.default ──[select JSON radio]───────────► format-json (stays open)
  dropdown.open.default ──[select CSV radio]────────────► format-csv (stays open)
  dropdown.open.default ──[select Text radio]───────────► format-text (stays open)
  format-* ──[select different format]──────────────────► format-* (switch)
  format-* ──[click "Export" / Enter]───────────────────► check entries → generating / error.empty-data
  dropdown.open.* ──[Escape / outside click / 2nd btn]──► dropdown.closing
  dropdown.closing ──[animation complete ~100ms]────────► idle
  size-warning ──[user confirms]────────────────────────► generating
  size-warning ──[user cancels]─────────────────────────► dropdown.closing
  generating ──[content ready]──────────────────────────► downloading
  generating ──[stringify/builder throws]───────────────► error.generation-failed
  downloading ──[<a>.click() succeeds]──────────────────► complete
  downloading ──[blob/URL error]────────────────────────► error.download-failed
  complete ──[toast auto-dismiss 3s]────────────────────► idle
  error.* ──[toast auto-dismiss 3s]─────────────────────► idle
```

---

## 3. State Definitions

### S01: `export.idle`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Application start; toast auto-dismiss (3s) from `complete` or any `error.*` state; dropdown close animation completes. |
| **Exit conditions** | User clicks `#export-btn`; user presses `Ctrl+Shift+E`; programmatic trigger from test harness. |
| **Visual description** | Export button in toolbar shows download icon (`↓` or inline SVG). Button uses `var(--text-secondary)` color, `var(--bg-surface)` background. On hover: `var(--bg-hover)` background, `var(--text-primary)` icon. No dropdown visible. No toast visible. Toolbar layout unchanged. |
| **Keyboard shortcuts** | `Ctrl+Shift+E` — open export dropdown. Only active when focus is not in INPUT/SELECT/TEXTAREA (existing guard in `handleKeydown` L458). |
| **Data requirements** | None. Button availability depends on whether `state.logBuffer` has entries (button disabled if buffer empty and no FilterIndex entries). |
| **Transitions** | `idle` → `dropdown.opening` on click or `Ctrl+Shift+E`; `idle` stays if `disconnected` overlay is active (button disabled). |
| **Error recovery** | N/A — quiescent state. If button binding failed during init, button is inert; console error logged at init time. |

---

### S02: `export.dropdown.opening`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks `#export-btn` or presses `Ctrl+Shift+E` while in `idle` state. |
| **Exit conditions** | CSS transition completes (~120ms). |
| **Visual description** | Dropdown element created and appended below `#export-btn` (or above if near viewport bottom). Initial CSS: `opacity: 0; transform: translateY(-4px)`. Transition to `opacity: 1; transform: translateY(0)` over 120ms ease-out. Dropdown contains: format radio group (JSON / CSV / Text), "Export" action button. Export button in toolbar shows active/pressed state: `var(--bg-active)` background. |
| **Keyboard shortcuts** | None during animation. Focus moves to dropdown on animation complete. |
| **Data requirements** | `sessionStorage.getItem('edog-export-format')` — last-used format to pre-select. Falls back to `'json'` if absent. |
| **Transitions** | `opening` → `dropdown.open.default` on `transitionend`. |
| **Error recovery** | If CSS transition never fires (e.g., `prefers-reduced-motion: reduce`), use `setTimeout(120)` fallback to force transition to `open.default`. |

---

### S03: `export.dropdown.open.default`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Opening animation completes. Last-used format (or JSON default) is pre-selected in the radio group. |
| **Exit conditions** | User selects a specific format radio button; user clicks outside dropdown; user presses Escape; user clicks export button again (toggle). |
| **Visual description** | Dropdown panel: `var(--bg-elevated)` background, `1px solid var(--border-default)` border, `border-radius: 4px`, `box-shadow: 0 4px 12px oklch(0 0 0 / 0.15)`. Width: 200px. Contains: three radio-style options (JSON, CSV, Plain Text) — each as a row with format name and small description. Pre-selected format has `var(--bg-active)` background and `var(--text-accent)` left border (2px). "Export" button at bottom: `var(--bg-accent)` background, `var(--text-on-accent)` text. Focus ring visible on pre-selected radio item. |
| **Keyboard shortcuts** | `↑` / `↓` — navigate format options. `Enter` — confirm selection and trigger export. `Escape` — close dropdown. `Tab` — move focus between format options and Export button. |
| **Data requirements** | `state.filterIndex.length` — count of entries that will be exported (displayed as "N entries" hint in dropdown). Last-used format from `sessionStorage`. |
| **Transitions** | `default` → `format-json` / `format-csv` / `format-text` on radio selection; `default` → `dropdown.closing` on Escape / outside click / toggle click. If user clicks "Export" with default selection: `default` → entry check → `generating` or `error.empty-data`. |
| **Error recovery** | If `sessionStorage` access throws (private browsing edge case), silently default to JSON. |

---

### S04: `export.dropdown.open.format-json`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks or arrow-keys to JSON radio option in dropdown. |
| **Exit conditions** | User selects different format; user clicks "Export" button; dropdown dismissed. |
| **Visual description** | JSON row highlighted: `var(--bg-active)` background, `var(--text-accent)` left border. Row shows "JSON" label and subtitle "Structured, with metadata header". Other format rows show `var(--bg-elevated)` background, `var(--text-secondary)` text. Radio indicator: filled circle for JSON, empty circles for others. Entry count hint: "N entries as JSON (~X KB)". |
| **Keyboard shortcuts** | `↑` / `↓` — switch format. `Enter` — trigger export as JSON. `Escape` — close. |
| **Data requirements** | `state.filterIndex.length` for entry count. `estimateExportSize(entries, 'json')` for size hint (~250 bytes/entry average). |
| **Transitions** | `format-json` → `format-csv` on select CSV; `format-json` → `format-text` on select Text; `format-json` → entry check on "Export" click / Enter. Persists `'json'` to `sessionStorage` key `edog-export-format`. |
| **Error recovery** | N/A — selection state, no failure modes. |

---

### S05: `export.dropdown.open.format-csv`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks or arrow-keys to CSV radio option in dropdown. |
| **Exit conditions** | User selects different format; user clicks "Export" button; dropdown dismissed. |
| **Visual description** | CSV row highlighted: `var(--bg-active)` background, `var(--text-accent)` left border. Row shows "CSV" label and subtitle "Spreadsheet-compatible, RFC 4180". Entry count hint: "N entries as CSV (~X KB)" (~150 bytes/entry average). |
| **Keyboard shortcuts** | `↑` / `↓` — switch format. `Enter` — trigger export as CSV. `Escape` — close. |
| **Data requirements** | `state.filterIndex.length` for entry count. `estimateExportSize(entries, 'csv')` for size hint. |
| **Transitions** | `format-csv` → `format-json` on select JSON; `format-csv` → `format-text` on select Text; `format-csv` → entry check on "Export" click / Enter. Persists `'csv'` to `sessionStorage`. |
| **Error recovery** | N/A — selection state, no failure modes. |

---

### S06: `export.dropdown.open.format-text`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User clicks or arrow-keys to Plain Text radio option in dropdown. |
| **Exit conditions** | User selects different format; user clicks "Export" button; dropdown dismissed. |
| **Visual description** | Plain Text row highlighted: `var(--bg-active)` background, `var(--text-accent)` left border. Row shows "Plain Text" label and subtitle "One line per entry, human-readable". Entry count hint: "N entries as Text (~X KB)" (~120 bytes/entry average). |
| **Keyboard shortcuts** | `↑` / `↓` — switch format. `Enter` — trigger export as Plain Text. `Escape` — close. |
| **Data requirements** | `state.filterIndex.length` for entry count. `estimateExportSize(entries, 'txt')` for size hint. |
| **Transitions** | `format-text` → `format-json` on select JSON; `format-text` → `format-csv` on select CSV; `format-text` → entry check on "Export" click / Enter. Persists `'txt'` to `sessionStorage`. |
| **Error recovery** | N/A — selection state, no failure modes. |

---

### S07: `export.dropdown.closing`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User presses Escape; user clicks outside dropdown; user clicks `#export-btn` while dropdown open (toggle); user cancels size warning; export flow initiated (dropdown dismisses before generation). |
| **Exit conditions** | CSS transition completes (~100ms). |
| **Visual description** | Dropdown animates out: `opacity: 1 → 0`, `transform: translateY(0) → translateY(-4px)` over 100ms ease-in. Export button returns to default styling. Dropdown removed from DOM on `transitionend`. |
| **Keyboard shortcuts** | None during animation. Focus returns to `#export-btn` on completion. |
| **Data requirements** | None. |
| **Transitions** | `closing` → `idle` on animation complete. If export was triggered (not a dismiss), the generation flow proceeds independently after dropdown is closed. |
| **Error recovery** | If `transitionend` never fires, `setTimeout(100)` fallback removes the element and transitions to next state. `prefers-reduced-motion: reduce` — skip animation, remove immediately. |

---

### S08: `export.size-warning`

| Field | Detail |
|-------|--------|
| **Entry conditions** | `estimateExportSize(entries, format) > 10 * 1024 * 1024` (10 MB). Dropdown has already closed. |
| **Exit conditions** | User clicks OK (confirm) or Cancel in native `confirm()` dialog. |
| **Visual description** | Native browser `confirm()` dialog: "Export will be approximately X.X MB. Continue?" The main UI is non-interactive behind the modal confirm dialog. Dropdown is already dismissed. |
| **Keyboard shortcuts** | `Enter` — confirm (browser native). `Escape` — cancel (browser native). |
| **Data requirements** | `estimateExportSize()` result. Estimation uses averages: JSON ~250 B/entry, CSV ~150 B/entry, Text ~120 B/entry. Actual size may differ by 20-30%. |
| **Transitions** | `size-warning` → `generating` on confirm. `size-warning` → `idle` on cancel (no side effects, no toast). |
| **Error recovery** | N/A — native dialog, cannot fail. If estimation function throws, skip the warning and proceed to generation (fail-open for UX). |

---

### S09: `export.generating`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User confirmed export (direct from dropdown if <10 MB, or from size-warning on confirm). Dropdown is dismissed. |
| **Exit conditions** | Content string fully built; or generation throws an error. |
| **Visual description** | Transient state — typically <1s (see performance targets). For large exports (>10K entries), export button shows a subtle pulse animation: `opacity` oscillating `1.0 ↔ 0.6` over 600ms. No blocking overlay. User can interact with the rest of the UI. A status class `.export-generating` is added to `#export-btn`. |
| **Keyboard shortcuts** | `Ctrl+Shift+E` is no-op while generating (prevents double-export). |
| **Data requirements** | `getFilteredEntries()` — iterates `state.filterIndex`, fetches each entry from `state.logBuffer.getBySeq(seq)`. Selected format from previous state. Performance targets: CSV <500ms (50K), JSON <1s (50K), Text <300ms (50K). |
| **Transitions** | `generating` → `downloading` when content string is ready. `generating` → `error.generation-failed` if `JSON.stringify` or CSV builder throws. `generating` → `error.serialization` on per-entry circular reference (caught per-entry, replaced with `"[serialization error]"`, generation continues — only transitions to `error.serialization` if ALL entries fail). |
| **Error recovery** | Entire `generateContent()` wrapped in `try/catch`. On catch: `console.error('[export] Generation failed:', err)`, show error toast, transition to `error.generation-failed`. Per-entry failures (circular refs in `customData`) are caught individually and replaced with `"[serialization error]"` — generation continues. Remove `.export-generating` class on any exit. |

---

### S10: `export.downloading`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Content string successfully generated. `Blob` created, `URL.createObjectURL()` called, ephemeral `<a>` element clicked. |
| **Exit conditions** | Browser initiates download (success); or Blob creation / URL creation throws. |
| **Visual description** | Transient state — typically <100ms. No visible change from `generating` pulse. The `<a>` element is created, clicked, and removed within a single synchronous block. Browser's native download prompt or save-file dialog may appear (browser-dependent, not controlled by app). |
| **Keyboard shortcuts** | None — too brief for user interaction. |
| **Data requirements** | Content string from `generating`. MIME type map: `{ json: 'application/json', csv: 'text/csv', txt: 'text/plain' }`. Filename: `edog-logs-{entryCount}-entries.{ext}` (e.g., `edog-logs-1247-entries.csv`). |
| **Transitions** | `downloading` → `complete` on successful `<a>.click()` (synchronous, no async confirmation from browser). `downloading` → `error.download-failed` if `new Blob()` throws (out-of-memory for huge exports) or `URL.createObjectURL()` fails. |
| **Error recovery** | `try/catch` around Blob creation and `<a>` click. On catch: `console.error('[export] Download failed:', err)`, show error toast. Always call `URL.revokeObjectURL(url)` in `finally` block to prevent memory leak. Remove ephemeral `<a>` from DOM in `finally`. |

---

### S11: `export.complete`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Browser download triggered successfully. |
| **Exit conditions** | Toast auto-dismisses after 3 seconds. |
| **Visual description** | Success toast appears at bottom-right: `position: fixed; bottom: 24px; right: 24px`. Toast has `var(--bg-elevated)` background, `1px solid var(--border-accent)` border (blue/accent), `border-radius: 4px`, `font-size: 12px`. Message: "Exported 1,247 entries as CSV" (count uses `toLocaleString()` for comma formatting). Enter animation: `opacity: 0 → 1`, `translateY(8px) → 0` over 200ms. `pointer-events: none` — toast does not intercept clicks. Any pre-existing `.export-toast` is removed before creating the new one. |
| **Keyboard shortcuts** | None. Toast is non-interactive. |
| **Data requirements** | Entry count (integer). Format label map: `{ json: 'JSON', csv: 'CSV', txt: 'Plain Text' }`. |
| **Transitions** | `complete` → `idle` after 3s auto-dismiss. Toast exit: `opacity: 1 → 0`, `translateY(0) → 8px` over 200ms, then `element.remove()` on `transitionend`. |
| **Error recovery** | If toast creation fails (DOM error), silently catch — the export itself already succeeded. Ensure `transitionend` fallback (`setTimeout(200)`) removes the element if event never fires. |

---

### S12: `export.error.empty-data`

| Field | Detail |
|-------|--------|
| **Entry conditions** | User triggers export but `getFilteredEntries()` returns an empty array (all entries filtered out, or buffer empty). |
| **Exit conditions** | Warning toast auto-dismisses after 3 seconds. |
| **Visual description** | Warning toast at bottom-right. Same layout as success toast but with `1px solid var(--border-warning)` border (amber, `oklch(0.75 0.18 85)`). Message: "No entries match current filters". No file download occurs. Dropdown is already closed. |
| **Keyboard shortcuts** | None. Toast is non-interactive. |
| **Data requirements** | `getFilteredEntries().length === 0`. |
| **Transitions** | `error.empty-data` → `idle` after 3s toast dismiss. |
| **Error recovery** | N/A — this IS the error recovery path. User action: adjust filters, then retry export. |

---

### S13: `export.error.generation-failed`

| Field | Detail |
|-------|--------|
| **Entry conditions** | `generateContent(entries, format)` throws an uncaught exception. Typical causes: `JSON.stringify` on deeply nested object exceeding call stack; CSV builder encountering unexpected data type; out-of-memory on very large string concatenation. |
| **Exit conditions** | Error toast auto-dismisses after 3 seconds. |
| **Visual description** | Error toast at bottom-right. Same layout as success toast but with `1px solid var(--border-error)` border (red, `oklch(0.65 0.25 25)`). Message: "Export failed — check console for details". Full error logged to `console.error('[export] Failed:', err)` with stack trace. |
| **Keyboard shortcuts** | None. Toast is non-interactive. |
| **Data requirements** | Error object from catch block. |
| **Transitions** | `error.generation-failed` → `idle` after 3s toast dismiss. |
| **Error recovery** | Error is caught at the top-level `try/catch` in `exportLogs()`. No partial file is produced. User can retry — the operation is idempotent (reads state snapshot). If repeated failures occur, user should try a simpler format (Text is least likely to fail). Console output provides diagnostic detail. |

---

### S14: `export.error.download-failed`

| Field | Detail |
|-------|--------|
| **Entry conditions** | `new Blob()` constructor throws (e.g., content too large for browser memory) or `URL.createObjectURL()` fails (e.g., browser blob URL limit exceeded — typically 500+ concurrent blob URLs). |
| **Exit conditions** | Error toast auto-dismisses after 3 seconds. |
| **Visual description** | Error toast at bottom-right with red border. Message: "Export failed — check console for details". Same styling as `error.generation-failed`. |
| **Keyboard shortcuts** | None. Toast is non-interactive. |
| **Data requirements** | Error object from catch block. Content string was successfully generated but could not be delivered. |
| **Transitions** | `error.download-failed` → `idle` after 3s toast dismiss. |
| **Error recovery** | `URL.revokeObjectURL()` called in `finally` to prevent blob URL leak even on failure. Ephemeral `<a>` element removed from DOM in `finally`. User can retry. If blob size is the issue, user should apply more restrictive filters to reduce entry count. Browser limits: Chrome supports blobs up to ~500 MB; practical limit is available RAM. |

---

### S15: `export.error.serialization`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Per-entry serialization of `customData` encounters a circular reference or other `JSON.stringify` error. This is a soft error — individual entries get `"[serialization error]"` replacement and generation continues. This state only surfaces as a toast if the user should know some data was degraded. |
| **Exit conditions** | Warning toast auto-dismisses after 3 seconds. Export file was still produced. |
| **Visual description** | Warning toast (amber border) appears AFTER the success toast or in place of it if many entries were affected. Message: "Exported N entries — M entries had serialization warnings". Both the download and the toast occur. The exported file contains `"[serialization error]"` for affected `customData` fields. |
| **Keyboard shortcuts** | None. Toast is non-interactive. |
| **Data requirements** | Count of entries that hit serialization errors (tracked during generation loop). If count > 0, this toast replaces the standard success toast. |
| **Transitions** | `error.serialization` → `idle` after 3s toast dismiss. This state is reached AFTER `downloading` → `complete` — the file was downloaded, but with degraded data. |
| **Error recovery** | Each failing entry's `customData` is replaced with `"[serialization error]"`. The entry's other fields (timestamp, level, component, message) are unaffected. User can inspect the file to find affected entries. Console logs each serialization error with entry index: `console.warn('[export] Entry N: customData serialization failed:', err)`. |

---

### S16: `export.disconnected`

| Field | Detail |
|-------|--------|
| **Entry conditions** | Overlay state — activates when FLT is disconnected AND `state.logBuffer` is empty (no historical data to export). Also activates if the application is in the Disconnected phase with no cached logs. |
| **Exit conditions** | FLT reconnects and logs begin flowing into the buffer; or user navigates to a view with cached log data. |
| **Visual description** | Export button in toolbar is visually disabled: `opacity: 0.4`, `cursor: not-allowed`, `pointer-events: none`. Tooltip on hover (via `title` attribute): "No log data available — connect to FLT to export". No dropdown can be opened. If the buffer has historical entries but FLT is disconnected, export IS still available (this overlay does NOT activate). |
| **Keyboard shortcuts** | `Ctrl+Shift+E` is intercepted but produces no action (early return in handler when buffer is empty). |
| **Data requirements** | `state.logBuffer.length === 0` AND connection status from `state.connected` or equivalent. |
| **Transitions** | Overlay activates: `idle` + `disconnected` — button disabled. Overlay deactivates: `disconnected` removed — button returns to normal `idle` appearance. This overlay is independent of all other states — it can theoretically coexist with any state, but in practice it only matters in `idle` because the dropdown cannot open while disabled. |
| **Error recovery** | N/A — informational overlay. If the user somehow triggers export while disconnected (race condition), `getFilteredEntries()` returns empty → `error.empty-data` handles it. |

---

## 4. Compound States

States in the Export Manager operate on two independent axes:

- **Lifecycle axis** — exactly one of S01–S15 is active at any time (sequential flow)
- **Overlay axis** — S16 (`disconnected`) can independently activate/deactivate

The format states (S04–S06) are sub-states of the dropdown-open state (S03). Exactly one format is always selected while the dropdown is open.

### 4.1 Compound State Compatibility

```
                │ idle │ d.opn│ d.open│fmt-j│fmt-c│fmt-t│d.cls│ sz-w │ gen │ dl  │ comp│ e.em│e.gen│e.dl │e.ser│disco│
                │ S01  │ S02  │ S03   │ S04 │ S05 │ S06 │ S07 │ S08  │ S09 │ S10 │ S11 │ S12 │ S13 │ S14 │ S15 │ S16 │
────────────────┼──────┼──────┼───────┼─────┼─────┼─────┼─────┼──────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤
idle       S01  │  ─   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✓  │
d.opening  S02  │  ✕   │  ─   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
d.open     S03  │  ✕   │  ✕   │   ─   │  ✓* │  ✓* │  ✓* │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
fmt-json   S04  │  ✕   │  ✕   │   ✓*  │  ─  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
fmt-csv    S05  │  ✕   │  ✕   │   ✓*  │  ✕  │  ─  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
fmt-text   S06  │  ✕   │  ✕   │   ✓*  │  ✕  │  ✕  │  ─  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
d.closing  S07  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ─  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
sz-warn    S08  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ─   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
generating S09  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ─  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
download   S10  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ─  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
complete   S11  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ─  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │
e.empty    S12  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ─  │  ✕  │  ✕  │  ✕  │  ✕  │
e.gen      S13  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ─  │  ✕  │  ✕  │  ✕  │
e.dl       S14  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ─  │  ✕  │  ✕  │
e.serial   S15  │  ✕   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ─  │  ✕  │
disconnect S16  │  ✓   │  ✕   │   ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕   │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ✕  │  ─  │
```

`✓*` = sub-state relationship (format is a child of dropdown.open, exactly one always active).

---

## 5. Transition Summary Table

| # | From | To | Trigger | Guard | Side Effects |
|---|------|----|---------|-------|--------------|
| T01 | `idle` | `dropdown.opening` | Click `#export-btn` / `Ctrl+Shift+E` | Buffer not empty, `disconnected` overlay inactive | Create dropdown DOM element |
| T02 | `dropdown.opening` | `dropdown.open.default` | CSS `transitionend` (120ms) | — | Focus first radio option, read `sessionStorage` |
| T03 | `dropdown.open.*` | `format-json` | Click JSON radio / `↑`/`↓` to JSON | — | Persist `'json'` to `sessionStorage` |
| T04 | `dropdown.open.*` | `format-csv` | Click CSV radio / `↑`/`↓` to CSV | — | Persist `'csv'` to `sessionStorage` |
| T05 | `dropdown.open.*` | `format-text` | Click Text radio / `↑`/`↓` to Text | — | Persist `'txt'` to `sessionStorage` |
| T06 | `dropdown.open.*` | `dropdown.closing` | Escape / outside click / toggle click | — | Begin exit animation |
| T07 | `dropdown.closing` | `idle` | CSS `transitionend` (100ms) | — | Remove dropdown from DOM, return focus to `#export-btn` |
| T08 | `format-*` | `error.empty-data` | Click "Export" / Enter | `getFilteredEntries().length === 0` | Show warning toast, close dropdown |
| T09 | `format-*` | `size-warning` | Click "Export" / Enter | Entries exist AND `estimateExportSize() > 10MB` | Close dropdown, show native `confirm()` |
| T10 | `format-*` | `generating` | Click "Export" / Enter | Entries exist AND size ≤ 10MB | Close dropdown, begin generation |
| T11 | `size-warning` | `generating` | User clicks OK in confirm dialog | — | Begin generation |
| T12 | `size-warning` | `idle` | User clicks Cancel in confirm dialog | — | No side effects |
| T13 | `generating` | `downloading` | Content string built successfully | — | Create Blob, create object URL |
| T14 | `generating` | `error.generation-failed` | `generateContent()` throws | — | `console.error()`, show error toast |
| T15 | `downloading` | `complete` | `<a>.click()` triggers browser download | — | Show success toast, `URL.revokeObjectURL()`, remove `<a>` |
| T16 | `downloading` | `error.download-failed` | `new Blob()` or `createObjectURL()` throws | — | `console.error()`, show error toast, cleanup |
| T17 | `generating` | `error.serialization` | ≥1 entry has `customData` circular ref (but generation completes) | — | Export proceeds, toast warns about degraded entries |
| T18 | `complete` | `idle` | Toast auto-dismiss (3s) | — | Remove toast element from DOM |
| T19 | `error.*` | `idle` | Toast auto-dismiss (3s) | — | Remove toast element from DOM |
| T20 | — | `disconnected` | FLT disconnects + buffer empty | `state.logBuffer.length === 0` | Disable export button, set `title` tooltip |
| T21 | `disconnected` | — | FLT reconnects + logs arrive | `state.logBuffer.length > 0` | Re-enable export button, clear tooltip |

---

## 6. Cross-Cutting Concerns

### 6.1 Theme Change

All export UI elements use CSS custom properties (`var(--bg-elevated)`, `var(--text-primary)`, `var(--border-accent)`, etc.) from `variables.css`. Theme changes apply instantly to:
- Export button hover/active states
- Dropdown background, borders, shadows
- Toast background and borders
- No JavaScript intervention required — CSS custom properties cascade automatically.

If a theme change occurs while the dropdown is open, the dropdown re-renders with new colors via CSS variable inheritance. No state transition is triggered.

### 6.2 `prefers-reduced-motion`

When `prefers-reduced-motion: reduce` is active:
- `dropdown.opening` (S02): skip animation, transition directly to `dropdown.open.default`. `transition-duration: 0s`.
- `dropdown.closing` (S07): skip animation, remove dropdown immediately, transition to `idle`.
- Toast enter/exit animations: `transition-duration: 0s`. Toast appears/disappears instantly.
- Export button pulse in `generating` state: disabled, button shows static active style instead.

### 6.3 Rapid Double-Trigger

If user clicks export button or presses `Ctrl+Shift+E` rapidly:
- While dropdown is opening (S02): ignored (button click handler checks for existing dropdown).
- While dropdown is open (S03–S06): treated as toggle — closes dropdown (S07).
- While generating (S09): ignored (`_exporting` flag prevents re-entry).
- While downloading (S10): ignored (same flag).
- While toast is visible (S11–S15): previous toast removed, new export flow starts.

### 6.4 Browser Download Limits

- **Blob size:** Chrome supports blobs up to ~500 MB. For 50K entries at ~250 bytes/entry (JSON), maximum export is ~12.5 MB — well within limits.
- **Blob URL count:** Browsers limit concurrent blob URLs. `URL.revokeObjectURL()` is called immediately after download to prevent accumulation.
- **File save dialog:** Some browsers may show a save dialog, others auto-download to the default directory. The app has no control over this behavior.

### 6.5 Entries Evicted During Export

Between `getFilteredEntries()` and the actual string generation, the `RingBuffer` may evict entries as new logs arrive. Since `getFilteredEntries()` copies entry references at call time, the exported data reflects a snapshot. Entries evicted from the buffer after the snapshot are still included in the export. New entries arriving after the snapshot are not included.

### 6.6 Concurrent Filter Changes

If the user changes filters while an export is in progress (during `generating`), the export uses the entries captured at the start of generation. The new filter state does not affect the current export. This is correct behavior — the export represents a point-in-time snapshot.

---

## 7. Accessibility Notes

- Dropdown is an ARIA `role="menu"` with `role="menuitemradio"` for format options.
- `aria-expanded="true/false"` on `#export-btn` tracks dropdown visibility.
- `aria-checked="true/false"` on each format radio option.
- Focus is trapped within the dropdown while open (Tab cycles through options and Export button).
- Escape key closes the dropdown and returns focus to `#export-btn`.
- Toast has `role="status"` and `aria-live="polite"` for screen reader announcement.
- Export button has `aria-label="Export logs"` when no dropdown is visible.
- When `disconnected` overlay is active, button has `aria-disabled="true"`.
