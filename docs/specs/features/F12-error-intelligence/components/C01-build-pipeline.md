# C01 — Error Code Build Pipeline

> **Component ID:** C01
> **Feature:** F12 — Error Intelligence & Log Experience
> **Phase:** P0 (Foundation)
> **Owner:** Vex
> **Priority:** P0 — blocking for all downstream F12 components
> **New file:** `scripts/generate-error-codes.py`
> **Output artifact:** `src/frontend/js/error-codes-data.js`
> **Spec ref:** `docs/specs/features/F12-error-intelligence/spec.md` §5 C01
> **Research ref:** `docs/specs/features/F12-error-intelligence/research/p0-foundation.md` §2

---

## 1. Overview

Parse FLT's `ErrorRegistry.cs` at build time and produce a `window.ERROR_CODES_DB` JavaScript data file that the runtime error decoder (C02) consumes. When `ErrorRegistry.cs` is unavailable (the normal case — it lives in the FLT repo, not edog-studio), fall back to a curated JSON baseline shipped in-tree. The generated JS file slots into the existing `build-html.py` module list and is inlined into the single-file HTML output.

---

## 2. Scenarios

### S01 — Parse ErrorRegistry.cs (Field-Init Pattern)

**ID:** `C01-S01`
**One-liner:** Parse `new ErrorDefinition(...)` field-init style entries from ErrorRegistry.cs.

**Description:**
The primary C# source pattern uses named field initializers inside a `new ErrorDefinition(...)` constructor call. Each call defines one error code as a `public static readonly` field on the `ErrorRegistry` class. The parser extracts the field name (which IS the error code constant), then captures `code:`, `description:`, `category:`, `suggestedFix:`, and optional `retryable:` / `runbookUrl:` assignments from the constructor body. Multiple entries are separated by `;` at statement boundaries.

**Technical mechanism:**
```python
# Regex for field-init pattern
FIELD_INIT_RE = re.compile(
    r'public\s+static\s+readonly\s+ErrorDefinition\s+(\w+)\s*=\s*new\s*\('
    r'(.*?)\);',
    re.DOTALL
)

# Inside each match body, extract named args
NAMED_ARG_RE = re.compile(
    r'(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|ErrorCategory\.\w+|true|false|null)',
    re.DOTALL
)

def parse_field_init(cs_content: str) -> list[dict]:
    entries = []
    for m in FIELD_INIT_RE.finditer(cs_content):
        field_name = m.group(1)  # e.g. MLV_SPARK_SESSION_ACQUISITION_FAILED
        body = m.group(2)
        args = {k: strip_quotes(v) for k, v in NAMED_ARG_RE.findall(body)}
        entries.append({
            "code": args.get("code", field_name),
            "title": code_to_title(field_name),
            "description": args.get("description", ""),
            "category": normalize_category(args.get("category", "SYSTEM")),
            "severity": "error",  # default; overridable
            "suggestedFix": args.get("suggestedFix", ""),
            "retryable": args.get("retryable", "false") == "true",
            "runbookUrl": args.get("runbookUrl") if args.get("runbookUrl") != "null" else None,
        })
    return entries
```

**Source code path:**
- `scripts/generate-error-codes.py` — new file (this component)
- Reference pattern: `src/frontend/js/auto-detect.js:110` — existing error code regex

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| Constructor body spans 20+ lines | `re.DOTALL` handles multi-line. Max body size: 4KB per entry (log warning if exceeded). |
| String contains escaped quotes `\"` | `"(?:[^"\\]|\\.)*"` handles escaped sequences. |
| Trailing comma after last arg | NAMED_ARG_RE skips non-matching text between matches — trailing commas are noise. |
| `code:` arg missing | Falls back to the C# field name (the `public static readonly` identifier). |
| `category:` uses unlisted enum value | Maps unknown values to `"SYSTEM"` with a warning to stderr. |
| Empty description string `""` | Accepted — C02 shows "No description available" at runtime. |
| Duplicate field names | Last-wins with a `WARNING: duplicate code '{code}' — overwriting` to stderr. |

**Interactions:**
- **C02 (Error Decoder Runtime):** consumes `window.ERROR_CODES_DB` at page load
- **`build-html.py`:** includes `js/error-codes-data.js` in `JS_MODULES` list

**Revert/undo:** Remove `js/error-codes-data.js` from `JS_MODULES` in `build-html.py`. C02 must handle missing `window.ERROR_CODES_DB` gracefully (empty dict).

**Priority:** P0

---

### S02 — Parse ErrorRegistry.cs (Dictionary-Init Pattern)

**ID:** `C01-S02`
**One-liner:** Parse dictionary-style `["CODE"] = new ErrorInfo(...)` entries from ErrorRegistry.cs.

**Description:**
An alternative C# pattern uses a static `Dictionary<string, ErrorInfo>` with bracket-keyed initializers. Each entry is `["MLV_CODE"] = new ErrorInfo("description", ErrorCategory.System, "fix")`. The parser must handle both positional and named arguments. This pattern and S01 can coexist in the same file — the parser runs both strategies and merges results.

**Technical mechanism:**
```python
DICT_INIT_RE = re.compile(
    r'\["(\w+)"\]\s*=\s*new\s+ErrorInfo\s*\((.*?)\)',
    re.DOTALL
)

def parse_dict_init(cs_content: str) -> list[dict]:
    entries = []
    for m in DICT_INIT_RE.finditer(cs_content):
        code = m.group(1)
        body = m.group(2)
        # Try named args first, fall back to positional
        named = {k: strip_quotes(v) for k, v in NAMED_ARG_RE.findall(body)}
        if named:
            entry = build_entry_from_named(code, named)
        else:
            positional = split_positional_args(body)
            entry = build_entry_from_positional(code, positional)
        entries.append(entry)
    return entries

def split_positional_args(body: str) -> list[str]:
    """Split on commas respecting string literals and parens."""
    args, depth, current, in_str = [], 0, [], False
    for ch in body:
        if ch == '"' and (not current or current[-1] != '\\'):
            in_str = not in_str
        if not in_str:
            if ch == '(':  depth += 1
            elif ch == ')':  depth -= 1
            elif ch == ',' and depth == 0:
                args.append(''.join(current).strip())
                current = []
                continue
        current.append(ch)
    if current:
        args.append(''.join(current).strip())
    return args

def build_entry_from_positional(code: str, args: list[str]) -> dict:
    """Map positional args: (description, category, suggestedFix [, retryable])."""
    return {
        "code": code,
        "title": code_to_title(code),
        "description": strip_quotes(args[0]) if len(args) > 0 else "",
        "category": normalize_category(args[1]) if len(args) > 1 else "SYSTEM",
        "severity": "error",
        "suggestedFix": strip_quotes(args[2]) if len(args) > 2 else "",
        "retryable": strip_quotes(args[3]) == "true" if len(args) > 3 else False,
        "runbookUrl": None,
    }
```

**Source code path:** `scripts/generate-error-codes.py` — `parse_dict_init()` function

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| Positional arg count < 1 | Emit warning; create entry with empty description. |
| String arg contains `,` | `split_positional_args` respects quotes — commas inside strings are safe. |
| Both patterns present in same file | Parser runs both, merges with dict-init winning on conflict (more explicit key). |
| `ErrorInfo` has different class name | CLI `--error-class` flag overrides default `ErrorInfo\|ErrorDefinition`. |

**Interactions:** Same as S01 — feeds into the merge pipeline.

**Revert/undo:** Same as S01.

**Priority:** P0

---

### S03 — Curated Fallback JSON

**ID:** `C01-S03`
**One-liner:** Ship a hand-maintained `error-codes-curated.json` for when ErrorRegistry.cs is unavailable.

**Description:**
Since `ErrorRegistry.cs` lives in the FLT repo (`workload-fabriclivetable`), not in edog-studio, the normal developer build will NOT have access to it. A curated JSON file at `src/data/error-codes-curated.json` contains manually documented error codes from team knowledge, documentation, and observed logs. When the parser runs without `--input`, it uses this curated file as the sole data source. When `--input` IS provided, curated entries are merged underneath parsed entries (parsed wins on conflict, curated fills gaps).

**Technical mechanism:**
```python
CURATED_PATH = PROJECT_DIR / "src" / "data" / "error-codes-curated.json"

def load_curated() -> dict:
    """Load curated error codes. Returns empty dict if file missing."""
    if not CURATED_PATH.exists():
        print("INFO: No curated error codes found, generating empty DB")
        return {}
    with open(CURATED_PATH, encoding="utf-8") as f:
        data = json.load(f)
    validate_schema(data)
    return data.get("codes", {})

def merge_codes(parsed: dict, curated: dict) -> dict:
    """Merge parsed codes over curated. Parsed wins on conflict."""
    merged = dict(curated)  # start with curated as base
    for code, entry in parsed.items():
        if code in merged:
            print(f"  MERGE: parsed '{code}' overrides curated entry")
        merged[code] = entry
    return merged
```

**File:** `src/data/error-codes-curated.json` — new file, committed to repo.

**Schema (curated file matches output schema):**
```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "version": "1.0",
  "generatedAt": null,
  "source": "manual-curation",
  "codes": {
    "MLV_SPARK_SESSION_ACQUISITION_FAILED": {
      "title": "Spark Session Acquisition Failed",
      "description": "Failed to acquire a Spark session for the materialized view refresh. The Spark pool may be at capacity or unavailable.",
      "category": "SYSTEM",
      "severity": "error",
      "suggestedFix": "Check Spark pool availability and capacity limits. Verify the workspace has sufficient CU allocation.",
      "retryable": true,
      "runbookUrl": null,
      "relatedCodes": ["MLV_SPARK_SESSION_TIMEOUT", "SPARK_POOL_EXHAUSTED"]
    }
  }
}
```

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| Curated file missing | Totally valid — generate empty `ERROR_CODES_DB = {}`. C02 handles this (pattern-match layer still works). |
| Curated file has invalid JSON | Exit with code 1 and clear error: `ERROR: Malformed curated JSON: {path}: {parse_error}`. |
| Curated file fails schema validation | Exit with code 1 listing every validation error. |
| Curated entry has extra unknown fields | Preserved in output (forward-compatible). |

**Interactions:**
- **C02:** Unknown codes without curated data still get dashed-underline "?" treatment via pattern matching (`/\b(MLV_\w+|FLT_\w+|SPARK_\w+)\b/`).
- **Developer workflow:** Team members add new codes to the curated file; rebuild picks them up.

**Revert/undo:** Delete `src/data/error-codes-curated.json`. Parser generates empty DB. C02 degrades to pattern-match-only mode.

**Priority:** P0

---

### S04 — JSON Schema Validation

**ID:** `C01-S04`
**One-liner:** Validate all error code entries against a strict schema before output.

**Description:**
Every entry — whether parsed from C# or loaded from curated JSON — passes through schema validation before being written to the output file. This catches malformed entries early (at build time) rather than letting broken data reach the runtime. Validation is implemented in pure Python without external schema libraries to keep the dependency footprint at zero. The validator checks required fields, type correctness, enum membership, and cross-references between `relatedCodes`.

**Technical mechanism:**
```python
REQUIRED_FIELDS = {"title", "description", "category", "severity", "suggestedFix"}
VALID_CATEGORIES = {"USER", "SYSTEM"}
VALID_SEVERITIES = {"error", "warning", "info"}
CODE_PATTERN = re.compile(r'^(MLV|FLT|SPARK)_[A-Z][A-Z0-9_]+$')

def validate_entry(code: str, entry: dict) -> list[str]:
    """Returns list of validation errors (empty = valid)."""
    errors = []

    # Code format
    if not CODE_PATTERN.match(code):
        errors.append(f"Code '{code}' does not match PREFIX_UPPER_SNAKE pattern")

    # Required fields
    for field in REQUIRED_FIELDS:
        if field not in entry:
            errors.append(f"'{code}': missing required field '{field}'")
        elif not isinstance(entry[field], str):
            errors.append(f"'{code}.{field}': expected string, got {type(entry[field]).__name__}")
        elif not entry[field].strip():
            errors.append(f"'{code}.{field}': must not be empty/whitespace")

    # Enum validation
    if entry.get("category") not in VALID_CATEGORIES:
        errors.append(f"'{code}.category': '{entry.get('category')}' not in {VALID_CATEGORIES}")
    if entry.get("severity") not in VALID_SEVERITIES:
        errors.append(f"'{code}.severity': '{entry.get('severity')}' not in {VALID_SEVERITIES}")

    # Optional field types
    if "retryable" in entry and not isinstance(entry["retryable"], bool):
        errors.append(f"'{code}.retryable': expected bool")
    if "runbookUrl" in entry and entry["runbookUrl"] is not None:
        if not isinstance(entry["runbookUrl"], str):
            errors.append(f"'{code}.runbookUrl': expected string or null")
    if "relatedCodes" in entry:
        if not isinstance(entry["relatedCodes"], list):
            errors.append(f"'{code}.relatedCodes': expected array")
        elif not all(isinstance(c, str) for c in entry["relatedCodes"]):
            errors.append(f"'{code}.relatedCodes': all items must be strings")

    return errors

def validate_all(codes: dict) -> list[str]:
    """Validate entire code database. Returns all errors."""
    all_errors = []
    for code, entry in codes.items():
        all_errors.extend(validate_entry(code, entry))

    # Cross-reference: relatedCodes should reference existing codes
    known = set(codes.keys())
    for code, entry in codes.items():
        for rel in entry.get("relatedCodes", []):
            if rel not in known:
                all_errors.append(
                    f"'{code}.relatedCodes': references unknown code '{rel}'"
                )
    return all_errors
```

**Source code path:** `scripts/generate-error-codes.py` — `validate_entry()`, `validate_all()`

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| `relatedCodes` references a code not in registry | Warning (not error) — the related code may exist in a future release. Use `--strict` to make it an error. |
| `suggestedFix` is empty string | Validation error — every code must have actionable fix text. |
| `title` exceeds 100 chars | Warning — titles should be concise for UI badge display. |
| Extra unrecognized fields in entry | Passed through without error (forward-compatibility). |

**Interactions:**
- Runs as final gate before `write_output()` — no output written if validation fails.
- `--skip-validation` flag bypasses (for development/debugging only).

**Revert/undo:** N/A — validation is stateless.

**Priority:** P0

---

### S05 — Output Generation (error-codes-data.js)

**ID:** `C01-S05`
**One-liner:** Write validated error codes as a `window.ERROR_CODES_DB` JavaScript file.

**Description:**
The final output is a JavaScript file at `src/frontend/js/error-codes-data.js` that assigns the error code database to `window.ERROR_CODES_DB`. This format was chosen over raw JSON because it integrates directly with the `build-html.py` `JS_MODULES` list — no separate embedding logic needed. The file includes a generation header with source metadata and timestamp. The JS object uses the error code string as key for O(1) lookup at runtime.

**Technical mechanism:**
```python
OUTPUT_PATH = PROJECT_DIR / "src" / "frontend" / "js" / "error-codes-data.js"

def write_output(codes: dict, source: str) -> None:
    """Write error-codes-data.js with window.ERROR_CODES_DB assignment."""
    header = (
        "// AUTO-GENERATED by scripts/generate-error-codes.py — Do not edit manually\n"
        f"// Source: {source}\n"
        f"// Generated: {datetime.utcnow().isoformat()}Z\n"
        f"// Error codes: {len(codes)}\n"
    )
    js_body = json.dumps(codes, indent=2, ensure_ascii=False)
    content = f"{header}window.ERROR_CODES_DB = {js_body};\n"

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(content, encoding="utf-8")

    print(f"  Output: {OUTPUT_PATH} ({len(codes)} codes, {len(content):,} bytes)")
```

**Generated file shape:**
```javascript
// AUTO-GENERATED by scripts/generate-error-codes.py — Do not edit manually
// Source: ErrorRegistry.cs (parsed) + error-codes-curated.json
// Generated: 2026-04-17T14:30:00Z
// Error codes: 42
window.ERROR_CODES_DB = {
  "MLV_SPARK_SESSION_ACQUISITION_FAILED": {
    "title": "Spark Session Acquisition Failed",
    "description": "Failed to acquire a Spark session...",
    "category": "SYSTEM",
    "severity": "error",
    "suggestedFix": "Check Spark pool availability...",
    "retryable": true,
    "runbookUrl": null,
    "relatedCodes": ["MLV_SPARK_SESSION_TIMEOUT"]
  },
  "MLV_SCHEMA_MISMATCH": {
    ...
  }
};
```

**Source code path:** `scripts/generate-error-codes.py` — `write_output()`

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| `src/frontend/js/` directory doesn't exist | `mkdir(parents=True)` creates it. |
| Output file already exists | Overwritten unconditionally (it's generated code). |
| Zero error codes | Valid — writes `window.ERROR_CODES_DB = {};`. C02 handles empty DB. |
| Code contains characters unsafe in JS | `json.dumps` with `ensure_ascii=False` produces valid JSON (which is valid JS literal). All strings are quoted. |
| File write fails (permissions, disk) | Exception propagates — build fails with traceback. |

**Interactions:**
- **`build-html.py`:** `error-codes-data.js` must be in `JS_MODULES` BEFORE `error-intel.js` and `error-decoder.js` (dependency order).
- **C02 (Error Decoder Runtime):** reads `window.ERROR_CODES_DB` at module init. If undefined, C02 initializes an empty dict.

**Revert/undo:** Delete `src/frontend/js/error-codes-data.js`. Remove from `JS_MODULES`. Rebuild.

**Priority:** P0

---

### S06 — build-html.py Integration

**ID:** `C01-S06`
**One-liner:** Wire `error-codes-data.js` into the build pipeline module list.

**Description:**
The existing `build-html.py` reads an ordered list of JS modules (`JS_MODULES`), concatenates them, and injects the result into `index.html`'s `/* __JS_MODULES__ */` placeholder. The error codes data file must be inserted early in the module order — after `mock-data.js` (which provides test data) and `state.js` (core state), but before any module that consumes error code data (`error-intel.js`, and the future `error-decoder.js` from C02). This is a surgical one-line addition to the list.

**Technical mechanism:**
```python
# In build-html.py, JS_MODULES list — insert after "js/state.js":
JS_MODULES = [
    "js/mock-data.js",
    "js/state.js",
    "js/error-codes-data.js",   # <-- ADD THIS LINE (C01 output)
    "js/signalr-manager.js",
    "js/api-client.js",
    # ... rest unchanged
]
```

**Source code path:** `scripts/build-html.py:68-104` — `JS_MODULES` list

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| `error-codes-data.js` doesn't exist yet | `build-html.py:read_file()` already prints `WARNING: Missing module: {path}` and injects a comment stub. Build succeeds; `window.ERROR_CODES_DB` is undefined; C02 handles gracefully. |
| Developer forgets to run `generate-error-codes.py` | Same as above — warning, no crash. Makefile should chain: `generate-error-codes` before `build`. |
| Module order wrong (after consumer) | `window.ERROR_CODES_DB` is `undefined` when C02 reads it. C02 must tolerate this (empty dict fallback). |

**Interactions:**
- **`Makefile`:** Add `generate-error-codes` target before `build` target.
- **`index.html`:** No changes needed — the `/* __JS_MODULES__ */` placeholder handles all JS.

**Revert/undo:** Remove the one line from `JS_MODULES`. Rebuild.

**Priority:** P0

---

### S07 — CLI Interface

**ID:** `C01-S07`
**One-liner:** Full CLI with `--input`, `--output`, `--curated`, `--strict`, and `--skip-validation` flags.

**Description:**
The script is invoked from the command line with flexible options to support multiple workflows: CI builds with FLT repo access, local developer builds without it, and one-off code additions. The CLI uses `argparse` with sensible defaults so that a bare `python scripts/generate-error-codes.py` (no args) produces a valid output using only the curated fallback. All paths default relative to the project root.

**Technical mechanism:**
```python
def main():
    parser = argparse.ArgumentParser(
        description="Generate error-codes-data.js from FLT ErrorRegistry.cs"
    )
    parser.add_argument(
        "--input", "-i",
        type=Path,
        default=None,
        help="Path to ErrorRegistry.cs (optional; uses curated-only if omitted)"
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=PROJECT_DIR / "src" / "frontend" / "js" / "error-codes-data.js",
        help="Output JS file path (default: src/frontend/js/error-codes-data.js)"
    )
    parser.add_argument(
        "--curated", "-c",
        type=Path,
        default=PROJECT_DIR / "src" / "data" / "error-codes-curated.json",
        help="Path to curated error codes JSON (default: src/data/error-codes-curated.json)"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors (relatedCodes refs, long titles)"
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip schema validation (dev/debug only)"
    )
    parser.add_argument(
        "--error-class",
        type=str,
        default="ErrorInfo|ErrorDefinition",
        help="C# class name regex for error entries (default: ErrorInfo|ErrorDefinition)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print stats without writing output"
    )
    args = parser.parse_args()

    # Pipeline: parse → load curated → merge → validate → write
    parsed = {}
    source_parts = []

    if args.input:
        if not args.input.exists():
            print(f"ERROR: Input file not found: {args.input}", file=sys.stderr)
            sys.exit(1)
        cs_content = args.input.read_text(encoding="utf-8")
        parsed = parse_cs_file(cs_content, args.error_class)
        source_parts.append(f"{args.input.name} (parsed {len(parsed)} codes)")
        print(f"  Parsed: {len(parsed)} codes from {args.input}")

    curated = load_curated(args.curated)
    if curated:
        source_parts.append(f"curated ({len(curated)} codes)")
        print(f"  Curated: {len(curated)} codes from {args.curated}")

    merged = merge_codes(parsed, curated)
    source = " + ".join(source_parts) if source_parts else "empty"
    print(f"  Merged: {len(merged)} total codes (source: {source})")

    if not args.skip_validation:
        errors = validate_all(merged)
        warnings = [e for e in errors if e.startswith("WARN")]
        hard_errors = [e for e in errors if not e.startswith("WARN")]
        if args.strict:
            hard_errors.extend(warnings)
            warnings = []
        for w in warnings:
            print(f"  {w}", file=sys.stderr)
        if hard_errors:
            print(f"\nERROR: {len(hard_errors)} validation errors:", file=sys.stderr)
            for e in hard_errors:
                print(f"  - {e}", file=sys.stderr)
            sys.exit(1)

    if args.dry_run:
        print(f"\n  DRY RUN: would write {len(merged)} codes to {args.output}")
        sys.exit(0)

    write_output(merged, source, args.output)
    print("  Done!")
```

**Usage examples:**
```bash
# Normal dev build — curated-only (no FLT repo access)
python scripts/generate-error-codes.py

# CI build with FLT repo cloned alongside
python scripts/generate-error-codes.py --input ../workload-fabriclivetable/src/ErrorRegistry.cs

# Custom output path
python scripts/generate-error-codes.py -o src/frontend/js/error-codes-data.js

# Strict mode for CI
python scripts/generate-error-codes.py --input path/to/ErrorRegistry.cs --strict

# Dry run to check parsing
python scripts/generate-error-codes.py --input path/to/ErrorRegistry.cs --dry-run

# Override error class name (if FLT uses a different class)
python scripts/generate-error-codes.py --input path/to/ErrorRegistry.cs --error-class "FltErrorDef"
```

**Source code path:** `scripts/generate-error-codes.py` — `main()`

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| `--input` path doesn't exist | Exit code 1 with clear message. |
| `--input` is not a `.cs` file | Warning to stderr; still attempt parse (might be valid). |
| No `--input` and no curated file | Valid — writes empty `ERROR_CODES_DB = {}`. |
| `--output` path is read-only | Exception propagates with traceback. |
| Both `--input` and `--curated` produce zero codes | Valid — empty DB. |

**Interactions:**
- **Makefile:** `generate-error-codes` target invokes this script.
- **CI pipeline:** Invoked with `--strict` flag.

**Revert/undo:** N/A — CLI is the entry point.

**Priority:** P0

---

### S08 — Error Handling & Exit Codes

**ID:** `C01-S08`
**One-liner:** Deterministic exit codes and human-readable error messages for all failure modes.

**Description:**
The script uses a clear exit code convention so CI pipelines and Makefiles can react appropriately. All errors go to stderr; progress/success goes to stdout. The script never silently swallows errors — every parse failure, validation error, or I/O problem produces a visible message. In non-strict mode, warnings are printed but don't block output generation.

**Technical mechanism:**
```python
# Exit codes
EXIT_OK = 0
EXIT_VALIDATION = 1    # Schema validation failed
EXIT_IO = 2            # File not found, permission denied, etc.
EXIT_PARSE = 3         # C# parse produced zero results from a non-empty file
EXIT_INTERNAL = 4      # Unexpected exception

def main():
    try:
        # ... pipeline ...
        pass
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in curated file: {e}", file=sys.stderr)
        sys.exit(EXIT_IO)
    except FileNotFoundError as e:
        print(f"ERROR: File not found: {e}", file=sys.stderr)
        sys.exit(EXIT_IO)
    except PermissionError as e:
        print(f"ERROR: Permission denied: {e}", file=sys.stderr)
        sys.exit(EXIT_IO)
    except Exception as e:
        print(f"INTERNAL ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(EXIT_INTERNAL)
```

**Parse-zero guard:**
```python
if args.input and len(parsed) == 0:
    cs_size = args.input.stat().st_size
    if cs_size > 100:  # non-trivial file produced zero codes
        print(
            f"ERROR: Parsed 0 codes from {args.input} ({cs_size} bytes). "
            "File may use an unrecognized pattern. "
            "Use --error-class to specify the C# class name.",
            file=sys.stderr
        )
        sys.exit(EXIT_PARSE)
```

**Source code path:** `scripts/generate-error-codes.py` — `main()` exception handling

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| C# file is valid but uses unknown pattern | `EXIT_PARSE` (3) with actionable message pointing to `--error-class`. |
| C# file is binary (not text) | `UnicodeDecodeError` caught → `EXIT_IO` (2). |
| Keyboard interrupt during run | Python default `KeyboardInterrupt` — exit 130. |
| Curated JSON is empty object `{}` | Valid — `codes` key missing treated as no codes. |

**Interactions:**
- **Makefile:** Checks exit code; `make build` fails if `generate-error-codes` returns non-zero.
- **CI:** `--strict` mode ensures warnings become exit code 1.

**Revert/undo:** N/A — error handling is internal behavior.

**Priority:** P0

---

### S09 — Makefile Integration

**ID:** `C01-S09`
**One-liner:** Add `generate-error-codes` Make target wired before `build`.

**Description:**
The Makefile gains a new `generate-error-codes` target that runs the script with default settings (curated-only). The existing `build` target gains a dependency on `generate-error-codes` so that error codes are always regenerated before the HTML is assembled. A `generate-error-codes-ci` target runs with `--strict` for CI use. This ensures the build pipeline always has fresh error code data without developers needing to remember a separate step.

**Technical mechanism:**
```makefile
# In Makefile — new targets:

generate-error-codes:   ## Generate error-codes-data.js from curated JSON
	$(PYTHON) scripts/generate-error-codes.py

generate-error-codes-ci:   ## Generate error-codes-data.js (strict mode for CI)
	$(PYTHON) scripts/generate-error-codes.py --strict

# Modify existing build target to depend on generate-error-codes:
build: generate-error-codes   ## Build single-file HTML
	$(PYTHON) scripts/build-html.py
```

**Source code path:** `Makefile` — add targets, modify `build` dependency

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| Script not found | Make reports missing script; build fails. |
| Python not installed | `$(PYTHON)` variable should resolve or fail with clear message. |
| Curated JSON hasn't been created yet | Script generates empty DB; build continues (see S03). |

**Interactions:**
- **`build` target:** Now implicitly runs error code generation.
- **CI pipeline:** Uses `generate-error-codes-ci` or passes `--strict` explicitly.

**Revert/undo:** Remove targets from Makefile. Remove dependency from `build`.

**Priority:** P0

---

### S10 — Hot Reload Developer Workflow

**ID:** `C01-S10`
**One-liner:** Developers edit curated JSON, run `make build`, and see updated error codes in browser.

**Description:**
The developer workflow for adding or updating error codes is: (1) edit `src/data/error-codes-curated.json`, (2) run `make build` (which chains `generate-error-codes` → `build-html.py`), (3) reload the browser. For faster iteration during development, the developer can also run `python scripts/generate-error-codes.py --dry-run` to validate changes without a full rebuild. The future `--watch` mode in `build-html.py` (noted in its docstring) would chain through to regenerate error codes on curated file changes.

**Technical mechanism:**
```
Developer flow:
  1. Edit src/data/error-codes-curated.json  (add/modify error code entry)
  2. Run: make build                          (chains generate-error-codes → build-html.py)
  3. Reload browser                           (single-file HTML has new codes)

Fast validation flow:
  1. Edit src/data/error-codes-curated.json
  2. Run: python scripts/generate-error-codes.py --dry-run
  3. Fix any validation errors
  4. Run: make build

Future watch flow (when build-html.py --watch is implemented):
  1. Terminal: make watch
  2. Edit src/data/error-codes-curated.json
  3. Auto-rebuild triggered → browser auto-reloads (if connected)
```

**Source code path:** N/A — workflow, not code

**Edge cases:**
| Condition | Behavior |
|-----------|----------|
| Developer edits error-codes-data.js directly | Overwritten on next `make build`. Header comment warns: "Do not edit manually". |
| Developer adds code with typo in category | Validation catches it on next build. |
| Two developers edit curated JSON simultaneously | Normal Git merge conflict on the JSON file — standard resolution. |

**Interactions:**
- **`build-html.py`:** Downstream consumer of the generated file.
- **C02 (Error Decoder):** Sees updated codes after page reload.

**Revert/undo:** `git checkout src/data/error-codes-curated.json && make build`

**Priority:** P1

---

## 3. Data Structures

### 3.1 error-codes.json Schema (Canonical)

This is the canonical schema for the error code database. Both the curated input file and the generated output conform to this structure. The top-level object wraps metadata around the `codes` dictionary.

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "codes"],
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+$",
      "description": "Schema version (semver major.minor)"
    },
    "generatedAt": {
      "type": ["string", "null"],
      "format": "date-time",
      "description": "ISO 8601 timestamp of generation (null for curated)"
    },
    "source": {
      "type": "string",
      "description": "Human-readable source description"
    },
    "codes": {
      "type": "object",
      "patternProperties": {
        "^(MLV|FLT|SPARK)_[A-Z][A-Z0-9_]+$": {
          "type": "object",
          "required": ["title", "description", "category", "severity", "suggestedFix"],
          "properties": {
            "title":        { "type": "string", "minLength": 1 },
            "description":  { "type": "string", "minLength": 1 },
            "category":     { "type": "string", "enum": ["USER", "SYSTEM"] },
            "severity":     { "type": "string", "enum": ["error", "warning", "info"] },
            "suggestedFix": { "type": "string", "minLength": 1 },
            "retryable":    { "type": "boolean" },
            "runbookUrl":   { "type": ["string", "null"] },
            "relatedCodes": {
              "type": "array",
              "items": { "type": "string" }
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": false
    }
  }
}
```

### 3.2 Output JS Shape

The generated `error-codes-data.js` is NOT wrapped in the metadata envelope. It assigns the flat `codes` dictionary directly to `window.ERROR_CODES_DB` for O(1) runtime lookup:

```javascript
window.ERROR_CODES_DB = {
  "MLV_SPARK_SESSION_ACQUISITION_FAILED": { title, description, category, severity, suggestedFix, ... },
  "FLT_CONFIG_VALIDATION_FAILED": { ... },
  ...
};
```

C02 accesses: `const info = window.ERROR_CODES_DB["MLV_SPARK_SESSION_ACQUISITION_FAILED"]`

---

## 4. Helper Functions

### 4.1 code_to_title

Converts `SCREAMING_SNAKE_CASE` codes to human-readable titles by stripping the prefix and title-casing.

```python
def code_to_title(code: str) -> str:
    """MLV_SPARK_SESSION_ACQUISITION_FAILED → Spark Session Acquisition Failed"""
    # Strip known prefix
    for prefix in ("MLV_", "FLT_", "SPARK_"):
        if code.startswith(prefix):
            code = code[len(prefix):]
            break
    return code.replace("_", " ").title()
```

### 4.2 normalize_category

Maps C# enum values to the JSON schema's `USER` / `SYSTEM` enum.

```python
def normalize_category(raw: str) -> str:
    """ErrorCategory.System → SYSTEM, ErrorCategory.User → USER"""
    raw = raw.strip().upper()
    raw = raw.replace("ERRORCATEGORY.", "")
    if raw in ("USER", "USERERROR", "USER_ERROR", "CONFIGURATION"):
        return "USER"
    return "SYSTEM"  # default for SYSTEM, INTERNAL, INFRASTRUCTURE, unknown
```

### 4.3 strip_quotes

Removes surrounding double quotes and unescapes C# string escape sequences.

```python
def strip_quotes(s: str) -> str:
    """Remove surrounding quotes and unescape C# strings."""
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        s = s[1:-1]
        s = s.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
    return s
```

---

## 5. File Layout (After Implementation)

```
edog-studio/
  scripts/
    generate-error-codes.py     # NEW — this component (C01)
    build-html.py               # MODIFIED — add error-codes-data.js to JS_MODULES
  src/
    data/
      error-codes-curated.json  # NEW — hand-maintained baseline
    frontend/
      js/
        error-codes-data.js     # GENERATED — do not edit (gitignored)
        error-decoder.js        # C02 (consumes ERROR_CODES_DB)
        error-intel.js          # Existing (enhanced by C07)
  Makefile                      # MODIFIED — add generate-error-codes target
  .gitignore                    # MODIFIED — add src/frontend/js/error-codes-data.js
```

---

## 6. .gitignore Entry

The generated file should NOT be committed. Add:

```gitignore
# Generated by scripts/generate-error-codes.py
src/frontend/js/error-codes-data.js
```

The curated source (`src/data/error-codes-curated.json`) IS committed.

---

## 7. Testing Strategy

### 7.1 Unit Tests (Python)

Test file: `tests/test_generate_error_codes.py`

| Test | What it verifies |
|------|-----------------|
| `test_parse_field_init_single` | Parses one `ErrorDefinition` entry correctly |
| `test_parse_field_init_multiple` | Parses 5+ entries, all fields extracted |
| `test_parse_field_init_multiline` | Body spanning 10+ lines works |
| `test_parse_dict_init_named` | Dictionary pattern with named args |
| `test_parse_dict_init_positional` | Dictionary pattern with positional args |
| `test_parse_mixed_patterns` | Both patterns in same file |
| `test_parse_escaped_strings` | `\"`, `\n`, `\\` in descriptions |
| `test_parse_empty_file` | Returns empty dict, no crash |
| `test_parse_no_matches` | Non-ErrorRegistry C# file returns empty dict |
| `test_merge_curated_wins_gaps` | Curated fills codes not in parsed |
| `test_merge_parsed_wins_conflicts` | Parsed overrides curated on same code |
| `test_validate_valid_entry` | Fully valid entry passes |
| `test_validate_missing_required_field` | Each required field absence produces error |
| `test_validate_bad_category` | Invalid category string rejected |
| `test_validate_bad_severity` | Invalid severity string rejected |
| `test_validate_bad_code_format` | Code not matching pattern rejected |
| `test_validate_related_codes_warning` | Unknown relatedCodes produces warning |
| `test_validate_empty_suggested_fix` | Empty suggestedFix rejected |
| `test_code_to_title` | Prefix stripping and title-casing |
| `test_normalize_category_variants` | All known category strings normalize correctly |
| `test_output_is_valid_js` | Generated file is syntactically valid JavaScript |
| `test_output_empty_db` | Zero codes produces `window.ERROR_CODES_DB = {};` |
| `test_cli_no_args` | Bare invocation works (curated-only or empty) |
| `test_cli_missing_input` | `--input nonexistent` → exit code 2 |
| `test_cli_dry_run` | `--dry-run` writes nothing |
| `test_cli_strict_mode` | Warnings become errors with `--strict` |

### 7.2 Integration Test

```bash
# Generate from curated, build HTML, verify embedding
python scripts/generate-error-codes.py
python scripts/build-html.py
grep -q "ERROR_CODES_DB" src/edog-logs.html && echo "PASS" || echo "FAIL"
```

---

## 8. Performance Constraints

| Metric | Target | Rationale |
|--------|--------|-----------|
| Parse time (500 entries) | < 500ms | Blocking build step — must be fast |
| Output file size (500 entries) | < 200KB | Inlined in HTML — affects page load |
| Memory usage | < 50MB | Runs on dev laptops |
| Startup time (Python) | < 1s | Developer experience |

---

## 9. Security Considerations

- **No code execution:** The parser uses regex, not `eval()` or `exec()`. C# source is treated as plain text.
- **No network access:** The script is fully offline. All inputs are local files.
- **XSS prevention:** Output is `json.dumps()` which escapes all special characters. Values like `</script>` in error descriptions are escaped to `<\/script>` by `json.dumps` (Python's `json` module escapes `/` in `</` contexts when used with `ensure_ascii`). Double-check: use a post-processing step to escape `</script` → `<\/script` if `ensure_ascii=False`.
- **No secrets:** Error codes, descriptions, and fix text are not sensitive data.

```python
def escape_script_close(js_content: str) -> str:
    """Prevent </script> injection in inline JS."""
    return js_content.replace("</script", "<\\/script")
```

---

## 10. Dependencies

- **Python 3.9+** — already required by project (pathlib, type hints)
- **Standard library only** — `json`, `re`, `argparse`, `pathlib`, `sys`, `datetime`
- **Zero external packages** — no pip install needed

---

## 11. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | JSON file vs JS file output? | **JS file** — `window.ERROR_CODES_DB = {...}` slots directly into `JS_MODULES`. No separate embedding logic. (per §2.4 of P0 research) |
| 2 | Where in `JS_MODULES` order? | After `state.js`, before `error-intel.js`. Data must exist before consumers. |
| 3 | Should generated file be committed? | **No** — gitignored. Curated source IS committed. Build regenerates. |
| 4 | What if curated JSON and parsed have same code? | Parsed wins (fresher from source). Logged to stdout. |
| 5 | `additionalProperties` in schema? | `true` on entries (forward-compatible), `false` on `codes` keys (must match pattern). |
