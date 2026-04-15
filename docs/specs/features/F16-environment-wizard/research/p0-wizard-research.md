# P0.5 — Industry Research: Modal Wizard & Multi-Step Flow Patterns

> **Author**: Sana (Architecture & UX Research)
> **Date**: 2025-07-15
> **Scope**: F16 — New Infrastructure Wizard
> **Method**: Deep-dive web research across 20+ products known for exceptional wizard/creation UX
> **Products Analyzed**: Stripe, Vercel, Linear, Notion, Figma, GitHub, AWS, Azure, GCP, Terraform Cloud, Railway, Render, CircleCI, Buildkite, Netlify, Slack, Discord, Shopify

---

## Executive Summary

After researching wizard and multi-step creation flows across the best product teams in the industry, six patterns emerge as non-negotiable for an extraordinary F16 wizard:

1. **Step indicators must be interactive, not decorative.** The best wizards (Stripe, Azure, Vercel) let users click completed steps to jump back — the indicator doubles as navigation. Numbered circles with connecting progress lines, where completed steps show checkmarks and the active step pulses subtly, is the consensus gold standard.

2. **Transitions must be directional and physics-informed.** Stripe's wizards slide content left/right matching navigation direction with 300–400ms eased transitions. Content slides; chrome stays fixed. This creates spatial memory — users feel they're moving through a physical space, not clicking through tabs.

3. **The review page is where trust is built.** Azure's "Review + Create" and AWS's launch summary both use grouped card layouts with per-section "Edit" links that deep-link back to the originating step. GCP adds a live cost estimate sidebar. For F16, our review page should show a mini-DAG rendering alongside a structured summary with one-click edit affordances.

4. **Execution visualization is a solved problem — GitHub Actions is THE reference.** Vertical step list, collapsible per-step logs, real-time status icons (spinner → checkmark → error), per-step duration badges, auto-scroll with pause capability. CircleCI adds DAG visualization for parallel steps. Buildkite adds manual approval gates. We should synthesize all three.

5. **Floating minimized state follows the Google Drive pattern.** Bottom-right docked pill with progress ring, expandable on click, persists across navigation. The key insight: the badge must show *meaningful* progress (step count or percentage), not just a spinner.

6. **Selection UIs (Page 2) should use radio cards, not dropdowns.** Every best-in-class product (Notion templates, Discord server types, Shopify product types) uses visual card grids with iconography, brief descriptions, and a single-click selection model. Dropdowns hide choices; cards celebrate them.

**The CEO bar — "striving for extraordinary always" — means we combine Stripe's animation polish, Linear's keyboard-first efficiency, Azure's structured validation, GitHub Actions' execution visualization, and Google Drive's minimized badge into a cohesive experience that feels like nothing else in the Fabric ecosystem.**

---

## 1. Multi-Step Wizard Analysis

### 1.1 Step Indicator Patterns

#### Comparative Analysis

| Product | Indicator Style | Clickable? | Shows Labels? | Completed State | Animation |
|---------|----------------|------------|---------------|-----------------|-----------|
| **Stripe** | Numbered circles + connecting line | Yes (completed steps) | Yes, below circles | Checkmark replaces number | Progress line fills with brand color |
| **Vercel** | Minimal dots | Limited | No | Filled dot | Subtle scale |
| **Azure Portal** | Vertical sidebar tabs | Yes, all steps | Yes, as tab labels | Checkmark icon + green accent | Instant switch |
| **AWS EC2** | Horizontal numbered steps | Yes (completed) | Yes | Checkmark badge | Line fill |
| **GCP Console** | Accordion sections | N/A (linear scroll) | Yes, as section headers | Collapsed with summary | Smooth expand/collapse |
| **Shopify** | Progress bar + breadcrumb text | Yes | Yes | Checkmark | Bar fill animation |
| **Discord** | Dot indicators | No | No | Filled | Fade |
| **Linear** | Minimal — almost invisible | N/A (single-page) | N/A | N/A | N/A |

#### Key Findings

**The numbered circle + connecting line pattern dominates** for wizards with 3–7 steps. It provides:
- **Spatial orientation**: Users see where they are in the journey
- **Progress feedback**: Filled line segments show completion
- **Navigation affordance**: Clickable completed steps enable non-linear editing
- **Scalability**: Works for 3–7 steps without becoming crowded

**Azure's vertical sidebar** is the outlier worth studying. For complex configuration (which F16 is), the sidebar approach offers:
- More room for step labels
- Always visible regardless of scroll position
- Clear active/completed/upcoming states via color + icon
- Natural grouping of related steps

**Anti-pattern**: Discord/Vercel's dot indicators are too minimal for a 5-step wizard with complex content. They work for 2–3 step lightweight flows but provide insufficient orientation for infrastructure creation.

#### F16 Recommendation

**Horizontal numbered stepper with connecting progress line**, positioned in the modal header. Design details:
- Circles: 28px diameter, numbered 1–5
- Connecting line: 2px, fills with accent color as steps complete
- Completed steps: Number replaced by checkmark (✓), circle filled with accent
- Active step: Circle has accent border + subtle pulse animation (not distracting)
- Future steps: Circle with muted border, muted number
- Labels below each circle: "Setup", "Theme", "Build", "Review", "Deploy"
- **Clickable**: Completed steps are clickable to jump back; future steps are not
- On click-back: Scroll position and form state preserved

### 1.2 Navigation Patterns

#### Comparative Analysis

| Product | Primary Nav | Back Behavior | Keyboard Nav | Skip Steps? | Save State? |
|---------|-------------|---------------|--------------|-------------|-------------|
| **Stripe** | Next/Back buttons, bottom-right | Full state preserved | Tab through fields | No | Auto-save |
| **Vercel** | Single "Deploy" CTA at end | State preserved | Limited | Yes (env vars) | Per-step |
| **Azure** | Next/Previous + step tabs | State preserved | Full keyboard | Yes (optional tabs) | Draft support |
| **AWS** | Next/Back + step clicks | State preserved | Tab | No | No |
| **Shopify** | Next + skip optional | State preserved | Tab + shortcuts | Yes | Auto-save |
| **Linear** | Cmd+Enter to proceed | Undo-based | Full keyboard-first | N/A | Instant |

#### Key Findings

1. **Button placement**: Bottom-right for Next (primary), bottom-left for Back (secondary). This follows the F-pattern — the eye ends at the bottom-right, exactly where the primary action should be.

2. **Back never loses data**: Every product preserves form state when navigating backward. This is table stakes — losing data on Back is a rage-quit trigger.

3. **Keyboard navigation is a power-user multiplier**: Linear proves that keyboard shortcuts (Tab between fields, Enter to proceed, Escape to cancel) make wizards feel *fast*. Stripe validates inline as you type, so Tab-Enter-Tab-Enter flows are fluid.

4. **Skip is contextual**: Some steps (like environment variables in Vercel) are optional. Skippable steps should be visually distinct in the step indicator.

#### F16 Recommendation

- **Next button**: Bottom-right, primary accent color. Disabled until step validation passes. Label changes contextually: "Next" → "Next" → "Next" → "Review" → "Deploy"
- **Back button**: Bottom-left, ghost/secondary style. Always enabled (except on step 1)
- **Step indicator clicks**: Completed steps are clickable (acts as Back with jump)
- **Keyboard**: Tab through fields, Enter on Next, Escape to close (with unsaved-changes confirmation)
- **No skip**: All 5 F16 pages are required. Page 3 (DAG builder) may have a "use template" shortcut, but it's not a skip
- **State preservation**: All form data stored in a central wizard state object. Navigation never clears state.

### 1.3 Validation Patterns

#### Comparative Analysis

| Product | When Validated | Error Display | Blocks Next? | Success Feedback |
|---------|---------------|---------------|--------------|------------------|
| **Stripe** | On blur + on Next | Inline under field, red text | Yes | Green checkmark on field |
| **Azure** | On "Review + Create" (bulk) | Banner + field highlights | Yes | Validation passed banner |
| **AWS** | On Next + inline | Inline + summary toast | Yes | Green checkmark per section |
| **Vercel** | Real-time (on type) | Inline, contextual | Soft block (warning) | Detected framework badge |
| **GCP** | On blur + on Create | Inline + quota warnings | Yes | Cost estimate updates |
| **Shopify** | On blur | Inline, red border | Yes | Field turns green |

#### Key Findings

1. **Validate on blur, re-validate on Next**: The two-phase approach is the consensus. Blur validation provides immediate feedback; Next-button validation catches anything missed.

2. **Inline errors beat summary banners**: Users' eyes are near the field they just edited. Inline error messages (directly below the field, in red/error color) outperform top-of-page error banners by 3x in correction speed (per Baymard Institute research).

3. **Success feedback matters**: Stripe's green checkmark on valid fields is a small delight that builds confidence. When every field shows a checkmark, clicking "Next" feels safe.

4. **Azure's "Review + Create" bulk validation is a safety net**: Even if per-step validation passes, a final validation sweep on the review page catches cross-step conflicts (e.g., workspace name already in use).

#### F16 Recommendation

- **Per-field validation on blur**: Workspace name (check availability), capacity selection (check quota), notebook name (format validation)
- **Per-step validation on Next**: All required fields filled, selections made, DAG has at least one node
- **Final validation on Review page**: Cross-step consistency check, API availability verification
- **Error display**: Inline below field, 12px text in error color, with clear remediation text
- **Success display**: Subtle checkmark icon appears in the field's trailing slot on valid
- **Next button**: Disabled with tooltip explaining what's missing if validation fails

### 1.4 Step Transition Animations

#### Comparative Analysis

| Product | Transition Type | Duration | Direction-Aware? | Content vs Chrome |
|---------|----------------|----------|------------------|-------------------|
| **Stripe** | Slide + fade | 300–400ms | Yes (left/right) | Content slides; header/footer fixed |
| **Vercel** | Fade | 200ms | No | Full panel fade |
| **Azure** | Instant | 0ms | No | Tab content swaps |
| **Shopify** | Slide | 300ms | Yes | Content slides |
| **Discord** | Slide + scale | 350ms | Yes | Full modal content |
| **Notion** | Fade + slide | 250ms | Contextual | Content area only |

#### Key Findings

1. **Direction-aware transitions create spatial memory**: When going forward, content slides left (new content enters from right). When going back, content slides right (previous content enters from left). This creates the mental model of a horizontal journey.

2. **300–400ms is the sweet spot**: Faster feels jarring; slower feels sluggish. The `cubic-bezier(0.4, 0, 0.2, 1)` easing (Material Design standard) provides a natural deceleration.

3. **Fixed chrome is critical**: The modal header (with step indicator), footer (with navigation buttons), and modal frame should NOT animate. Only the content area between header and footer transitions. This prevents the entire modal from feeling unstable.

4. **Stripe's approach is best-in-class**: Slide + subtle fade (opacity 1→0 on exit, 0→1 on enter) with direction awareness. The outgoing content slides and fades out; the incoming content slides and fades in. The cross-fade creates a smooth handoff.

#### F16 Recommendation

```
Transition: Slide + Fade, Direction-Aware
Duration: 350ms
Easing: cubic-bezier(0.4, 0, 0.2, 1)
Forward: Content slides left, fades out → New content slides in from right, fades in
Backward: Content slides right, fades out → Previous content slides in from left, fades in
Fixed elements: Modal frame, header (step indicator), footer (navigation buttons)
Animated element: Content area only (.wizard-content container)
```

Implementation approach:
- Use CSS `transform: translateX()` + `opacity` for GPU-accelerated animation
- Maintain two content slots: outgoing (exit animation) and incoming (enter animation)
- Duration: 350ms with staggered start (outgoing begins immediately, incoming begins at 100ms)

---

## 2. Modal/Dialog Analysis

### 2.1 Dimensions & Sizing

#### Comparative Analysis

| Product | Default Size | Min Size | Max Size | Aspect Behavior |
|---------|-------------|----------|----------|-----------------|
| **Stripe** | 560px wide, content-height | ~400×300 | 90vw×90vh | Fixed width, variable height |
| **Azure** | ~800px wide blade | 320px | Full screen | Blade stacking model |
| **AWS** | Full-page wizard | N/A | N/A | Full page, not modal |
| **Vercel** | 480–600px wide | 360px | 90vw | Responsive |
| **Discord** | ~440px centered | ~360px | ~520px | Fixed |
| **Figma** | ~480px | ~320px | 90vw | Fixed width |
| **Slack** | ~520px | ~360px | ~600px | Fixed |

#### Key Findings

1. **Simple creation modals are narrow (440–600px)**. Discord, Slack, Figma use this range for simple forms.

2. **Complex configuration wizards are wider (700–1000px)**. Azure blades, AWS wizards, and Shopify admin panels use wider layouts to accommodate dense forms and side panels.

3. **F16 is complex**: With a DAG canvas on Page 3, we need more space than a typical creation modal. The DAG builder is the centerpiece and needs real estate.

4. **90vw × 90vh is the universal maximum**: No product allows modals larger than 90% viewport in either dimension.

#### F16 Recommendation

```
Default:  960px wide × 680px tall (landscape ratio, optimized for DAG canvas)
Minimum:  640px wide × 480px tall (below this, content is unusable)
Maximum:  90vw × 90vh
Resize:   Edge + corner handles, continuous resize with min/max constraints
Center:   Initially centered in viewport
```

**Why 960×680**: Page 3 (DAG canvas) is the most space-hungry page. 960px gives enough horizontal room for a node palette sidebar (200px) + canvas (760px). 680px gives enough vertical room for header (60px) + content (560px) + footer (60px).

### 2.2 Backdrop & Overlay

#### Comparative Analysis

| Product | Backdrop Style | Opacity/Blur | Click-Outside | Escape Key |
|---------|---------------|--------------|---------------|------------|
| **Stripe** | Dark overlay | ~50% black | Closes (with confirm if dirty) | Closes |
| **Azure** | Dim overlay | ~40% black | No close | Escape closes blade |
| **Vercel** | Subtle dim | ~30% black | Closes | Closes |
| **Figma** | Dark overlay | ~50% black + slight blur | Closes | Closes |
| **Discord** | Dark overlay | ~60% black | Closes | Closes |
| **Slack** | Dark overlay | ~40% black | Closes | Closes |
| **Notion** | Light dim | ~20% black | Closes | Closes |

#### Key Findings

1. **Backdrop blur is emerging but not universal**: Figma uses a subtle backdrop blur (4–8px) combined with dimming. This creates depth without full opacity. Most products still use simple opacity dimming.

2. **Click-outside should NOT close for complex wizards**: Azure gets this right — for multi-step configuration, accidentally clicking outside should not discard a partially completed wizard. Stripe adds a confirmation dialog if the form is dirty.

3. **40–50% opacity is the sweet spot**: Light enough to see the underlying app (context), dark enough to establish modal focus.

#### F16 Recommendation

```
Backdrop: oklch(0.15 0 0 / 0.5) — dark overlay at 50% opacity
Blur: backdrop-filter: blur(4px) — subtle blur for depth
Click-outside: No close (wizard has unsaved state)
Escape key: Prompts confirmation dialog if any data entered, otherwise closes
Animation: Backdrop fades in over 200ms on open, fades out on close
```

### 2.3 Resize & Drag

#### Comparative Analysis

Most modal wizards in the products researched do **not** support resize or drag. This is a differentiator for F16.

| Product | Resizable? | Draggable? | Notes |
|---------|-----------|------------|-------|
| **Azure** | Blade width adjustable | No | Blade stacking model |
| **Figma** | Some dialogs | Some dialogs | Plugin panels are resizable |
| **VS Code** | Panels yes, modals no | No | — |
| **OS file dialogs** | Yes | Yes | The gold standard for resize + drag |
| **Slack** | No | No | — |

#### Key Findings

1. **Resize handles should be visible but subtle**: 8px hit area on edges, 12px on corners. Cursor changes to resize cursor on hover. No visible handle dots (they look dated) — use transparent hit areas.

2. **Drag zone = title bar only**: The modal header (containing the title and step indicator) should be the drag handle. Never the content area (conflicts with form interaction).

3. **Constrain to viewport**: The modal must not be draggable fully off-screen. At least 48px of the header must remain visible.

4. **Snap behavior**: Consider snap-to-center on double-click of the title bar (like OS windows). No edge-snapping needed for a modal.

#### F16 Recommendation

```
Resize:
  - Edge handles: 8px hit area, all 4 edges
  - Corner handles: 12px hit area, all 4 corners
  - Min size: 640×480
  - Max size: 90vw×90vh
  - Cursor: resize cursors on hover (ew-resize, ns-resize, nwse-resize, nesw-resize)
  - No visible handle indicators — transparent hit areas only

Drag:
  - Drag zone: Modal header bar (title + step indicator area)
  - Cursor: grab on hover, grabbing on drag
  - Constraint: Modal cannot be dragged so header is fully off-screen (48px minimum visible)
  - Double-click header: Re-center modal in viewport

Both:
  - Smooth, 60fps — use transform for position, width/height for size
  - Remember last position/size in session (restore on re-open)
```

---

## 3. Form Design Patterns

### 3.1 Infrastructure Setup Forms (Page 1 Parallels)

#### Best Practices from Cloud Consoles

**AWS EC2 Launch Wizard** (closest parallel to F16 Page 1):
- Groups related fields in collapsible sections: "Name & Tags", "Instance Type", "Key Pair", "Network"
- Uses filter/search within dropdowns for large option sets
- Shows "Quick Start" recommended options prominently
- Inline help via "Info" links that open side panels (not popups)

**Azure Resource Creation**:
- Required fields marked with asterisk (*), strongly enforced
- Dropdown labels include the current selection count and a search filter
- "Basics" tab pattern: Subscription → Resource Group → Name → Region
- Conditional fields: selecting one option reveals/hides related fields

**GCP VM Creation**:
- Real-time cost estimate sidebar that updates as you configure
- "Equivalent command" feature — shows the gcloud CLI command for your selections
- Machine type selection uses a two-level picker: Family → Series → Type

#### F16 Page 1 Recommendations

```
Layout: Single-column form, 560px max content width within modal
Sections (top to bottom):
  1. Workspace Name — text input, auto-generated default, validation on blur
  2. Capacity — dropdown with search, shows current capacity utilization
  3. Lakehouse Name — text input, auto-generated from workspace name
  4. Notebook Name — text input, auto-generated from workspace name

Field design:
  - Label: 13px, semi-bold, above field
  - Input: 40px height, 14px text, 1px border, 8px border-radius
  - Help text: 12px, muted color, below field
  - Error text: 12px, error color, replaces help text on error
  - Required indicator: red dot (●) before label, not asterisk

Spacing: 24px between field groups, 8px between label and input, 4px between input and help text
```

### 3.2 Selection UIs (Page 2 Parallels)

#### Best Practices from Card Selection Patterns

**Notion Template Gallery**:
- Visual cards in a responsive grid (3–4 columns)
- Each card: preview thumbnail, title, brief description
- Hover: subtle elevation increase + border highlight
- Selected: accent border + checkmark badge in corner
- Categories as filter tabs above the grid

**Discord Server Type Selection**:
- Large cards with illustrations and descriptions
- Single-click selection (no separate "Select" button)
- Selected card: accent border + filled state
- Playful, branded illustrations per option

**Shopify Product Type**:
- Card-based selection with icon + label + description
- Selected card: filled background, accent border, checkmark
- Cards arranged in 2–3 column grid

#### F16 Page 2 Recommendations

**Theme Selection (6 data themes)**:
```
Layout: 3×2 card grid
Card size: ~180px wide × 140px tall
Card content:
  - Top: Thematic icon/illustration (48px)
  - Middle: Theme name (14px, semi-bold)
  - Bottom: Brief description (12px, 2 lines max, muted)

States:
  - Default: 1px muted border, subtle background
  - Hover: border brightens, slight elevation (box-shadow increase)
  - Selected: 2px accent border, accent background tint, checkmark badge top-right
  - Disabled ("Coming Soon"): 50% opacity, "Coming Soon" pill badge overlay

Selection behavior: Click to select (radio — only one active)
```

**Schema Selection (Medallion Architecture)**:
```
Layout: Horizontal radio card group (Bronze → Silver → Gold → Full)
Card content: Schema name + table count + brief description
Visual: Connected by a progression line (like the step indicator pattern)
```

### 3.3 Auto-Generated Names

#### Best Practices

**AWS**: Uses `{resource-type}-{random-id}` pattern (e.g., `i-0abc123def456`). Not user-friendly.

**Azure**: Uses `{resource-type}-{user-input}` pattern. The resource group name drives child resource names. Smart cascading.

**GCP**: Uses `{project-id}-{resource-type}-{random-suffix}` with full edit capability.

**Vercel**: Auto-detects project name from repository name. Editable but smart default.

#### F16 Recommendation

```
Pattern: {user-workspace-prefix}-{resource-type}
Example: "my-test-env" workspace → auto-generates:
  - Lakehouse: "my-test-env-lakehouse"
  - Notebook: "my-test-env-notebook"

Behavior:
  - Workspace name drives all child names
  - Editing workspace name auto-updates child names (if child names haven't been manually edited)
  - Child name fields show auto-generated value as editable text (not placeholder)
  - "Reset to auto" button appears if child name was manually edited
  - Visual indicator: small "auto" pill badge next to auto-generated fields

Smart generation:
  - Sanitize workspace name for resource naming rules (lowercase, hyphens only)
  - Show real-time preview of the sanitized name as user types
```

### 3.4 "Coming Soon" Features

#### Best Practices

| Pattern | Used By | Visual Treatment |
|---------|---------|-----------------|
| Grayed out + badge | Notion, Figma | 50% opacity + "Coming Soon" pill |
| Locked icon + tooltip | Shopify, Slack | Lock icon overlay + hover tooltip |
| Visible but non-interactive | Azure | Item visible in list, click shows "not available" |
| Hidden entirely | Linear | Feature simply not shown until ready |

#### F16 Recommendation

```
Pattern: Visible but muted, with "Coming Soon" badge
Visual:
  - Card at 50% opacity
  - "Coming Soon" pill badge (small, uppercase, muted accent color) in top-right corner
  - Non-interactive (cursor: default, no hover effects)
  - Tooltip on hover: "This theme will be available in a future release"

Rationale: Showing coming-soon features builds anticipation and communicates roadmap
without requiring a separate communication channel. Hiding them loses that benefit.
```

---

## 4. Review/Confirmation Patterns (Page 4)

### Comparative Analysis

#### Azure "Review + Create"
- **Layout**: Two-column key-value list grouped by wizard section
- **Sections**: Collapsible, with section headers matching step names
- **Edit affordance**: "Edit" link at top of each section → jumps to that wizard step
- **Validation**: Full re-validation on this page; blocks "Create" if issues found
- **Highlight**: Shows estimated cost and deployment time

#### AWS Launch Summary
- **Layout**: Full-page summary, tabular format
- **Sections**: Matches wizard steps 1:1
- **Edit affordance**: "Edit" button per section
- **Extras**: "Download as CloudFormation template" button
- **Warning banner**: Alerts for security concerns (e.g., open security groups)

#### GCP Resource Review
- **Layout**: Accordion sections matching configuration steps
- **Sidebar**: Persistent cost estimate panel
- **Edit affordance**: Inline "Edit" links
- **Extras**: "Equivalent gcloud command" for CLI users
- **Validation**: Pre-checks for quotas, API enablement

#### Stripe Confirmation
- **Layout**: Clean card layout, minimal
- **Sections**: Business info, bank details, verification status
- **Edit affordance**: "Edit" link per section with smooth transition back
- **Celebration**: Success animation on final confirmation

### Key Findings

1. **Group by wizard step, not by data type**: The review page sections should mirror the wizard steps (Setup → Theme → DAG → Review), not reorganize data by category. This maintains the user's mental model.

2. **Every section needs an "Edit" link**: The link should deep-navigate to the specific wizard step, preserving the review page state for when the user returns.

3. **Show what you're about to create**: Cloud consoles excel at listing every resource that will be provisioned. F16 should list: workspace, capacity assignment, lakehouse, notebook, DAG configuration, schema tables.

4. **Visual summary beats text-only**: A mini-DAG rendering on the review page (read-only, simplified) provides instant visual confirmation that the pipeline looks right.

### F16 Page 4 Recommendations

```
Layout: Two-panel layout
  Left panel (60%): Grouped summary sections
  Right panel (40%): Mini-DAG preview (read-only, simplified rendering of Page 3 canvas)

Sections (left panel):
  1. "Infrastructure" — workspace name, capacity, lakehouse, notebook
     [Edit] link → jumps to Page 1
  2. "Data Theme" — selected theme, schema tier, table count
     [Edit] link → jumps to Page 2
  3. "Pipeline" — node count, connection count, source→sink summary
     [Edit] link → jumps to Page 3
  4. "Estimated Provisioning" — resource list with timing estimates

Each section:
  - Collapsible (default: expanded)
  - Header: section name + edit link (right-aligned)
  - Content: key-value pairs in a two-column layout
  - Visual separator between sections

Mini-DAG (right panel):
  - Simplified rendering of the DAG canvas from Page 3
  - Read-only, no interaction
  - Scaled to fit panel (auto-zoom)
  - Node names and connection lines visible
  - Provides instant visual confirmation

CTA button: "Deploy Environment" (not "Create" — deploy implies action + progress)
```

---

## 5. Execution Progress Patterns (Page 5)

### 5.1 GitHub Actions Deep-Dive

GitHub Actions is THE reference for our execution view. Deep analysis:

**Layout Architecture**:
- **Left sidebar**: Job list with status icons (vertical)
- **Main panel**: Step list for selected job with expandable log panels
- **Each step**: Collapsible section with status icon, step name, duration badge

**Status Icon System**:
| State | Icon | Color | Animation |
|-------|------|-------|-----------|
| Queued | Circle outline | Gray | None |
| In Progress | Circle | Yellow/amber | Spinning/pulsing |
| Success | Checkmark in circle | Green | Brief flash on complete |
| Failed | X in circle | Red | None (persistent) |
| Skipped | Dash in circle | Gray | None |
| Cancelled | Slash in circle | Gray | None |

**Step Expansion**:
- Click step name to expand/collapse log output
- Logs render in monospace font, with ANSI color support
- Auto-scroll follows latest output (with "pause auto-scroll" affordance)
- Failed steps auto-expand to show error context
- Search within logs (Ctrl+F equivalent)

**Timing**:
- Per-step duration badge (e.g., "12s", "2m 34s") right-aligned
- Total job duration in job header
- Elapsed time updates in real-time for running steps

**Error Handling**:
- Failed step highlighted with red background tint
- Error summary extracted and shown above the log
- "Re-run failed jobs" button in header
- Link to specific failing line in logs

**What Makes It Extraordinary**:
- The step-by-step reveal creates a narrative — you're watching your code come to life
- Real-time log streaming via WebSocket makes it feel alive, not polled
- Collapsible sections keep the overview clean while allowing deep-dive
- Duration badges enable instant performance diagnosis

### 5.2 Vercel Deployment Progress

**Layout**: Single-panel vertical flow
- Top banner: Status + deployment URL (when complete)
- Progress section: Linear step indicator (Queued → Building → Deploying → Ready)
- Log panel: Real-time streaming build output
- Sidebar: Deployment metadata (commit, branch, environment)

**What Makes It Extraordinary**:
- The deployment URL appears the instant the site is live — instant gratification
- QR code for mobile preview is a delightful touch
- Error messages include "Possible Causes" with links to docs
- Build output is color-coded: errors red, warnings yellow, info gray

### 5.3 CircleCI Pipeline Visualization

**Unique Contribution**: DAG-based job visualization
- Jobs rendered as nodes in a directed graph
- Dependencies shown as connecting lines
- Parallel jobs rendered side-by-side
- Status colors fill nodes in real-time
- Clicking a node navigates to its step detail

**What We Should Steal**: The DAG visualization for parallel deployment steps. If F16's deployment has parallel provisioning (e.g., lakehouse + notebook simultaneously), show them as parallel nodes.

### 5.4 Buildkite Build Progress

**Unique Contribution**: Step cards with rich metadata
- Each step is a distinct card with progress bar, status, artifacts
- Manual approval steps are visually distinct (different card style, "Approve" button)
- Retry history shown inline (stack of attempts)
- "Section headers" group steps into phases

**What We Should Steal**: Step grouping with section headers. F16 deployment could group steps: "Infrastructure" → "Data Setup" → "Pipeline Configuration" → "Validation".

### 5.5 Netlify Deploy Progress

**Unique Contribution**: Stage-based linear progress
- Four clear stages: Queued → Build In Progress → Deploying → Live
- Each stage is a discrete badge that fills/activates in sequence
- Deploy history with duration comparison (is this build faster/slower than average?)
- Error summaries at top of failed log output

### 5.6 Synthesis — F16 Page 5 Recommendation

```
Layout: Vertical step list (GitHub Actions model)

Structure:
  ┌──────────────────────────────────────────────┐
  │ Deploy Environment: "my-test-env"            │
  │ Started: 12:34:05 PM  |  Elapsed: 2m 15s     │
  ├──────────────────────────────────────────────┤
  │                                              │
  │  ● Create Workspace ··················· 8s  │
  │    └─ [collapsed log content]                │
  │                                              │
  │  ● Assign Capacity ··················· 3s  │
  │    └─ [collapsed log content]                │
  │                                              │
  │  ◐ Provision Lakehouse ·········· running   │
  │    └─ [expanded, auto-scrolling log]         │
  │                                              │
  │  ○ Create Notebook ··················· —    │
  │                                              │
  │  ○ Configure Pipeline ················ —    │
  │                                              │
  │  ○ Validate Environment ·············· —    │
  │                                              │
  ├──────────────────────────────────────────────┤
  │ [Minimize to Badge]           [Cancel Deploy] │
  └──────────────────────────────────────────────┘

Status Icons:
  ● (filled circle, green) = Complete
  ◐ (half circle, accent, animated) = In progress
  ○ (empty circle, muted) = Pending
  ✕ (X circle, red) = Failed
  ↻ (retry icon) = Retrying

Step Expansion:
  - Completed steps: Collapsed, click to expand log
  - Running step: Auto-expanded, live log streaming
  - Failed step: Auto-expanded, error summary at top
  - Pending steps: Non-expandable, no log yet

Duration Badges:
  - Completed: "8s", "3s" (right-aligned, muted text)
  - Running: "running" (animated dots), elapsed time updating
  - Pending: "—" (em-dash)

Error UX:
  - Failed step gets red-tinted background
  - Error summary box above log: extracted error message + suggested fix
  - "Retry" button appears next to failed step
  - "Retry All" button in footer replaces "Cancel Deploy"

Log Rendering:
  - Monospace font, 12px
  - ANSI color stripping (render as semantic colors)
  - Auto-scroll with "Pause" toggle in log header
  - Line numbers (optional toggle)
  - "Copy log" button per step
```

---

## 6. Floating Badge / Minimized State

### Research Findings

**Google Drive Upload Progress** (the gold standard):
- Bottom-right docked panel
- Shows: file count, progress bar, current file name
- Expandable to show full file list
- Collapsible to single-line "Uploading 3 files..." banner
- Minimizable to small icon with progress ring

**Slack Notification Badge**:
- Bottom-left or notification area
- Unread count badge on icon
- Click to expand relevant panel

**macOS Notification Center**:
- Progress shown in notification banners
- Can be dismissed or expanded
- Persistent for long-running operations

**Browser Download Progress** (Chrome):
- Bottom-left download tray
- Per-file progress bar
- Expandable to full download list

### Key Findings

1. **Bottom-right is the standard position** for floating progress indicators. It avoids conflict with navigation (typically left) and primary actions (typically top/center).

2. **The badge must show meaningful progress**: A spinner alone is insufficient. Show either a step counter ("3/6 steps") or a progress percentage ring.

3. **Click-to-expand must restore full modal**: The transition from badge → modal should be smooth (scale + fade animation, not instant).

4. **The badge persists across navigation**: While minimized, the user can interact with the main application. The badge follows them.

### F16 Recommendation

```
Badge Design:
  Shape: Pill (rounded rectangle), 200px × 40px
  Position: Fixed, bottom-right, 24px from edges
  Z-index: Above all app content (z-index: 10000)

Content:
  - Left: Status icon (spinning for in-progress, checkmark for done, X for error)
  - Center: "Deploying my-test-env" (truncated if needed) + step progress "3/6"
  - Right: Progress ring (circular, 24px, showing percentage)
  - Optional: Elapsed time in muted text

States:
  - In Progress: accent background tint, spinning icon, progress ring animating
  - Complete: success color background, checkmark icon, "3m 12s" duration
  - Failed: error color background, X icon, "Failed at step 4"
  - Hover: Slight elevation increase, tooltip: "Click to expand"

Interactions:
  - Click: Expand back to full modal (on Page 5) with smooth scale animation
  - Badge → Modal transition: Scale from badge position to modal center, 400ms
  - Modal → Badge transition: Scale from modal to badge position, 300ms

Badge appears:
  - When user clicks "Minimize to Badge" on Page 5
  - Automatically if user clicks backdrop or navigates away during execution

Badge disappears:
  - When clicked (expands to modal)
  - When deployment completes + user dismisses
  - Auto-dismiss after 30 seconds on completion (with undo)
```

---

## 7. Tool-by-Tool Highlights

### 7.1 Stripe
**What makes it exceptional**: Animation quality. Every transition, validation feedback, and state change is polished with physics-based easing. The wizard never feels "mechanical" — it feels fluid and alive. Context-preserving transitions (chrome stays fixed, content slides) create strong spatial orientation. The review page uses clean cards with inline edit links, maintaining flow without jarring page changes. Success celebrations (brief checkmark animation, not confetti) feel professional yet delightful.

**Steal for F16**: Transition animation system. Inline validation with success checkmarks. Clean review page with per-section edit links.

### 7.2 Vercel
**What makes it exceptional**: Zero-friction progression. Auto-detection of framework, auto-generation of build settings, pre-filling of environment variables from integrations. The deployment progress page is a masterclass in real-time feedback — the instant the URL appears, you can click it. QR code for mobile testing is a delightful surprise.

**Steal for F16**: Auto-detection and smart defaults. Instant deployment URL availability. The "surprise delight" of QR code equivalents (perhaps a deep-link to the running environment).

### 7.3 Linear
**What makes it exceptional**: Keyboard-first philosophy. Cmd+K command palette. Every action is 1–3 keystrokes. The UI is so minimal it almost disappears — the content IS the interface. No wizard chrome, no decorative elements. Pure function.

**Steal for F16**: Keyboard shortcuts for wizard navigation (Tab, Enter, Escape). Consider a Cmd+K palette for advanced users to jump between wizard pages or configure settings rapidly.

### 7.4 Azure Portal
**What makes it exceptional**: The vertical sidebar step list provides the best orientation for complex, multi-step configuration. The "Review + Create" pattern with full validation sweep is the most robust confirmation pattern. The blade stacking model (new panels slide from the right) creates clear spatial hierarchy.

**Steal for F16**: Step validation on the review page. Vertical step list as an alternative to horizontal stepper for the sidebar-style layout. The "validation passed" / "validation failed" banner on review.

### 7.5 GitHub Actions
**What makes it exceptional**: The execution visualization is the definitive reference. Collapsible steps, real-time log streaming, per-step duration, error auto-expansion, retry mechanics — it's all there. The DAG view for parallel jobs adds visual clarity. Status icons are universally understood.

**Steal for F16**: Everything about the execution view. Vertical step list, collapsible logs, real-time streaming, duration badges, error UX with retry.

### 7.6 Notion
**What makes it exceptional**: Template selection as visual card gallery with preview capability. The cards are not just clickable — they show a live preview of what you'll get. Category tabs (Recommended, Popular, Categories) help users find the right template quickly.

**Steal for F16**: Visual card gallery for theme selection (Page 2). Consider a preview capability — hovering a theme card could show a tooltip preview of the tables/schema it generates.

### 7.7 Discord
**What makes it exceptional**: Playful illustrations per server type. The wizard feels like a creative experience, not a form. Large, illustrated cards with minimal text. The simplicity is deceptive — behind the playful UI is a robust configuration system.

**Steal for F16**: Illustration/iconography per theme card. Making the wizard feel like a creative/building experience rather than a form-filling exercise.

### 7.8 Shopify
**What makes it exceptional**: The persistent onboarding checklist pattern. After creation, a dashboard widget tracks remaining setup tasks. Motivational micro-interactions ("You're halfway there!"). AI-assisted content generation for product descriptions.

**Steal for F16**: Consider a post-creation checklist or "What's next?" panel after the wizard completes. Progress encouragement during long wizard flows.

---

## 8. Recommended Design for F16

### 8.1 Step Indicator — Final Recommendation

**Pattern**: Horizontal numbered stepper with connecting progress line

```
  ①━━━━②━━━━③━━━━④━━━━⑤
Setup  Theme  Build  Review  Deploy
```

- 5 numbered circles (28px) connected by a 2px line
- Completed: checkmark replaces number, accent fill, line segment fills
- Active: accent border, number visible, subtle pulse
- Future: muted border, muted number, unfilled line
- Labels below each circle, 11px, semi-bold
- Clickable completed steps for navigation
- Positioned in modal header, horizontally centered

### 8.2 Modal Behavior — Final Recommendation

```
Size: 960×680 default, 640×480 min, 90vw×90vh max
Backdrop: oklch(0.15 0 0 / 0.5) + 4px blur
Drag: Header bar is drag handle, constrained to viewport
Resize: Edge/corner handles, no visible indicators
Close: X button top-right, Escape with confirmation if dirty
Open animation: Scale 0.95→1.0 + fade, 250ms
Close animation: Scale 1.0→0.95 + fade, 200ms
```

### 8.3 Form Layout — Final Recommendation

**Page 1** (Setup): Single-column form, auto-generated cascading names
**Page 2** (Theme): 3×2 card grid for themes + horizontal radio cards for schema tier

```
Form fields: Label above, 40px input height, 8px radius
Spacing: 24px between groups, 8px label-to-input, 4px input-to-help
Validation: On blur + on Next, inline errors, success checkmarks
Auto-names: Workspace name drives child names, "auto" pill badge, "Reset" link
```

### 8.4 Review Page — Final Recommendation

Two-panel layout: grouped summary (left 60%) + mini-DAG preview (right 40%)

```
Sections mirror wizard steps with [Edit] links
Key-value pair layout within each section
Collapsible sections (default: all expanded)
Final validation sweep with pass/fail banner
CTA: "Deploy Environment" button (accent, full-width in footer)
```

### 8.5 Execution View — Final Recommendation

GitHub Actions-style vertical step list with real-time log streaming

```
Vertical step list with status icons + duration badges
Collapsible per-step logs (monospace, ANSI-stripped, auto-scroll)
Running step auto-expanded, completed steps collapsed
Failed step: red tint, error summary, retry button
Header: Environment name + elapsed time
Footer: "Minimize to Badge" + "Cancel Deploy"
```

### 8.6 Floating Badge — Final Recommendation

Bottom-right docked pill with progress indicator

```
Pill shape: 200×40px, fixed bottom-right (24px margins)
Content: Status icon + environment name + step progress + progress ring
Click: Expand back to full modal with scale animation
Auto-minimize: On backdrop click during execution
States: In progress (accent), complete (success), failed (error)
Persists across app navigation
```

---

## 9. Anti-Patterns to Avoid

### 9.1 Generic Bootstrap/Material Stepper
**Problem**: Using a stock MUI Stepper or Bootstrap wizard makes F16 look like every other admin panel. These components are designed for generic CRUD forms, not environment creation experiences.
**Instead**: Custom step indicator that matches EDOG Studio's design language, with OKLCH colors, custom animations, and integrated navigation.

### 9.2 Full-Page Wizard (AWS-style)
**Problem**: AWS EC2 launch wizard takes over the entire page, losing context of what you were doing. For a tool like EDOG Studio that lives in a single-page app, full-page takeover is disorienting.
**Instead**: Modal overlay that preserves the background app context (visible through the dimmed backdrop).

### 9.3 Accordion-Only Layout (GCP-style)
**Problem**: GCP's accordion approach forces linear scrolling and makes it hard to see where you are in the process. It also doesn't support the concept of "pages" — everything is one long scroll.
**Instead**: Distinct pages with step transitions, providing clear progression and spatial memory.

### 9.4 Click-Outside-to-Close
**Problem**: Accidentally clicking outside a 5-page wizard that has unsaved configuration data is devastating.
**Instead**: Click-outside does nothing. Close requires X button or Escape, both with confirmation if data exists.

### 9.5 No Keyboard Navigation
**Problem**: Forcing mouse-only interaction makes the wizard feel slow for power users (developers are keyboard people).
**Instead**: Full keyboard support — Tab through fields, Enter for Next, Shift+Tab for Back, Escape for Close, number keys to jump to steps.

### 9.6 Spinner-Only Progress (No Step Detail)
**Problem**: Showing a single spinner with "Creating environment..." gives zero feedback on what's happening or how long it will take.
**Instead**: GitHub Actions-style step-by-step progress with per-step duration, expandable logs, and real-time updates.

### 9.7 Confetti/Fireworks on Completion
**Problem**: Confetti animations are juvenile for a developer tool. They feel like gamification, not professionalism.
**Instead**: Subtle success feedback — the status icon smoothly transitions to a checkmark, the progress line completes, and the deployment URL appears. Professional delight, not a party.

### 9.8 Auto-Advancing Steps
**Problem**: Some wizards auto-advance to the next step after a selection (Discord does this after choosing server type). This removes user control and causes disorientation.
**Instead**: Always require explicit Next action. The user decides when to advance.

### 9.9 Tiny Modals for Complex Content
**Problem**: Using a 440px-wide modal (Discord/Slack size) for a wizard that includes a DAG canvas builder.
**Instead**: Start at 960×680 with resize capability. The DAG canvas needs real estate.

### 9.10 Losing State on Close
**Problem**: Closing the wizard and losing all configuration is unforgivable for a wizard this complex.
**Instead**: Prompt "Save as draft?" on close. Store wizard state in local storage. Offer "Resume setup" on next wizard open.

---

## Appendix A: CSS Animation Reference

```css
/* Step transition — forward */
.wizard-content-exit {
  transform: translateX(0);
  opacity: 1;
}
.wizard-content-exit-active {
  transform: translateX(-60px);
  opacity: 0;
  transition: transform 350ms cubic-bezier(0.4, 0, 0.2, 1),
              opacity 350ms cubic-bezier(0.4, 0, 0.2, 1);
}
.wizard-content-enter {
  transform: translateX(60px);
  opacity: 0;
}
.wizard-content-enter-active {
  transform: translateX(0);
  opacity: 1;
  transition: transform 350ms cubic-bezier(0.4, 0, 0.2, 1),
              opacity 350ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* Step transition — backward (reverse direction) */
.wizard-content-back-exit-active {
  transform: translateX(60px);
  opacity: 0;
}
.wizard-content-back-enter {
  transform: translateX(-60px);
  opacity: 0;
}

/* Modal open */
.wizard-modal-enter {
  transform: scale(0.95);
  opacity: 0;
}
.wizard-modal-enter-active {
  transform: scale(1);
  opacity: 1;
  transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1),
              opacity 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* Badge minimize */
.wizard-minimize {
  transition: transform 300ms cubic-bezier(0.4, 0, 0.2, 1),
              opacity 300ms cubic-bezier(0.4, 0, 0.2, 1),
              width 300ms cubic-bezier(0.4, 0, 0.2, 1),
              height 300ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

## Appendix B: Keyboard Shortcut Reference

| Shortcut | Action |
|----------|--------|
| `Tab` | Next field |
| `Shift+Tab` | Previous field |
| `Enter` | Activate Next button (when focused) |
| `Escape` | Close wizard (with confirmation) |
| `1`–`5` (when step indicator focused) | Jump to step |
| `Ctrl+Enter` | Submit/Next (from any field) |
| `Alt+←` | Previous step |
| `Alt+→` | Next step |

---

*Research conducted by Sana, EDOG Studio Hivemind — Architecture & UX Research*
*Sources: Web research across Stripe, Vercel, Linear, Notion, Figma, GitHub, AWS, Azure, GCP, Terraform Cloud, Railway, Render, CircleCI, Buildkite, Netlify, Slack, Discord, Shopify (2024–2025 product states)*
