# Feature 12: Error Code Decoder

> **Phase:** V1.1
> **Status:** Not Started
> **Owner:** Zara Okonkwo (JS) + Ren Aoki (Build)
> **Spec:** docs/specs/features/F12-error-code-decoder.md
> **Design Ref:** docs/specs/design-spec-v2.md §12

### Problem

FLT error codes like `MLV_SPARK_SESSION_ACQUISITION_FAILED` appear in logs but engineers must grep the FLT codebase to find what they mean, whether they're user vs system errors, and what to try.

### Objective

Inline tooltips on known FLT error codes in log entries, showing human-readable description, error classification, and suggested fix. Error code lookup table generated at build time from `ErrorRegistry.cs`.

### Owner

**Primary:** Zara Okonkwo (JS tooltip rendering) + Ren Aoki (build script for JSON generation)
**Reviewers:** Dev Patel (error code accuracy)

### Inputs

- `ErrorRegistry.cs` from FLT repo — contains all error codes with message templates
- Build-time: Python script to parse C# file → generate `error-codes.json`
- Runtime: `renderer.js` matches error code patterns in log messages

### Outputs

- **Files created:**
  - `scripts/generate-error-codes.py` — Parse ErrorRegistry.cs → JSON lookup
  - `src/frontend/js/error-decoder.js` — Runtime error code matching + tooltip rendering
- **Files modified:**
  - `src/frontend/js/renderer.js` — Call error decoder on each log entry
  - `scripts/build-html.py` — Include error codes JSON in build output

### Acceptance Criteria

- [ ] Known FLT error codes in log messages are underlined/highlighted
- [ ] Hovering shows tooltip: error message, user/system classification, suggested fix
- [ ] Error codes work in both log entries and detail panel
- [ ] Build script generates `error-codes.json` from `ErrorRegistry.cs`
- [ ] Error codes JSON included in the single HTML file output
- [ ] Gracefully handles unknown error codes (no highlighting, no crash)

### Dependencies

- Access to FLT repo's `ErrorRegistry.cs` at build time

### Risks

Minor. ErrorRegistry.cs is static. Parsing is straightforward regex.

### Moonshot Vision

V2+: Link error codes to runbooks. Show error frequency trends. Suggest code changes based on error patterns.

