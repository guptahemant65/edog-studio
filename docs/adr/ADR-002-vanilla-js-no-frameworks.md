# ADR-002: Vanilla JS Only — No Frontend Frameworks

## Status
ACCEPTED

**Date**: 2026-04-08
**Deciders**: Sana Reeves (Tech Lead), Kael Andersen (UX Lead), Zara Okonkwo (Sr. Frontend), Hemant Gupta (CEO)

## Context

EDOG Studio's frontend compiles to a single HTML file served by the C# EdogLogServer. We need to choose a frontend technology approach that works within this constraint.

The team has extensive experience with React, Vue, and other frameworks. The temptation to use them is real — they accelerate development of interactive UIs. But the single-file constraint creates a fundamental tension with framework-based development.

## Decision

We will use **vanilla JavaScript only** for the frontend. No React, Vue, Angular, Svelte, Preact, jQuery, Lit, or any other framework or library. No npm, no CDN scripts, no module bundlers.

Code organization uses class-based modules:
```javascript
class LogViewer {
    constructor(containerEl) { }
    addEntry(entry) { }
    _bindEvents() { }  // private: underscore prefix
}
```

Modules are concatenated by `build-html.py` in dependency order and inlined into the HTML file.

## Consequences

### Positive
- Zero framework churn: vanilla JS from 2024 works in 2034
- No build tooling beyond `build-html.py` — no webpack, no vite, no rollup
- Single-file output is straightforward — just concatenate and inline
- No framework abstractions hiding performance issues
- Smaller output size (no framework runtime overhead)
- Full control over DOM manipulation and rendering performance
- No supply chain risk from npm dependencies

### Negative
- Slower initial development (no JSX, no reactive bindings, no component library)
- More boilerplate for state management and DOM updates
- No virtual DOM diffing — manual DOM updates required
- Harder to attract developers who expect React/Vue
- No component devtools (React DevTools, Vue DevTools)

### Neutral
- Class-based modules provide reasonable code organization
- Virtual scroll, WebSocket handling, and event delegation are the same in vanilla or framework
- Browser DevTools work equally well (better, actually — no framework abstraction layer)

## Alternatives Considered

### React (with inline build)
**Summary**: Use React with a custom build step that inlines the bundle.
**Why rejected**: React's runtime is ~40KB minified. The component model adds abstraction that complicates single-file debugging. Virtual DOM diffing is unnecessary overhead for our use case — we know exactly which DOM nodes need updating.

### Preact
**Summary**: Lightweight React alternative (~3KB).
**Why rejected**: Still requires JSX compilation or `h()` calls. Still a dependency. Still adds an abstraction layer. If we're going to write code that manipulates the DOM, we should write code that manipulates the DOM.

### Lit (Web Components)
**Summary**: Google's lightweight web components library.
**Why rejected**: Web Components add Shadow DOM complexity. Styling across component boundaries becomes harder. Single-file inlining of web components has edge cases.

### Svelte (compile-away)
**Summary**: Svelte compiles to vanilla JS — no runtime.
**Why rejected**: Requires a Svelte compiler in the build pipeline. Adds npm dependency. The compiled output is harder to debug than hand-written vanilla JS.

## Related
- ADR-003: Single HTML File Output (the constraint that drives this decision)
- ENGINEERING_STANDARDS.md Section 3: Frontend Standards
- STYLE_GUIDE.md Section: JavaScript
