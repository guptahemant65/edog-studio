# EDOG Studio — Design System

> **Status:** ACTIVE
> **Applies To:** All frontend CSS and JS code
> **Source of Truth:** `src/frontend/css/variables.css`
> **Owners:** Kael Andersen (UX), Mika Tanaka (CSS)
> **Last Updated:** 2026-04-09

---

## Identity

**Light-first. Purple accent. Calm density.**

EDOG Studio is a developer cockpit used 8+ hours/day. The aesthetic is clean, professional, and information-dense — closer to a Bloomberg terminal than a SaaS dashboard. Color is reserved for status signals. Typography does the heavy lifting.

---

## 1. Color Tokens

All colors are defined as CSS custom properties in `variables.css`. **Use tokens, never raw values.**

### Surfaces (Light Default)

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#f4f5f7` | Page background, recessed areas |
| `--surface` | `#ffffff` | Panels, cards, sidebar, topbar |
| `--surface-2` | `#f8f9fb` | Hover states, toolbar, secondary surfaces |
| `--surface-3` | `#ebedf0` | Active states, pressed, tertiary |

### Surfaces (Dark Theme)

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#0c0e14` | Page background |
| `--surface` | `#14171f` | Panels |
| `--surface-2` | `#1c2029` | Hover |
| `--surface-3` | `#282d3a` | Active |

### Borders

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--border` | `rgba(0,0,0,0.06)` | `rgba(255,255,255,0.06)` | Default separators |
| `--border-bright` | `rgba(0,0,0,0.12)` | `rgba(255,255,255,0.10)` | Active/hover borders, button outlines |

### Text

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--text` | `#1a1d23` | `#e4e7ed` | Headings, data values, primary content |
| `--text-dim` | `#5a6070` | `#8a91a3` | Body text, labels, secondary |
| `--text-muted` | `#8e95a5` | `#555d70` | Metadata, timestamps, disabled, tertiary |

### Accent

| Token | Value | Use |
|-------|-------|-----|
| `--accent` | `#6d5cff` (light) / `#8577ff` (dark) | Primary actions, active sidebar, selected items, brand |
| `--accent-dim` | `rgba(109,92,255,0.07)` | Tinted backgrounds (selected row, active tab) |
| `--accent-hover` | `rgba(109,92,255,0.04)` | Subtle hover tint |
| `--accent-glow` | `rgba(109,92,255,0.15)` | Focus ring, glow on active elements |

### Semantic Status Colors

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--status-succeeded` | `#18a058` | `#34d399` | Running, passed, healthy, green dot |
| `--status-failed` | `#e5453b` | `#ff6b6b` | Failed, errors, danger |
| `--status-cancelled` | `#e5940c` | `#f0b429` | Warning, building, amber |
| `--status-pending` | `#8e95a5` | `#555d70` | Waiting, stopped, neutral |

### Log Level Colors

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--level-verbose` | `#8e95a5` | `#555d70` | Verbose log entries |
| `--level-message` | `#2d7ff9` | `#5b9bff` | Info/Message entries |
| `--level-warning` | `#e5940c` | `#f0b429` | Warning entries |
| `--level-error` | `#e5453b` | `#ff6b6b` | Error entries |

### Signal Tint Formula

For tinted backgrounds (badges, row tints, chips), use the signal color at low opacity:

- **Badges:** `rgba(color, 0.08)` background + solid color text
- **Row tints:** `rgba(color, 0.03–0.04)` background
- **Active states:** `rgba(color, 0.06–0.07)` background

---

## 2. Typography

### Font Stacks

| Token | Stack | Use |
|-------|-------|-----|
| `--font-body` | `'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif` | UI chrome: buttons, navigation, section headers, labels |
| `--font-mono` | `'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace` | Data content: logs, IDs, SQL, timestamps, table values, code blocks |

### Type Scale

| Token | Size | Use |
|-------|------|-----|
| `--text-xs` | `10px` | Section headers (uppercase), metadata, timestamps, counters |
| `--text-sm` | `12px` | Tree items, table cells, log entries, badges, most UI text |
| `--text-md` | `13px` | Input text, button text, form labels |
| `--text-lg` | `15px` | Brand mark, panel titles, topbar brand |
| `--text-xl` | `18px` | Content headings (lakehouse name, workspace name) |

### Section Header Pattern

All section headers (TABLES, SCHEMA, INSPECTOR, WORKSPACES) use this exact pattern:

```css
font-size: var(--text-xs);    /* 10px */
font-weight: 700;
color: var(--text-muted);
text-transform: uppercase;
letter-spacing: 0.08em;
```

---

## 3. Spacing

**4px base grid. Only these values are valid:**

| Token | Value | Common Use |
|-------|-------|------------|
| `--space-1` | `4px` | Icon padding, tight gaps |
| `--space-2` | `8px` | Table cell padding, button padding, small gaps |
| `--space-3` | `12px` | Panel padding, section spacing, medium gaps |
| `--space-4` | `16px` | Content padding, header padding |
| `--space-5` | `20px` | Large internal spacing |
| `--space-6` | `24px` | Content body padding, major section gaps |
| `--space-8` | `32px` | View-level spacing |

### Density Principle

- **Data panels** (logs, tables, inspectors): `--space-1` to `--space-3`
- **Structural gaps** (between sections, panels): `--space-4` to `--space-8`

---

## 4. Layout Dimensions

| Token | Value | Element |
|-------|-------|---------|
| `--topbar-height` | `44px` | Top bar |
| `--sidebar-width` | `52px` | Icon sidebar |
| `--tree-panel-width` | `260px` | Workspace tree panel |
| `--inspector-panel-width` | `300px` | Right inspector panel |
| `--row-height` | `28px` | Standard row height (tree items, log entries) |

---

## 5. Border Radius

| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | `4px` | Tree items, small inputs, buttons (small) |
| `--radius-md` | `6px` | Sidebar icons, buttons, cards, inputs |
| `--radius-lg` | `10px` | Tables (container), panels, large cards |
| `--radius-full` | `100px` | Pills, chips, status badges |

---

## 6. Elevation

| Token | Value | Use |
|-------|-------|-----|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.04)` | Topbar |
| `--shadow-md` | `0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` | Dropdowns, popovers |
| `--shadow-lg` | `0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)` | Context menus, command palette |
| `--shadow-glow` | `0 0 0 3px var(--accent-glow)` | Focus ring, token health hover |

**Use sparingly.** Most elevation is communicated by surface color stepping (`--bg` → `--surface` → `--surface-2`), not shadows.

---

## 7. Transitions

| Token | Value | Use |
|-------|-------|-----|
| `--transition-fast` | `80ms ease-out` | Hover states (background, color) |
| `--transition-normal` | `150ms ease-out` | Panel open/close, drawer slide |

**Rules:**
- View switches are **instant** (0ms) — no fade, no slide
- Maximum animation: **150ms**. Anything longer feels sluggish.
- Use `ease-out` only. No bouncing, no spring physics.

---

## 8. Z-Index Scale

| Token | Value | Layer |
|-------|-------|-------|
| `--z-sidebar` | `50` | Sidebar navigation |
| `--z-toolbar` | `90` | Log toolbar, filter bars |
| `--z-topbar` | `100` | Top status bar |
| `--z-dropdown` | `200` | Dropdowns, context menus |
| `--z-detail` | `200` | Detail panel, drawers |
| `--z-command-palette` | `300` | Command palette overlay |
| `--z-toast` | `400` | Toast notifications |

---

## 9. Component Patterns

### Buttons

| Type | Pattern | Use |
|------|---------|-----|
| **Primary** | Solid `--accent` bg, white text, `--radius-md` | Deploy, Run DAG, Send |
| **Ghost** | Transparent bg, `1px solid --border-bright`, `--text-dim` text | Open in Fabric, Cancel, Rename |
| **Danger** | Transparent bg, `1px solid --level-error`, `--level-error` text | Force Unlock, Delete |
| **Small** | Same patterns but `--text-xs` size, `--space-1 --space-2` padding | Copy ID, action dots |

### Status Badges

```css
/* All badges: monospace, 100px radius, signal-color/0.08 bg */
display: inline-flex; align-items: center; gap: 4px;
font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 600;
padding: 2px 8px; border-radius: var(--radius-full);
```

Variants: `.succeeded`, `.failed`, `.running`, `.cancelled` — each uses its status color for text and tinted bg.

### Data Tables

```css
border-collapse: separate; border-spacing: 0;
border: 1px solid var(--border); border-radius: var(--radius-lg);
overflow: hidden;
```

- Header: `--surface-2` bg, uppercase `--text-xs`, `--text-muted` color
- Rows: `--font-mono`, `--text-sm`, hover `--surface-2`
- Selected row: `--accent-dim` bg
- Last row: no bottom border

### Sidebar Icon

- 36×36px hit area, `--radius-md`
- Default: `--text-muted`
- Hover: `--surface-2` bg, `--text` color, `scale(1.05)`
- Active: `--accent-dim` bg, `--accent` color, 3px left indicator bar
- Disabled: `opacity: 0.3`, `pointer-events: none`

### Input Fields

- Background: `--surface-2`
- Border: `1px solid --border-bright`
- Focus: `border-color: --accent` + `--shadow-glow`
- Placeholder: `--text-muted`

### Chips/Pills (topbar status)

- `border-radius: --radius-full`
- `font-family: --font-mono; font-size: --text-xs`
- Background: signal tint (e.g., `rgba(24,160,88,0.06)` for green)
- Color: signal color

---

## 10. Anti-Patterns (Do Not)

| Don't | Do Instead | Why |
|-------|------------|-----|
| Raw hex/rgb in component CSS | Reference `var(--token)` | Themeable, consistent |
| `px` values for spacing | `var(--space-*)` | 4px grid adherence |
| `px` values for font size | `var(--text-*)` | Scale consistency |
| Shadows for elevation in dark theme | Surface color stepping | Cohesive dark mode |
| Animations > 150ms | 80ms hover, 150ms panel, 0ms view switch | Perceived performance |
| Border-radius > 10px on containers | `--radius-sm` to `--radius-lg` | Precision, not friendliness |
| Gradient text | Solid color | Readability |
| Emoji as icons | Unicode symbols (●, ▸, ◆, ✕, ⋯) | Cross-platform, professional |
| Cards wrapping cards | Flat hierarchy with section dividers | Cognitive load reduction |
| `!important` | Fix the cascade | Maintainability |

---

## 11. Theme Switching

Light is default (no `data-theme` attribute). Dark mode via `data-theme="dark"` on `<body>`.

Toggle respects `localStorage.getItem('edog-theme')`. The moon button in the topbar toggles between them.

All tokens are overridden in the `[data-theme="dark"]` selector. Components that use tokens correctly need **zero** dark-mode-specific CSS.

---

*"The design system is not a suggestion. It's the contract between design intent and code output."*

— EDOG Studio Design
