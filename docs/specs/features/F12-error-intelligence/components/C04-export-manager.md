# C04 — Export Manager

> **Feature:** F12 Error Intelligence · **Phase:** P1
> **Modifies:** `src/frontend/js/main.js` — `exportLogs()` (L1014–1041), `handleKeydown()` (L456–490), `bindEventListeners()` (L406–410)
> **Dependencies:** `state.js` FilterIndex, RingBuffer
> **Owner:** Pixel

---

## 1. Overview

Replace the current JSON-only `exportLogs()` with a format-aware export system supporting JSON, CSV, and Plain Text. Exports only filtered entries (via FilterIndex), shows a success toast with count, and provides a keyboard shortcut. The current implementation (L1014–1041) dumps internal state (stats, filter config, telemetry) into the export — the upgrade exports clean log data only.

---

## 2. Scenarios

### EXP-01: Format Selection UI

**Description:** User clicks Export button and sees format options before download begins.

**Source:** `main.js` L406–410 (export button binding), L1014 (`exportLogs`)

**Mechanism:**
```
On export button click OR Ctrl+Shift+E:
  entries = getFilteredEntries()
  if entries.length === 0:
    show toast("No entries match current filters", type=warning, 3s)
    return
  estimatedSize = estimateExportSize(entries, lastUsedFormat)
  if estimatedSize > 10MB:
    if !confirm("Export is ~{sizeMB}MB. Continue?"):
      return
  show inline dropdown below export button with options:
    - JSON  (default, or last-used from sessionStorage)
    - CSV
    - Plain Text
  on selection: generateAndDownload(entries, format)
```

**UI:** Inline dropdown anchored to export button (not a modal dialog). Three options with format icons. Dropdown dismisses on selection or outside click. Last-used format persisted in `sessionStorage` key `edog-export-format`.

**Edge cases:**
- If dropdown is already open, second click closes it
- Dropdown positions above button if near bottom of viewport

**Priority:** P1

---

### EXP-02: Filtered Entry Collection

**Description:** Export always uses FilterIndex to collect only entries matching current filters.

**Source:** `state.js` L67–121 (FilterIndex), L171–182 (`filteredLogs` getter)

**Mechanism:**
```
getFilteredEntries():
  fi = this.state.filterIndex
  entries = []
  for i = 0 to fi.length - 1:
    seq = fi.seqAt(i)
    entry = this.state.logBuffer.getBySeq(seq)
    if entry: entries.push(entry)
  return entries
```

**Technical note:** This reuses the same iteration pattern as the existing `filteredLogs` getter (state.js L173–179). We iterate FilterIndex rather than materializing `this.state.filteredLogs` to avoid creating an intermediate array that the getter would also create. For large filter sets this is identical; the FilterIndex is already O(n) and pre-sorted.

**Edge cases:**
- FilterIndex is empty (no entries pass filter) — handled in EXP-01 (toast warning)
- Entries evicted from RingBuffer between FilterIndex build and export — `getBySeq` returns `undefined`, skipped silently
- If no filters active, FilterIndex contains all entries in buffer (up to 10K capacity)

**Interactions:** Uses the same FilterIndex that `renderer.js` uses for virtual scroll. No rebuild needed — reads current state.

**Priority:** P1

---

### EXP-03: JSON Format

**Description:** Clean JSON export — log entries only, no internal state.

**Source:** New code in `main.js` replacing L1017–1027

**Mechanism:**
```
generateJSON(entries):
  output = {
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries: entries.map(e => ({
      timestamp: e.timestamp,
      level: e.level,
      component: e.component || '',
      message: e.message,
      customData: e.customData || null
    }))
  }
  return JSON.stringify(output, null, 2)
```

**Key change from current:** Current export (L1017–1027) includes `stats`, `filters`, `telemetry` — internal debugging state that leaks implementation details. New format exports only the log entries themselves with a lightweight metadata header.

**MIME type:** `application/json`

**Edge cases:**
- `customData` may contain circular references — wrap `JSON.stringify` in try/catch, fall back to `"[serialization error]"` per-entry
- Entries with `undefined` fields get sensible defaults (empty string, null)

**Priority:** P1

---

### EXP-04: CSV Format (RFC 4180)

**Description:** Comma-separated export with proper quoting and escaping.

**Source:** New code in `main.js`

**Mechanism:**
```
generateCSV(entries):
  header = "timestamp,level,component,message,customData"
  rows = [header]
  for entry in entries:
    rows.push(csvRow([
      entry.timestamp,
      entry.level,
      entry.component || '',
      entry.message,
      flattenCustomData(entry.customData)
    ]))
  return rows.join('\r\n') + '\r\n'

csvRow(fields):
  return fields.map(f => csvField(String(f))).join(',')

csvField(value):
  if value contains comma, quote, newline, or CR:
    return '"' + value.replace(/"/g, '""') + '"'
  return value

flattenCustomData(obj):
  if obj == null: return ''
  if typeof obj === 'string': return obj
  try: return JSON.stringify(obj)
  catch: return '[serialization error]'
```

**Columns:** `timestamp`, `level`, `component`, `message`, `customData`

**RFC 4180 compliance:**
- CRLF line endings
- Fields containing commas, double-quotes, or newlines are quoted
- Double-quotes within quoted fields are escaped as `""`
- Header row included

**MIME type:** `text/csv`

**Edge cases:**
- Log messages containing newlines — properly quoted per RFC 4180
- Log messages containing commas or double-quotes — escaped
- `customData` is an object — flattened to JSON string in the cell
- Empty `customData` → empty field (not "null" or "undefined")

**Performance:** String concatenation with array join. For 50K entries with average 200-char messages: ~10MB output, generation should be <500ms. No DOM involvement.

**Priority:** P1

---

### EXP-05: Plain Text Format

**Description:** Human-readable log format, one line per entry.

**Source:** New code in `main.js`

**Mechanism:**
```
generateText(entries):
  lines = []
  for entry in entries:
    level = (entry.level || 'INFO').toUpperCase().padEnd(7)
    component = entry.component ? '[' + entry.component + '] ' : ''
    lines.push(`[${entry.timestamp}] ${level} ${component}${entry.message}`)
  return lines.join('\n') + '\n'
```

**Format:** `[2024-01-15T10:23:45.123Z] ERROR   [SparkClient] MLV_SPARK_SESSION_ACQUISITION_FAILED: Session timed out`

**MIME type:** `text/plain`

**Edge cases:**
- Missing timestamp → use `[no-timestamp]`
- Missing level → default to `INFO`
- Multi-line messages — kept as-is (no escaping), subsequent lines won't have the prefix. This matches traditional log file behavior.

**Priority:** P1

---

### EXP-06: File Download with Entry Count in Filename

**Description:** Downloaded filename includes entry count and format extension.

**Source:** `main.js` L1033–1040 (current download mechanism)

**Mechanism:**
```
downloadFile(content, format, entryCount):
  mimeTypes = { json: 'application/json', csv: 'text/csv', txt: 'text/plain' }
  extensions = { json: '.json', csv: '.csv', txt: '.txt' }

  filename = `edog-logs-${entryCount}-entries${extensions[format]}`

  blob = new Blob([content], { type: mimeTypes[format] })
  url = URL.createObjectURL(blob)
  a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
```

**Filename examples:**
- `edog-logs-1247-entries.json`
- `edog-logs-50000-entries.csv`
- `edog-logs-3-entries.txt`

**Revert mechanism:** Same `<a>` click download pattern as current implementation (L1033–1040). If blob creation fails, catch and show error toast.

**Priority:** P1

---

### EXP-07: Success Toast

**Description:** Brief toast notification confirming export completion.

**Source:** New toast utility in `main.js` (no existing toast system)

**Mechanism:**
```
showExportToast(count, format):
  formatLabels = { json: 'JSON', csv: 'CSV', txt: 'Plain Text' }
  message = `Exported ${count.toLocaleString()} entries as ${formatLabels[format]}`

  toast = document.createElement('div')
  toast.className = 'export-toast'
  toast.textContent = message
  document.body.appendChild(toast)

  // Trigger enter animation on next frame
  requestAnimationFrame(() => toast.classList.add('visible'))

  setTimeout(() => {
    toast.classList.remove('visible')
    toast.addEventListener('transitionend', () => toast.remove(), { once: true })
  }, 3000)
```

**CSS (in logs.css):**
```css
.export-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 8px 16px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-accent);
  border-radius: 4px;
  font-size: 12px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.2s, transform 0.2s;
  z-index: 1000;
  pointer-events: none;
}
.export-toast.visible {
  opacity: 1;
  transform: translateY(0);
}
```

**Edge cases:**
- Multiple rapid exports — each toast stacks? No: remove any existing `.export-toast` before creating new one.
- Toast should not interfere with other UI (pointer-events: none).

**Priority:** P1

---

### EXP-08: Error Handling

**Description:** Graceful handling of export failures and empty filter results.

**Mechanism:**
```
exportLogs():
  try:
    entries = getFilteredEntries()
    if entries.length === 0:
      showExportToast('No entries match current filters', 'warning')
      return

    // ... format selection, size check, generation ...

    content = generateContent(entries, format)
    downloadFile(content, format, entries.length)
    showExportToast(entries.length, format)

  catch (err):
    console.error('[export] Failed:', err)
    showExportToast('Export failed — check console for details', 'error')
```

**Toast variants:**
| Scenario | Message | Style |
|----------|---------|-------|
| Success | "Exported 1,247 entries as CSV" | Default (accent border) |
| No entries | "No entries match current filters" | Warning (amber border) |
| Failure | "Export failed — check console for details" | Error (red border) |

**Priority:** P1

---

### EXP-09: File Size Warning

**Description:** Confirmation prompt when estimated export exceeds 10MB.

**Mechanism:**
```
estimateExportSize(entries, format):
  // Rough estimation based on average entry size
  avgEntryBytes = { json: 250, csv: 150, txt: 120 }
  return entries.length * avgEntryBytes[format]

// In export flow, before generation:
estimated = estimateExportSize(entries, format)
if estimated > 10 * 1024 * 1024:
  sizeMB = (estimated / (1024 * 1024)).toFixed(1)
  if !confirm(`Export will be approximately ${sizeMB}MB. Continue?`):
    return
```

**Note:** Uses native `confirm()` — consistent with the project's no-framework approach. Estimation is conservative (averages may vary, but this prevents accidental multi-hundred-MB exports).

**Edge cases:**
- User cancels confirm → no download, no toast, no side effects
- Estimation is approximate — actual size may differ by 20-30%

**Priority:** P1

---

### EXP-10: Keyboard Shortcut (Ctrl+Shift+E)

**Description:** Keyboard shortcut to trigger the export dropdown.

**Source:** `main.js` L456–490 (`handleKeydown`)

**Mechanism:**
```
// Add to handleKeydown switch block:
case 'KeyE':
  if (e.ctrlKey && e.shiftKey) {
    e.preventDefault()
    this.exportLogs()   // Opens format dropdown
  }
  break
```

**Placement:** Inside existing `handleKeydown` (L456), after the `KeyL` case (L476–481).

**Edge cases:**
- Skipped when focus is in INPUT/SELECT/TEXTAREA (existing guard at L458)
- Does not conflict with browser's Ctrl+Shift+E (Edge DevTools toggle) — `preventDefault()` captures it
- `metaKey` not needed: Ctrl+Shift+E on macOS is not a standard combo

**Revert:** Remove the `case 'KeyE'` block.

**Priority:** P1

---

## 3. Interactions with Other Components

| Component | Interaction | Direction |
|-----------|-------------|-----------|
| **state.js FilterIndex** | Reads `filterIndex.seqAt(i)` and `logBuffer.getBySeq(seq)` to collect filtered entries | C04 → state.js (read-only) |
| **C03 Highlight Engine** | No interaction — export uses raw entry data, not rendered HTML | None |
| **C05 Stream Controller** | Export works regardless of LIVE/PAUSED state — reads current buffer snapshot | Independent |
| **renderer.js** | No interaction — export does not touch DOM rendering | None |

---

## 4. Data Shapes

### Log entry (input to all formatters)
```javascript
{
  timestamp: "2024-01-15T10:23:45.123Z",  // string, ISO 8601
  level: "Error",                          // string: Message|Warning|Error|Verbose
  component: "SparkClient",               // string or undefined
  message: "MLV_SPARK_SESSION_...",        // string
  customData: { ... } | null               // object, string, or null
}
```

### JSON output shape
```javascript
{
  exportedAt: "2024-01-15T10:30:00.000Z",
  entryCount: 1247,
  entries: [ /* clean entry objects as above */ ]
}
```

---

## 5. Performance Target

| Metric | Target | Rationale |
|--------|--------|-----------|
| CSV generation (50K entries) | <500ms | String array join is O(n), no DOM |
| JSON generation (50K entries) | <1s | `JSON.stringify` with pretty-print |
| Text generation (50K entries) | <300ms | Simplest format, template literals |
| Blob creation | <100ms | Browser-native, single string input |

No Web Worker needed — these are single-pass string operations that won't block the UI thread for perceptible duration.

---

## 6. Revert Mechanism

Restore `exportLogs()` at L1014–1041 to its current implementation. Remove the `case 'KeyE'` block from `handleKeydown`. Remove `.export-toast` CSS. Remove `edog-export-format` from sessionStorage. Total: one function replacement, one switch case removal, one CSS block removal.

---

## 7. What This Spec Does NOT Cover

- Export dialog as a full modal (overkill — inline dropdown is sufficient)
- Bookmark export integration (future: `exportBookmarksJSON()` at L358 is a separate feature)
- Telemetry export (current export includes telemetry — intentionally dropped for clean output)
- Streaming/chunked export for very large files (V2 if needed)
- Copy-to-clipboard as alternative to file download (V2)
