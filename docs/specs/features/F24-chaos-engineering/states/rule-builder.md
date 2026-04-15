# Rule Builder — State Matrix

> **Author:** Pixel (Frontend Engineer)
> **Status:** SPEC — READY FOR REVIEW
> **Date:** 2025-07-28
> **Depends On:** `engine-design.md` §2 (ChaosRule v2 schema), `signalr-protocol.md` §1.1 (ChaosCreateRule, ChaosUpdateRule)
> **Applies To:** `src/frontend/js/chaos-rule-builder.js`, `src/frontend/css/chaos-rule-builder.css`

---

## Overview

The Rule Builder is the form UI where users create and edit chaos rules. It maps 1:1 to the `ChaosRule` JSON schema from `engine-design.md` §2.1, presenting three sections — **Predicate** (when to fire), **Action** (what to do), **Lifecycle** (limits and duration) — with conditional fields that appear based on user selections.

The builder operates in two modes:
- **Create mode** — fresh form, all fields empty, produces `ChaosCreateRule` SignalR call
- **Edit mode** — pre-populated from existing rule, produces `ChaosUpdateRule` SignalR call (rule must be `draft` or `paused`)

---

## Form Layout

**Single-column, vertically stacked sections.** Not a wizard — all three sections visible simultaneously, scrollable. Rationale: chaos rules are small (5–10 fields), and engineers need to see the full picture while editing predicates that depend on the action type.

```
┌─────────────────────────────────────────────────────┐
│  Rule Builder                          [JSON] [✕]   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌── Identity ────────────────────────────────────┐ │
│  │  Name: [____________________________] 0/120    │ │
│  │  ID:   [____________________________] auto     │ │
│  │  Desc: [____________________________] 0/500    │ │
│  │  Category: [▾ request-surgery      ]           │ │
│  │  Tags: [onelake] [latency] [+]                 │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌── Predicate (when to fire) ────────────────────┐ │
│  │  URL pattern:  [________________________] ◎    │ │
│  │  Method:       [▣GET ▣POST ▣PUT ☐DELETE ☐…]    │ │
│  │  HttpClient:   [▾ DatalakeDirectoryClient ]    │ │
│  │  + Add condition  [▾ Header match]             │ │
│  │  Combinator: ○ AND  ○ OR                       │ │
│  │  Probability:  [━━━━━━━●━━] 0.50  (50%)       │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌── Action (what to do) ─────────────────────────┐ │
│  │  Type: [▾ delay                    ]           │ │
│  │  ┌─ delay config ─────────────────────────┐    │ │
│  │  │  Delay:  [━━━━●━━━━━] 3000ms           │    │ │
│  │  │  Jitter: [━●━━━━━━━━]  500ms           │    │ │
│  │  └────────────────────────────────────────┘    │ │
│  │  Phase: ○ Request  ○ Response  ○ Both          │ │
│  │  Priority: [100] (0=first … 999=last)          │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌── Lifecycle (limits) ──────────────────────────┐ │
│  │  Max firings:  [50    ]  (0 = unlimited)       │ │
│  │  TTL:          [300   ] seconds                │ │
│  │  Rate limit:   [      ] req/sec                │ │
│  │  Expires at:   [                    ] UTC       │ │
│  │  ⚠ At least one limit required to enable       │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌── Preview ─────────────────────────────────────┐ │
│  │  3 of 47 recent requests would match           │ │
│  │  ▸ PUT onelake.dfs.../workspace-a/…  2ms ago   │ │
│  │  ▸ POST onelake.dfs.../workspace-a/… 15ms ago  │ │
│  │  ▸ PUT onelake.dfs.../workspace-b/…  43ms ago  │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  [Start from preset ▾]   [Cancel]   [Save as draft] │
│                                                     │
│  Unsaved changes ●                                  │
└─────────────────────────────────────────────────────┘
```

### JSON Mode Toggle

Top-right `[JSON]` button toggles between the visual form and a raw JSON editor (Monaco-style textarea with syntax highlighting). Changes in either mode sync bidirectionally. Invalid JSON shows a red gutter with parse error. Power users who know the schema can paste a full `ChaosRule` JSON and save directly.

### Preset Dropdown

`[Start from preset ▾]` opens a dropdown listing built-in presets (`preset-onelake-outage`, `preset-spark-capacity`, etc.) and user-saved presets. Selecting a preset pre-fills ALL form fields. The user can modify before saving. Preset-generated rules get `source: "preset"` and prefixed IDs.

### Preview Section

Live-updating panel that replays the current predicate against the last 100 requests from the traffic buffer. Shows match count and the 5 most recent matches. Updates on every predicate change with 300ms debounce. Only visible when the chaos panel has an active SignalR connection (connected phase).

### Undo

`Ctrl+Z` / `Ctrl+Shift+Z` undo/redo within the form. Implemented as a stack of form snapshots (max 50 entries). Each keystroke debounced at 500ms before pushing a snapshot. Undo is form-local — it does not undo saved rules (that is the engine's `ChaosUndeleteRule`).

---

## State Definitions

### Notation

Each state defines:
- **Fields visible** — which form sections/inputs are rendered
- **Fields editable** — which inputs accept user input (vs read-only)
- **Validation** — active validation rules and their error messages
- **Visual** — indicators, highlights, animations
- **Keyboard** — focus, tab order, shortcuts
- **Transitions** — events that move to other states

---

### S01: `builder.empty`

**Description:** Fresh form opened for creating a new rule. No user input yet.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Identity (name, auto-ID, description, category, tags), Predicate (URL, method, httpClient), Action (type dropdown only), Lifecycle (all four limit fields), Preview (empty: "Configure a predicate to see matching traffic") |
| **Fields editable** | All identity fields, all predicate fields, action type dropdown, all lifecycle fields |
| **Validation** | None active — no fields touched yet |
| **Visual** | All fields default/unfocused. `[Save as draft]` button disabled (name required). Dirty indicator hidden. JSON toggle shows `{}` skeleton. |
| **Keyboard** | Focus on Name field. Tab order: Name → ID → Description → Category → Tags → URL pattern → Method checkboxes → HttpClient → Action type → Phase → Priority → Max firings → TTL → Rate limit → Expires at → Cancel → Save. `Esc` = close builder. |
| **Transitions** | Any field input → `builder.dirty`. Preset selected → `builder.preset.applied`. `[JSON]` click → `builder.json`. `[✕]` or `Esc` → closes builder (no confirmation needed, nothing to lose). |

---

### S02: `builder.dirty`

**Description:** User has made at least one change. Unsaved changes indicator visible.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Same as current sub-state (this is an overlay state — `dirty` is always combined with a section-specific state) |
| **Fields editable** | Same as current sub-state |
| **Validation** | Per-field validation active on changed fields (see field-specific states below) |
| **Visual** | `●` dirty dot visible next to "Unsaved changes" at bottom. `[Save as draft]` enabled once `name` is non-empty. If in edit mode, button reads `[Save changes]`. Browser `beforeunload` handler active. |
| **Keyboard** | `Ctrl+S` = save as draft. `Ctrl+Z` = undo last change. `Ctrl+Shift+Z` = redo. |
| **Transitions** | `Ctrl+S` or `[Save as draft]` → `builder.validating`. `Esc` or `[✕]` → `builder.discarding` (if dirty). Undo all changes back to initial → `builder.empty` or `builder.editing`. |

---

### S03: `builder.predicate.url`

**Description:** User is typing or has typed a URL pattern in the URL match field.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | URL pattern input with regex indicator `◎`. Autocomplete dropdown below input showing URL patterns from interceptor audit (e.g., `onelake\.dfs\.fabric\.microsoft\.com`, `api\.fabric\.microsoft\.com/v1`, `wabi-.*\.analysis\.windows\.net`). |
| **Fields editable** | URL pattern input. |
| **Validation** | Real-time regex validation on every keystroke (debounced 200ms). Valid regex → green `◎` icon. Invalid regex → transition to `builder.predicate.url.invalid`. Empty value accepted (field is optional). |
| **Visual** | Input has subtle `oklch(0.85 0.15 145)` green left-border when regex is valid. Character count shown if >50 chars. Autocomplete items highlighted on match. |
| **Keyboard** | `↑`/`↓` navigate autocomplete. `Enter` or `Tab` selects autocomplete item. `Esc` dismisses autocomplete. Typing continues filter. |
| **Autocomplete source** | Populated from traffic buffer URL patterns (deduped, sorted by frequency). Falls back to hardcoded FLT traffic map patterns from `interceptor-audit.md §2` if no live traffic. |
| **Transitions** | Invalid regex → `builder.predicate.url.invalid`. Focus out with valid value → predicate updated, preview refreshes. Autocomplete select → value set, preview refreshes. |

---

### S04: `builder.predicate.url.invalid`

**Description:** URL pattern field contains an invalid regex.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Same as S03. Error message below input: "Invalid regex: [error detail from regex parser]". |
| **Fields editable** | URL pattern input (user continues typing to fix). |
| **Validation** | Regex compilation attempted on each keystroke (200ms debounce). Error message updates with specific regex error (e.g., "Unterminated character class at position 12"). |
| **Visual** | Input border `oklch(0.65 0.25 25)` red. Red `◎` icon. Error text in `oklch(0.65 0.25 25)`. Field shakes once on initial invalid transition (100ms CSS animation). `[Save as draft]` still enabled (URL is optional — save will produce a rule without URL predicate if field is cleared). |
| **Keyboard** | Same as S03. `Ctrl+Z` to undo last keystroke. |
| **Transitions** | User fixes regex → `builder.predicate.url`. User clears field → `builder.dirty` (no URL predicate). |

---

### S05: `builder.predicate.method`

**Description:** User is selecting HTTP methods from the method checkbox group.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Checkbox group: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`. Each is an independent toggle. |
| **Fields editable** | All method checkboxes. |
| **Validation** | No validation — zero methods selected is valid (means "match any method"). |
| **Visual** | Selected methods have filled checkbox `▣` with `oklch(0.7 0.15 250)` blue tint. Unselected methods `☐`. When ≥1 method selected, a summary chip appears: "Methods: GET, POST, PUT". |
| **Keyboard** | `Space` toggles focused checkbox. `←`/`→` move between checkboxes. `Tab` moves to next field group. |
| **Transitions** | Any change → preview refreshes (300ms debounce). Methods feed into predicate as OR-combined conditions: `{ "operator": "or", "conditions": [{ "field": "method", "op": "equals", "value": "GET" }, ...] }`. |

---

### S06: `builder.predicate.headers`

**Description:** User is adding header match conditions.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Dynamic list of header condition rows. Each row: `[Header name ▾] [op ▾] [value ____]  [✕]`. `[+ Add header condition]` button. Header name dropdown includes: `Authorization`, `Content-Type`, `Accept`, `Retry-After`, `x-ms-request-id`, `x-ms-client-request-id`, plus free-text input. Operator dropdown: `equals`, `contains`, `matches`, `exists`, `not_exists`. |
| **Fields editable** | All fields in each row. |
| **Validation** | Header name required if row exists. Value required unless op is `exists`/`not_exists`. If op is `matches`, value is validated as regex (same as S04). Max 8 header conditions. |
| **Visual** | Each row has a subtle separator line. `[✕]` remove button appears on hover/focus. Row count: "2 of 8 max". When op is `exists` or `not_exists`, value field auto-hides with slide animation. |
| **Keyboard** | `Tab` cycles: header name → op → value → remove → next row. `Enter` on `[+ Add]` appends row and focuses new header name. `Delete` on empty row removes it. |
| **Transitions** | Adding/removing/changing rows → predicate updated, preview refreshes. Invalid regex in value → inline error on that row (same as S04 but scoped to the row). |

---

### S07: `builder.predicate.advanced`

**Description:** User has expanded the advanced predicate section.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Collapsed by default behind `[▸ Advanced matching]` toggle. When expanded: Body match (`requestBody` / `responseBody` field selector + operator + value), HttpClient name dropdown (populated from live traffic: `OneLakeRestClient`, `DatalakeDirectoryClient`, `PbiSharedApiClient`, `FabricApiClient`), Phase-specific field warning (if predicate references response-phase fields but action phase is "request"). |
| **Fields editable** | Body match field selector, operator, value. HttpClient dropdown. |
| **Validation** | Body match with op `matches` validates regex. Body match value max 1024 chars (body scanning is capped at 64KB — long patterns are wasteful). HttpClient name validated against known names (warn on unknown, don't block). |
| **Visual** | `[▸ Advanced matching]` → `[▾ Advanced matching]` on expand. Phase mismatch warning: amber `⚠` banner "This predicate references response-phase fields but the action phase is 'request'. These conditions will always evaluate to false." |
| **Keyboard** | `Enter` on toggle expands/collapses. Standard tab order within expanded section. |
| **Transitions** | Phase mismatch detected → warning banner shown (non-blocking). HttpClient selected → predicate updated, preview refreshes. |

---

### S08: `builder.action.selecting`

**Description:** User is choosing an action type from the dropdown.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Action type dropdown open. Items grouped by phase: **Request-phase:** `delay`, `modifyRequestHeader`, `modifyRequestBody`, `rewriteUrl`, `blockRequest`, `redirectRequest`, `methodOverride`. **Response-phase:** `modifyResponseStatus`, `modifyResponseHeader`, `modifyResponseBody`, `delayResponse`, `forgeResponse`, `dropConnection`. **Traffic:** `throttleBandwidth`. **Observability:** `recordTraffic`, `tagRequest`. **Advanced:** `cacheReplay`, `composite`. Each item has a one-line description. |
| **Fields editable** | Dropdown selection only. |
| **Validation** | None — selection is always valid. |
| **Visual** | Dropdown items show: icon + name + short description. Grouped with section headers. Current selection highlighted. Destructive actions (`blockRequest`, `forgeResponse`, `dropConnection`) have `oklch(0.65 0.25 25)` red accent. |
| **Keyboard** | `↑`/`↓` navigate items. `Enter` selects. Type-ahead: typing "del" highlights `delay`. `Esc` closes dropdown without changing. |
| **Transitions** | Selection → opens corresponding action config state (S09–S14). Changing action type clears previous config (with undo support). Auto-sets `phase` field to match action's natural phase. |

**Phase auto-assignment on action select:**

| Action Type | Auto-set Phase |
|-------------|---------------|
| `delay`, `modifyRequestHeader`, `modifyRequestBody`, `rewriteUrl`, `blockRequest`, `redirectRequest`, `methodOverride` | `request` |
| `modifyResponseStatus`, `modifyResponseHeader`, `modifyResponseBody`, `delayResponse`, `dropConnection`, `throttleBandwidth` | `response` |
| `forgeResponse` | `request` (evaluates predicate in request phase, produces response) |
| `recordTraffic` | `both` |
| `tagRequest` | `request` |
| `cacheReplay` | `request` |
| `composite` | `both` |

---

### S09: `builder.action.delay`

**Description:** Configuring a delay action.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | `delayMs` — dual input: slider (range 0–30000) + numeric text input, synchronized. `jitterMs` — same dual input (range 0–5000). Effective range display: "Delay: 2500ms – 3500ms" (calculated as `delayMs ± jitterMs`, clamped to [0, 30000]). |
| **Fields editable** | Both slider and text input for each field. |
| **Validation** | `delayMs` required, must be 0–30000. If >30000, auto-clamp with warning "Engine caps delay at 30s". `jitterMs` must be 0–5000. If `jitterMs > delayMs`, warning "Jitter exceeds base delay — effective delay could be 0ms". |
| **Visual** | Slider track color: `oklch(0.7 0.15 250)` blue fill from 0 to thumb position. Effective range shown as light bar on slider. Text input right-aligned with "ms" suffix. Warning text in `oklch(0.75 0.15 85)` amber. |
| **Keyboard** | `←`/`→` on slider adjusts by 100ms. `Shift+←`/`Shift+→` by 1000ms. `Home`/`End` for min/max. Tab between slider and text input. |
| **Transitions** | Value change → dirty + preview shows "Matching requests will be delayed by ~3000ms". |

---

### S10: `builder.action.block`

**Description:** Configuring a block/blackhole action.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Mode toggle: `○ Return error status` / `○ Simulate timeout`. **Error mode:** `statusCode` dropdown (common: 400, 401, 403, 404, 429, 500, 502, 503, 504 — free-text for other), `body` textarea (optional, JSON or plain text), `headers` key-value list (optional). **Timeout mode:** `timeoutMs` slider+input (range 1000–100000), `errorMessage` text input. |
| **Fields editable** | Mode toggle, then mode-specific fields. |
| **Validation** | Error mode: `statusCode` required, 100–599. Body if present must be valid JSON when Content-Type is `application/json` (warning, not blocking). Timeout mode: `timeoutMs` required, 1000–100000. Warning if `timeoutMs` > 30000: "Exceeds default HttpClient.Timeout (100s) at values >100000." |
| **Visual** | Destructive action warning banner: `⚠ This action blocks requests — the real service will NOT be contacted.` in `oklch(0.65 0.25 25)` red. Mode toggle styled as segmented control. |
| **Keyboard** | `Tab` between mode toggle and config fields. `↑`/`↓` in status code dropdown. |
| **Transitions** | Mode change → hides previous mode fields, shows new ones (slide animation, 150ms). |

---

### S11: `builder.action.modify`

**Description:** Configuring a body/header modification action (covers `modifyRequestHeader`, `modifyResponseHeader`, `modifyRequestBody`, `modifyResponseBody`, `modifyResponseStatus`).

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Varies by selected action type. **Header actions:** `operation` dropdown (`set`, `add`, `remove`), `name` text input with autocomplete (common header names), `value` text input (hidden when operation is `remove`). For `modifyRequestHeader` with `jwtMutation`, additional JWT claim editor appears. **Body actions:** `find` text input (string or regex), `replace` text input (supports `$1` capture group references), `regex` toggle checkbox. **Status action:** `statusCode` dropdown/input. |
| **Fields editable** | All fields for the selected action sub-type. |
| **Validation** | Header name required. Value required for `set`/`add`. `find` required for body actions. If `regex` is checked, `find` is validated as regex. `replace` with `$1` references validated against capture group count in `find`. Status code: 100–599. |
| **Visual** | When `regex` is on, `find` input shows monospace font and regex syntax highlighting. Capture group references in `replace` highlighted in `oklch(0.7 0.15 250)` blue. |
| **Keyboard** | `Tab` between fields. `Ctrl+Space` in header name field triggers autocomplete. |
| **Transitions** | Regex toggle → re-validates `find` field. Operation change in header → shows/hides value field. |

---

### S12: `builder.action.forge`

**Description:** Configuring a full response forge (`forgeResponse`).

| Aspect | Detail |
|--------|--------|
| **Fields visible** | `statusCode` dropdown/input. `contentType` dropdown (`application/json`, `text/plain`, `text/html`, `application/xml` — free text). `body` — large textarea (20 rows) with JSON syntax highlighting when contentType contains "json". `headers` — key-value list editor (same as S06 but for response headers). |
| **Fields editable** | All fields. |
| **Validation** | `statusCode` required, 100–599. `body` optional but if contentType is `application/json`, validate as JSON (warning on invalid, not blocking — the point may be to test bad JSON handling). Body max 64KB. |
| **Visual** | Large body editor dominates the section. JSON validation result shown as green checkmark or red `✕` with parse error location. Line numbers in body textarea. Destructive action banner: `⚠ This action forges a complete response — the real service will NOT be contacted.` |
| **Keyboard** | `Tab` indents in body textarea (2 spaces). `Shift+Tab` dedents. `Ctrl+Shift+F` formats JSON in body. |
| **Transitions** | ContentType change → toggles JSON validation and syntax highlighting. |

---

### S13: `builder.action.composite`

**Description:** Combining multiple actions into one rule.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Ordered list of sub-actions. Each sub-action is a mini action-config card (same fields as S09–S12 but in a compact card layout). `[+ Add action]` button (opens same dropdown as S08, excluding `composite`). Drag handle for reordering. `[✕]` remove button per card. `stopOnError` checkbox: "Stop executing if an action fails". Execution order label: "Sequential (request-phase first, then response-phase)". |
| **Fields editable** | All sub-action configs. Order via drag-and-drop. `stopOnError` toggle. |
| **Validation** | Min 2 actions, max 8. Each sub-action individually validated (same rules as standalone). At least one action must exist. Cannot nest `composite` inside `composite`. Phase auto-set to `both` if sub-actions span both phases. |
| **Visual** | Cards stacked vertically with numbered badges (①, ②, ③…). Drag handle `⠿` on left. Phase indicator per card: blue `REQ` or green `RES` chip. Order line connecting cards. |
| **Keyboard** | `Tab` cycles between cards. Within a card, standard field tab order. `Alt+↑`/`Alt+↓` reorder cards. `Delete` on focused card removes it (with undo). |
| **Transitions** | Adding card → new card appears, focuses its type dropdown (S08 scoped to card). Removing last card → warning "Composite action requires at least 2 actions". |

---

### S14: `builder.action.traffic`

**Description:** Configuring traffic control and observability actions (`throttleBandwidth`, `recordTraffic`, `tagRequest`, `cacheReplay`, `redirectRequest`, `rewriteUrl`, `methodOverride`).

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Varies by type. **`throttleBandwidth`:** `bytesPerSecond` slider+input (1KB/s – 10MB/s, logarithmic scale). **`recordTraffic`:** `sessionName` text input with autocomplete from existing sessions. **`tagRequest`:** key-value pair list (max 10 tags). **`cacheReplay`:** `mode` toggle (replay/hybrid), `sessionName` dropdown, `missBehavior` toggle (return504/passthrough). **`redirectRequest`:** `targetUrl` text input, `preserveHeaders` checkbox. **`rewriteUrl`:** `find`/`replace` text inputs, `regex` checkbox. **`methodOverride`:** method dropdown (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS). |
| **Fields editable** | All fields for selected type. |
| **Validation** | `throttleBandwidth`: bytesPerSecond > 0. `recordTraffic`: sessionName required, kebab-case. `cacheReplay`: sessionName must reference existing session (warning if not found). `redirectRequest`: targetUrl must be valid URL. `rewriteUrl`: find required, regex validated if checkbox on. `methodOverride`: method must be known HTTP method. |
| **Visual** | `throttleBandwidth` slider uses logarithmic scale with labeled ticks (1KB/s, 10KB/s, 100KB/s, 1MB/s, 10MB/s). `cacheReplay` shows session stats: "Session 'baseline-run' contains 47 entries". |
| **Keyboard** | Standard tab order. Slider keyboard behavior same as S09. |
| **Transitions** | Field changes → dirty + preview updates. |

---

### S15: `builder.lifecycle.maxFirings`

**Description:** User is setting the max fire count.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | `maxFirings` numeric input with stepper buttons (−/+). Help text: "Rule auto-disables after firing this many times. 0 = unlimited." Common presets as chips: `[1] [5] [10] [50] [100] [∞]`. |
| **Fields editable** | Numeric input + presets. |
| **Validation** | Must be integer ≥ 0. If 0 and no other limit set, amber warning: "⚠ At least one limit required before the rule can be enabled." |
| **Visual** | Preset chips highlighted when matching current value. Warning banner if no limits set across all four fields. |
| **Keyboard** | `↑`/`↓` increment/decrement by 1. `Shift+↑`/`Shift+↓` by 10. `Page Up`/`Page Down` by 100. |
| **Transitions** | Value change → revalidate limit requirement. If this is the only limit set, green checkmark "✓ Limit satisfied". |

---

### S16: `builder.lifecycle.duration`

**Description:** User is setting TTL or expiry.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | `ttlSeconds` numeric input with unit selector (`seconds` / `minutes` / `hours`). Quick presets: `[30s] [1m] [5m] [15m] [1h]`. `expiresAt` datetime input (optional, alternative to TTL). Help text: "TTL starts counting when the rule is first enabled. Expires-at is an absolute UTC deadline." |
| **Fields editable** | TTL input + unit selector + presets. Expires-at datetime picker. |
| **Validation** | `ttlSeconds` must be ≥ 0. If both `ttlSeconds` and `expiresAt` set, info note: "Both TTL and absolute expiry set. Absolute expiry takes precedence (per engine spec)." `expiresAt` must be in the future (warn if <1 minute from now). |
| **Visual** | Human-readable duration next to numeric input: "= 5 minutes". Presets styled as pills. If `expiresAt` is in the past, red error text. |
| **Keyboard** | Standard number input. Preset pills selectable with arrow keys + Enter. |
| **Transitions** | Setting a TTL or expiry satisfies the limit requirement → green checkmark if no other limit was set. |

---

### S17: `builder.validating`

**Description:** Form submitted, client-side validation running.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | All fields frozen (read-only). Subtle loading overlay (10% opacity). |
| **Fields editable** | None — all inputs disabled. |
| **Validation** | Full-form validation fires synchronously: (1) `name` non-empty, ≤120 chars. (2) `id` is valid kebab-case (auto-generated from name if blank). (3) At least one predicate condition exists OR user confirms "match all traffic". (4) Action type selected with valid config. (5) All regex fields compile. (6) At least one limit set (warn if not — rule can still be saved as draft without limits). (7) Phase consistency: no response-phase predicate fields if phase is "request". |
| **Visual** | Brief validation spinner (≤100ms for client-side). Fields with errors get red border + inline error message simultaneously (not one-at-a-time). First error field auto-scrolled into view. |
| **Keyboard** | `Esc` cancels validation, returns to editing. |
| **Transitions** | All valid → `builder.saving`. Any error → `builder.validation.error`. |

---

### S18: `builder.validation.error`

**Description:** Client-side validation found errors.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | All fields visible and editable again. Error summary banner at top: "3 issues found" with clickable links to each error. Inline errors on each failing field. |
| **Fields editable** | All fields — user corrects errors. |
| **Validation** | Real-time re-validation on each corrected field. Error clears immediately when fixed. Error count in banner updates live. |
| **Visual** | Error summary banner: `oklch(0.65 0.25 25)` red background, white text. Each error field: red left-border, red error text below. Smooth scroll to first error on entering this state. |
| **Keyboard** | `Tab` cycles through error fields only (skip non-error fields). `Enter` on error summary link jumps to that field. `Ctrl+S` re-attempts save. |
| **Transitions** | All errors fixed → `builder.dirty` (user must click Save again). `Ctrl+S` with errors remaining → re-validate, stay in this state if errors persist. |

---

### S19: `builder.saving`

**Description:** Sending rule to engine via SignalR.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | All fields visible but frozen. `[Save as draft]` button shows spinner and text "Saving…". |
| **Fields editable** | None. |
| **Validation** | Server-side validation happens in the engine. |
| **Visual** | Button spinner animation. Form overlay at 5% opacity. No jank — form doesn't re-render during save. |
| **Keyboard** | `Esc` does NOT cancel (SignalR call is in-flight). All keyboard input ignored. |
| **SignalR call** | Create mode: `hub.invoke("ChaosCreateRule", { rule })`. Edit mode: `hub.invoke("ChaosUpdateRule", { rule })`. Timeout: 5 seconds. |
| **Transitions** | `ChaosRuleResult.success: true` → `builder.saved`. `ChaosRuleResult.success: false` → `builder.save.error`. Network error / timeout → `builder.save.error`. |

---

### S20: `builder.saved`

**Description:** Rule saved successfully.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Success banner: "✓ Rule 'Delay OneLake writes by 3s' saved as draft". Quick actions: `[Enable now]` `[Create another]` `[Close]`. |
| **Fields editable** | None — form is complete. |
| **Validation** | None. |
| **Visual** | Success banner with `oklch(0.85 0.15 145)` green background, slides down from top. `[Enable now]` button prominent (primary style). Dirty indicator cleared. Banner auto-dismisses after 5 seconds unless user interacts. |
| **Keyboard** | `Enter` = `[Enable now]` (default focus). `Esc` = `[Close]`. `N` = `[Create another]`. |
| **Transitions** | `[Enable now]` → calls `ChaosEnableRule(ruleId)` → closes builder, rule appears in Active Rules list. `[Create another]` → `builder.empty` (fresh form). `[Close]` → closes builder panel. Auto-dismiss after 5s → closes builder. |

---

### S21: `builder.save.error`

**Description:** SignalR call failed or returned validation errors.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Error banner at top. If server validation errors: mapped to inline field errors (same as S18). If network error: "Connection error: could not reach the chaos engine. Is FLT running?" with `[Retry]` button. |
| **Fields editable** | All fields (user can fix server validation errors). |
| **Validation** | Server validation errors mapped by `validationErrors[].field` path to form fields. Unknown fields shown in error summary only. |
| **Visual** | Error banner in `oklch(0.65 0.25 25)` red. Network errors show connection icon. `[Retry]` button. Server validation errors show same inline style as S18. |
| **Keyboard** | `Enter` on `[Retry]` re-submits. `Esc` returns to editing. `Tab` cycles error fields. |
| **Transitions** | `[Retry]` → `builder.saving`. User edits field → `builder.dirty` + `builder.validation.error` (if errors remain). Fix all server errors → `builder.dirty`. |

---

### S22: `builder.editing`

**Description:** Editing an existing rule. Form pre-populated from current rule state.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Same as S01 but all fields pre-filled. Additional read-only metadata shown: `State: draft`, `Created: 2 hours ago`, `Fire count: 0`, `Version: 1`. If rule is `active`, form is read-only (see S23). |
| **Fields editable** | All fields EXCEPT `id` (immutable after creation). `source` read-only. `lifecycle.*` fields are engine-managed, read-only. |
| **Validation** | Same as create mode, applied on change. |
| **Visual** | Header reads "Edit Rule" instead of "New Rule". `id` field shown as read-only text (not input). Metadata section collapsed by default, expandable. `[Save changes]` instead of `[Save as draft]`. |
| **Keyboard** | Same tab order as S01. `Ctrl+S` saves changes. `Esc` → `builder.discarding` (if dirty). |
| **Transitions** | Any field change → `builder.dirty` + `builder.editing` (combined). `[Save changes]` → `builder.validating`. `[Delete rule]` → confirm dialog → `ChaosDeleteRule`. `[Clone as new]` → copies all fields into create mode with new ID. |

---

### S23: `builder.editing.readonly`

**Description:** Viewing an active rule. Cannot edit active rules — must pause first.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | All fields shown as read-only text (not input elements). Live metadata: `State: active ●`, `Fire count: 47`, `Last fired: 3s ago` (updates via SignalR push). |
| **Fields editable** | None. |
| **Validation** | None. |
| **Visual** | All fields styled as read-only (muted background). Prominent banner: "This rule is active. Pause it to make changes." `[Pause and edit]` button. `[Clone as new]` button. |
| **Keyboard** | `Tab` cycles through fields (for screen reader accessibility). `Enter` on `[Pause and edit]` → calls `ChaosDisableRule`, transitions to S22. |
| **Transitions** | `[Pause and edit]` → `ChaosDisableRule(ruleId)` → on success → `builder.editing`. `[Clone as new]` → S01 with fields copied, new auto-generated ID. |

---

### S24: `builder.discarding`

**Description:** User attempting to close builder with unsaved changes.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Modal overlay: "You have unsaved changes. Discard?" with `[Discard]` and `[Keep editing]` buttons. Form visible but dimmed behind modal. |
| **Fields editable** | None (modal captures focus). |
| **Validation** | None. |
| **Visual** | Modal centered, `oklch(0.15 0 0 / 0.6)` backdrop. Modal has `oklch(0.75 0.15 85)` amber accent. `[Discard]` is destructive (red). `[Keep editing]` is primary. |
| **Keyboard** | `Esc` = `[Keep editing]` (safe default). `Enter` = `[Keep editing]` (safe default). `Tab` between two buttons. `D` hotkey = `[Discard]` (for speed). |
| **Transitions** | `[Discard]` → closes builder, form state lost. `[Keep editing]` → returns to previous state. |

---

### S25: `builder.json`

**Description:** Raw JSON editor mode.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | Full-width textarea replacing the visual form. Monospace font. Line numbers. JSON content is the complete `ChaosRule` object (excluding engine-managed `lifecycle` fields). Syntax highlighting: strings in green, numbers in blue, keys in default, booleans in purple. |
| **Fields editable** | Entire JSON text. |
| **Validation** | Real-time JSON parse validation (500ms debounce). Schema validation against `chaos-rule-v2.json` (checks required fields, enum values, type correctness). Parse errors shown with line number + column. Schema errors shown as warnings below editor. |
| **Visual** | Red gutter marks on lines with errors. Green gutter on valid JSON. Error panel below editor: "Line 15, Col 3: Expected '}' but found ']'". `[JSON]` toggle button shows as active/pressed. |
| **Keyboard** | Standard text editor keys. `Tab` inserts 2 spaces (not field-cycle). `Ctrl+Shift+F` = format/prettify. `Ctrl+S` = save. `Esc` = back to visual form. `Ctrl+/` = toggle comment (strips for JSON). |
| **Sync behavior** | Switching from JSON to visual: JSON is parsed and mapped to form fields. Invalid JSON blocks switch (error shown: "Fix JSON errors before switching to visual mode"). Switching from visual to JSON: form state serialized to pretty-printed JSON. |
| **Transitions** | `[JSON]` toggle → `builder.dirty` (or previous visual state) with form synced. `Ctrl+S` → `builder.validating` (validates the JSON as if it were the form). |

---

### S26: `builder.preset.applied`

**Description:** A preset was just applied to the form.

| Aspect | Detail |
|--------|--------|
| **Fields visible** | All form fields filled from preset. Info banner: "Loaded preset: OneLake Outage Simulation (3 rules). Modify fields as needed." If preset contains multiple rules, shows list with radio selection: "This preset has 3 rules. Editing rule 1 of 3." |
| **Fields editable** | All fields (user can override preset values). |
| **Validation** | Preset values are pre-validated, but user changes trigger normal validation. |
| **Visual** | Fields that differ from empty/default have subtle `oklch(0.92 0.05 250)` blue background flash on fill (150ms fade). Info banner in `oklch(0.92 0.08 250)` light blue. Preset origin badge next to ID: "from preset: onelake-outage". |
| **Keyboard** | Same as S02. `Ctrl+Z` undoes the entire preset application (single undo step). |
| **Transitions** | Any further edit → `builder.dirty` (preset origin preserved). Save → `source: "preset"` in rule JSON. |

---

## State Transition Diagram

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
              ┌───────────┐   preset    ┌──────────────┐   │
     open ──▸ │  S01      │──────────▸│  S26         │   │
  (create)    │  empty    │           │  preset.     │   │
              └─────┬─────┘           │  applied     │   │
                    │                 └───────┬──────┘   │
                    │ any input               │          │
                    ▼                         ▼          │
              ┌───────────┐◄──────────────────┘          │
              │  S02      │                              │
              │  dirty    │◄─── field-specific states ──▸│
              │           │     (S03–S16 overlay)        │
              └─────┬─────┘                              │
                    │                                    │
       ┌────────────┼────────────────┐                   │
       │ Ctrl+S     │ Esc/close      │ [JSON]            │
       ▼            ▼                ▼                   │
  ┌──────────┐ ┌──────────┐   ┌──────────┐              │
  │  S17     │ │  S24     │   │  S25     │              │
  │validating│ │discarding│   │  json    │──── Ctrl+S ──┘
  └────┬─────┘ └────┬─────┘   └──────────┘
       │            │
  ┌────┴────┐   ┌───┴──────┐
  │         │   │ Keep     │ Discard
  ▼         ▼   │ editing  │──────▸ close
┌──────┐ ┌──────┐ └──────────┘
│ S18  │ │ S19  │
│valid.│ │saving│
│error │ │      │
└──┬───┘ └──┬───┘
   │        │
   │   ┌────┴────┐
   │   │         │
   │   ▼         ▼
   │ ┌──────┐ ┌──────┐
   │ │ S20  │ │ S21  │
   │ │saved │ │save. │
   └▸│      │ │error │
     └──┬───┘ └──┬───┘
        │        │
   ┌────┼────┐   │ Retry
   │    │    │   └──────▸ S19
   ▼    ▼    ▼
 close  S01  enable
        new  rule
```

**Edit mode entry:**

```
  open ──▸ S22 (editing, pre-populated)
  (edit)      │
              ├── rule is draft/paused → fields editable
              └── rule is active → S23 (readonly)
                     │
                     │ [Pause and edit]
                     ▼
                   S22 (editing, now editable)
```

---

## Field Visibility Matrix

Which fields appear for each action type. `●` = visible, `○` = hidden.

| Field | delay | block | modify-header | modify-body | forge | redirect | rewrite-url | drop | throttle | record | tag | cache-replay | composite |
|-------|-------|-------|---------------|-------------|-------|----------|-------------|------|----------|--------|-----|--------------|-----------|
| delayMs + jitterMs | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| statusCode (block) | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| simulateTimeout toggle | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| timeoutMs | ○ | ●¹ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| errorMessage | ○ | ●¹ | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ |
| operation (set/add/remove) | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| header name + value | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| find + replace + regex | ○ | ○ | ○ | ● | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| statusCode (forge) | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| body textarea | ○ | ●² | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| contentType | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| response headers | ○ | ●² | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| targetUrl | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| preserveHeaders | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| method override | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| bytesPerSecond | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ |
| afterBytes | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ |
| sessionName | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ | ● | ○ |
| tags (key-value) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ |
| mode (replay/hybrid) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ |
| missBehavior | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ |
| sub-action list | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● |
| jwtMutation config | ○ | ○ | ●³ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

¹ Only visible when `simulateTimeout` is on.
² Only visible in error-status mode (not timeout mode).
³ Only visible for `modifyRequestHeader` with `transform: "jwt_mutate"`.

---

## Validation Rules — Complete Reference

### Identity Fields

| Field | Rule | Error Message | Severity |
|-------|------|---------------|----------|
| `name` | Required, 1–120 chars | "Rule name is required" / "Name must be 120 characters or fewer ({n}/120)" | Error (blocks save) |
| `id` | Auto-generated from name (kebab-case). If manually entered: `^[a-z0-9][a-z0-9-]{0,63}$` | "ID must be lowercase alphanumeric with hyphens, max 64 chars" | Error |
| `description` | Optional, 0–500 chars | "Description must be 500 characters or fewer ({n}/500)" | Error |
| `category` | Required, must be valid enum | "Select a category" | Error |
| `tags` | Max 20 tags, each max 40 chars. No duplicates. | "Maximum 20 tags" / "Tag must be 40 characters or fewer" | Error |

### Predicate Fields

| Field | Rule | Error Message | Severity |
|-------|------|---------------|----------|
| URL pattern | If non-empty, must compile as .NET-compatible regex | "Invalid regex: {detail}" | Error |
| Method | No validation (empty = any method) | — | — |
| HttpClient name | Warn on unknown names (not in live traffic or hardcoded list) | "Unknown HttpClient name '{name}'. Known clients: OneLakeRestClient, DatalakeDirectoryClient, PbiSharedApiClient, FabricApiClient" | Warning |
| Header name | Required if header row exists | "Header name required" | Error |
| Header value | Required unless op is `exists`/`not_exists` | "Value required for '{op}' operator" | Error |
| Header value (regex) | If op is `matches`/`not_matches`, must compile as regex | "Invalid regex: {detail}" | Error |
| Body match value | Max 1024 chars. If op is `matches`, must compile as regex. | "Body match pattern too long (max 1024 chars)" / "Invalid regex: {detail}" | Error / Error |
| Predicate tree | Max 8 nesting depth. Max 16 children per compound. | "Predicate nesting too deep (max 8 levels)" / "Too many conditions (max 16 per group)" | Error |
| Empty predicate | If no conditions at all, require confirmation | "No predicate conditions — this rule will match ALL traffic. Continue?" | Confirm dialog |
| Phase mismatch | Response-phase predicate field + request-phase action | "Predicate field '{field}' is response-phase but action phase is 'request'. This condition will always be false." | Warning |

### Action Fields

| Field | Rule | Error Message | Severity |
|-------|------|---------------|----------|
| Action type | Required | "Select an action type" | Error |
| `delay.delayMs` | Required, 0–30000. Values >30000 auto-clamped. | "Delay must be 0–30,000ms (engine maximum)" | Error / Auto-clamp with warning |
| `delay.jitterMs` | 0–5000. | "Jitter must be 0–5,000ms" | Error |
| `blockRequest.statusCode` | Required in error mode, 100–599 | "Status code must be 100–599" | Error |
| `blockRequest.timeoutMs` | Required in timeout mode, 1000–100000 | "Timeout must be 1,000–100,000ms" | Error |
| `forgeResponse.statusCode` | Required, 100–599 | "Status code required for forged response" | Error |
| `forgeResponse.body` | If contentType contains "json", validate JSON | "Body is not valid JSON (line {n}): {detail}" | Warning (not blocking) |
| `forgeResponse.body` | Max 65536 chars (64KB) | "Response body exceeds 64KB limit" | Error |
| `modifyBody.find` | Required | "Find pattern required" | Error |
| `modifyBody.find` (regex) | If regex=true, must compile | "Invalid regex: {detail}" | Error |
| `modifyBody.replace` | Capture group refs (`$1`) validated against find groups | "Replace references capture group $2 but find pattern has only 1 group" | Warning |
| `redirectRequest.targetUrl` | Must be valid URL (http/https) | "Invalid target URL" | Error |
| `rewriteUrl.find` | Required | "Find pattern required" | Error |
| `throttle.bytesPerSecond` | Required, > 0 | "Bytes per second must be greater than 0" | Error |
| `composite.actions` | Min 2, max 8. No nested composite. | "Composite actions require 2–8 sub-actions" / "Cannot nest composite actions" | Error |
| `recordTraffic.sessionName` | Required, kebab-case | "Session name required" | Error |
| `methodOverride.method` | Must be valid HTTP method | "Unknown HTTP method" | Error |

### Lifecycle Fields

| Field | Rule | Error Message | Severity |
|-------|------|---------------|----------|
| `maxFirings` | Integer ≥ 0 | "Max firings must be a non-negative integer" | Error |
| `ttlSeconds` | Integer ≥ 0 | "TTL must be a non-negative integer" | Error |
| `maxRatePerSecond` | Number ≥ 0 | "Rate limit must be non-negative" | Error |
| `expiresAt` | Valid ISO 8601 datetime, must be in the future | "Expiry must be in the future" | Warning |
| Limit requirement | At least one of `maxFirings > 0`, `ttlSeconds > 0`, `maxRatePerSecond > 0`, or `expiresAt` set — required for activation, not for saving as draft | "⚠ No limits set. Rule can be saved as draft but cannot be enabled without at least one limit." | Warning (non-blocking for save) |

---

## Keyboard Shortcut Reference

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+S` | Any state (dirty) | Save / submit form |
| `Ctrl+Z` | Any state | Undo last form change |
| `Ctrl+Shift+Z` | Any state | Redo |
| `Ctrl+Shift+K` | Global | Kill switch — disables ALL chaos rules (not builder-specific) |
| `Esc` | Builder open, not dirty | Close builder |
| `Esc` | Builder open, dirty | Open discard confirmation |
| `Esc` | Autocomplete open | Dismiss autocomplete |
| `Esc` | Discard modal open | Keep editing (safe default) |
| `Enter` | Autocomplete open | Select highlighted item |
| `Enter` | Saved state | Enable rule |
| `Tab` | Any state | Cycle forward through fields |
| `Shift+Tab` | Any state | Cycle backward through fields |
| `Space` | Checkbox focused | Toggle checkbox |
| `↑`/`↓` | Dropdown open | Navigate items |
| `↑`/`↓` | Number input focused | Increment/decrement |
| `←`/`→` | Slider focused | Adjust slider by step |
| `Shift+←`/`Shift+→` | Slider focused | Adjust slider by large step |
| `Alt+↑`/`Alt+↓` | Composite sub-action | Reorder actions |
| `Ctrl+Shift+F` | JSON mode / body textarea | Format/prettify JSON |
| `D` | Discard modal | Discard changes |
| `N` | Saved state | Create another rule |

---

## Autocomplete Sources

| Field | Source | Fallback |
|-------|--------|----------|
| URL pattern | Deduped URL patterns from last 100 traffic entries (via SignalR traffic buffer), sorted by frequency | Hardcoded FLT traffic map: `onelake\.dfs\.fabric\.microsoft\.com`, `api\.fabric\.microsoft\.com/v1`, `wabi-.*\.analysis\.windows\.net`, `[a-z]+-onelake\.dfs\.fabric\.microsoft\.com` |
| HttpClient name | Named clients seen in live traffic (from `EdogHttpPipelineHandler._httpClientName`) | Hardcoded: `OneLakeRestClient`, `DatalakeDirectoryClient`, `PbiSharedApiClient`, `FabricApiClient` |
| Header name (request) | Common HTTP request headers + headers seen in traffic | `Authorization`, `Content-Type`, `Accept`, `x-ms-request-id`, `x-ms-client-request-id`, `x-ms-date`, `User-Agent` |
| Header name (response) | Common HTTP response headers + headers seen in traffic | `Content-Type`, `Retry-After`, `x-ms-request-id`, `ETag`, `Cache-Control`, `WWW-Authenticate` |
| Recording session name | Active and completed session names from `ChaosGetRecordingSessions` | Empty (user must type) |
| Tags | Tags used by existing rules (from `ChaosGetAllRules`) | Empty (freeform) |

---

## Form-to-JSON Mapping

How each form section maps to the `ChaosRule` JSON schema (v2):

```
Form Identity Section
├── Name input         → rule.name
├── ID input           → rule.id  (auto-generated if blank)
├── Description input  → rule.description
├── Category dropdown  → rule.category
└── Tags chips         → rule.tags[]

Form Predicate Section
├── URL pattern        → ConditionPredicate { field: "url", op: "matches", value: <input> }
├── Method checkboxes  → CompoundPredicate { operator: "or", conditions: [
│                           { field: "method", op: "equals", value: "GET" }, ...
│                        ]}
├── HttpClient name    → ConditionPredicate { field: "httpClientName", op: "equals", value: <input> }
├── Header conditions  → ConditionPredicate { field: "requestHeader", key: <name>, op: <op>, value: <val> }
├── Body match         → ConditionPredicate { field: "requestBody", op: <op>, value: <input> }
├── Combinator toggle  → Top-level CompoundPredicate.operator ("and" or "or")
├── Probability slider → rule.probability
└── All conditions     → Wrapped in CompoundPredicate { operator: <combinator>, conditions: [...] }
                         If only 1 condition, unwrapped to single ConditionPredicate.

Form Action Section
├── Type dropdown      → rule.action.type
├── Config fields      → rule.action.config  (schema varies by type)
├── Phase radio        → rule.phase
└── Priority input     → rule.priority

Form Lifecycle Section
├── Max firings input  → rule.limits.maxFirings
├── TTL input          → rule.limits.ttlSeconds
├── Rate limit input   → rule.limits.maxRatePerSecond
└── Expires-at input   → rule.limits.expiresAt
```

---

## Implementation Notes

### CSS Requirements
- OKLCH colors per STYLE_GUIDE.md. No hex, no HSL.
- 4px spacing grid. All margins/paddings multiples of 4px.
- Form inputs: 36px height (9 grid units). Slider thumb: 20px diameter.
- Transition animations: 150ms ease-out for field show/hide. No jank.
- Monospace font for regex inputs, JSON editor, code-like fields: `var(--font-mono)`.

### JS Requirements
- Class-based module: `ChaosRuleBuilder` extending base panel component pattern.
- State machine implemented as explicit state variable with `_transition(fromState, toState, event)` method.
- Undo stack: `_undoStack[]` and `_redoStack[]` of serialized form snapshots.
- Debounce: 200ms for regex validation, 300ms for preview refresh, 500ms for undo snapshots.
- SignalR calls via `SignalRManager.invoke()` (existing pattern from Runtime View).
- Preview uses existing traffic buffer from `ChaosTrafficMonitor` (shares `chaos` topic subscription).

### Accessibility
- All form fields have associated `<label>` elements.
- Error messages linked via `aria-describedby`.
- Slider has `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext`.
- Focus management: auto-focus first error field. Return focus to trigger on modal close.
- Keyboard navigation complete — no mouse-only interactions.
- High contrast: all OKLCH colors tested at L≥0.45 against `oklch(0.98 0 0)` background.

---

*Pixel — "A rule builder is a promise: every pixel you see maps to exactly one field in the JSON. No magic, no hidden state, no 'it depends.' The form IS the schema."*
