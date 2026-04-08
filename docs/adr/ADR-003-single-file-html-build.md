# ADR-003: Single HTML File Output via build-html.py

## Status
ACCEPTED

**Date**: 2026-04-08
**Deciders**: Sana Reeves (Tech Lead), Ren Aoki (Build Engineer), Hemant Gupta (CEO)

## Context

EDOG Studio's frontend needs to be served by the C# EdogLogServer running inside the FLT service process. The server needs to serve the UI without managing static file directories, asset paths, or content-type routing.

We need a distribution format that is:
- Trivially servable (one file, one HTTP response)
- Self-contained (works without internet, CDN, or package servers)
- Debuggable (viewable in browser via `file://` during development)
- Maintainable (developers work with modular source files, not one giant file)

## Decision

We will compile the frontend to a **single self-contained HTML file** using a Python build script (`build-html.py`).

The build process:
1. Read `src/edog-logs/index.html` as the template
2. Concatenate all CSS files from `src/edog-logs/css/` in dependency order
3. Inline the concatenated CSS into `<style>` blocks
4. Concatenate all JS files from `src/edog-logs/js/` in dependency order
5. Inline the concatenated JS into `<script>` blocks
6. Write the result to `src/edog-logs.html`

The output file has **zero external dependencies** — no `<link>` stylesheets, no `<script src="">`, no CDN references, no image URLs.

## Consequences

### Positive
- C# server implementation is trivial: read file, send response, done
- Works when opened as `file://` — developers can preview without running the server
- No CORS issues, no asset loading failures, no 404s for missing resources
- Deployment is copying one file
- No CDN dependency — works on air-gapped networks
- Build is fast (< 2 seconds) — no compilation, just concatenation

### Negative
- Developers must run `build-html.py` after every frontend change
- Module ordering in the build script is critical and manual
- No hot-reload during development (must rebuild + refresh)
- File size grows linearly with features (currently manageable, watch for bloat)
- No code splitting or lazy loading — everything loads upfront
- Images must be inline (data: URIs or SVG) — no external image files

### Neutral
- Build script is ~50 lines of Python — simple enough to understand in minutes
- Source files remain modular — developers edit individual `.css` and `.js` files
- The compiled output is human-readable (not minified) for debugging

## Alternatives Considered

### Static File Server (Serve Directory)
**Summary**: EdogLogServer serves `src/edog-logs/` as a static file directory.
**Why rejected**: Adds complexity to the C# server (content-type routing, 404 handling, path traversal security). Makes deployment a directory copy instead of a file copy. Creates runtime dependencies on file paths.

### Webpack/Vite Bundle
**Summary**: Use a standard JS bundler to produce the output.
**Why rejected**: Adds npm as a build dependency. Build configuration is complex. Output is minified and hard to debug. Framework dependency through the back door.

### Python HTTP Server (Serve Files)
**Summary**: Let the Python backend serve frontend files directly.
**Why rejected**: The UI needs to be servable by the C# EdogLogServer in the FLT process. Adding a Python server dependency for serving static files creates an unnecessary moving part.

## Related
- ADR-002: Vanilla JS Only (enabled by this single-file approach)
- ENGINEERING_STANDARDS.md Section 2: Build System
- Ren Aoki owns `build-html.py`
