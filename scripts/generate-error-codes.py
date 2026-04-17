#!/usr/bin/env python3
"""Generate error-codes-data.js from FLT ErrorRegistry.cs or curated JSON fallback.

Part of F12 — Error Intelligence & Log Experience (C01 Build Pipeline).
Parses C# ErrorDefinition / ErrorInfo entries at build time and produces
a window.ERROR_CODES_DB JavaScript data file consumed by the runtime
error decoder (C02).

Usage:
    python scripts/generate-error-codes.py                    # curated-only
    python scripts/generate-error-codes.py --registry PATH    # parse C# + curated
    python scripts/generate-error-codes.py --dry-run          # validate only

Exit codes:
    0 = success
    1 = validation/schema error
    2 = IO error (file not found, permission denied)
    3 = parse error (C# file produced zero results)
    4 = internal error (uncaught exception)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_DIR = Path(__file__).resolve().parent.parent

EXIT_OK = 0
EXIT_VALIDATION = 1
EXIT_IO = 2
EXIT_PARSE = 3
EXIT_INTERNAL = 4

REQUIRED_FIELDS = {"title", "description", "category", "severity", "suggestedFix"}
VALID_CATEGORIES = {"USER", "SYSTEM"}
VALID_SEVERITIES = {"error", "warning", "info"}
CODE_PATTERN = re.compile(r"^(MLV|FLT|SPARK)_[A-Z][A-Z0-9_]+$")

# Regex: field-init pattern  — public static readonly ErrorDefinition X = new(...);
FIELD_INIT_RE = re.compile(
    r"public\s+static\s+readonly\s+ErrorDefinition\s+(\w+)\s*=\s*new\s*\("
    r"(.*?)\);",
    re.DOTALL,
)

# Regex: named arguments inside constructor body  — key: "value"
NAMED_ARG_RE = re.compile(
    r'(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|ErrorCategory\.\w+|true|false|null)',
    re.DOTALL,
)

# Regex: dictionary-init pattern  — ["CODE"] = new ErrorInfo(...)
DICT_INIT_RE = re.compile(
    r'\["(\w+)"\]\s*=\s*new\s+ErrorInfo\s*\((.*?)\)',
    re.DOTALL,
)

MAX_BODY_SIZE = 4096  # warn if single entry body exceeds this


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def log_info(msg: str) -> None:
    """Print informational message to stderr."""
    print(f"  {msg}", file=sys.stderr)


def log_warn(msg: str) -> None:
    """Print warning to stderr."""
    print(f"  WARNING: {msg}", file=sys.stderr)


def log_error(msg: str) -> None:
    """Print error to stderr."""
    print(f"  ERROR: {msg}", file=sys.stderr)


def strip_quotes(s: str) -> str:
    """Remove surrounding quotes and unescape C# strings."""
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        s = s[1:-1]
        s = s.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
    return s


def code_to_title(code: str) -> str:
    """MLV_SPARK_SESSION_ACQUISITION_FAILED -> Spark Session Acquisition Failed."""
    for prefix in ("MLV_", "FLT_", "SPARK_"):
        if code.startswith(prefix):
            code = code[len(prefix):]
            break
    return code.replace("_", " ").title()


def normalize_category(raw: str) -> str:
    """ErrorCategory.System -> SYSTEM, ErrorCategory.User -> USER."""
    raw = raw.strip().upper()
    raw = raw.replace("ERRORCATEGORY.", "")
    if raw in ("USER", "USERERROR", "USER_ERROR", "CONFIGURATION"):
        return "USER"
    return "SYSTEM"


def split_positional_args(body: str) -> list[str]:
    """Split on commas respecting string literals and parens."""
    args: list[str] = []
    depth = 0
    current: list[str] = []
    in_str = False
    prev = ""
    for ch in body:
        if ch == '"' and prev != "\\":
            in_str = not in_str
        if not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                args.append("".join(current).strip())
                current = []
                prev = ch
                continue
        current.append(ch)
        prev = ch
    if current:
        args.append("".join(current).strip())
    return args


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def parse_field_init(cs_content: str) -> list[dict]:
    """Parse ``public static readonly ErrorDefinition X = new(...);`` entries."""
    entries: list[dict] = []
    seen: set[str] = set()
    for m in FIELD_INIT_RE.finditer(cs_content):
        field_name = m.group(1)
        body = m.group(2)
        if len(body) > MAX_BODY_SIZE:
            log_warn(f"Entry '{field_name}' body exceeds {MAX_BODY_SIZE} bytes")
        args = {k: strip_quotes(v) for k, v in NAMED_ARG_RE.findall(body)}
        code = args.get("code", field_name)
        if code in seen:
            log_warn(f"duplicate code '{code}' — overwriting")
        seen.add(code)
        category_raw = args.get("category", "SYSTEM")
        if category_raw.upper().replace("ERRORCATEGORY.", "") not in (
            "USER", "USERERROR", "USER_ERROR", "CONFIGURATION", "SYSTEM",
            "INTERNAL", "INFRASTRUCTURE",
        ):
            log_warn(f"'{code}': unknown category '{category_raw}', defaulting to SYSTEM")
        entries.append({
            "code": code,
            "title": code_to_title(code),
            "description": args.get("description", ""),
            "category": normalize_category(category_raw),
            "severity": "error",
            "suggestedFix": args.get("suggestedFix", ""),
            "retryable": args.get("retryable", "false") == "true",
            "runbookUrl": args.get("runbookUrl") if args.get("runbookUrl") != "null" else None,
        })
    return entries


def build_entry_from_positional(code: str, args: list[str]) -> dict:
    """Map positional args: (description, category, suggestedFix [, retryable])."""
    return {
        "code": code,
        "title": code_to_title(code),
        "description": strip_quotes(args[0]) if len(args) > 0 else "",
        "category": normalize_category(args[1]) if len(args) > 1 else "SYSTEM",
        "severity": "error",
        "suggestedFix": strip_quotes(args[2]) if len(args) > 2 else "",
        "retryable": strip_quotes(args[3]).lower() == "true" if len(args) > 3 else False,
        "runbookUrl": None,
    }


def build_entry_from_named(code: str, named: dict[str, str]) -> dict:
    """Build entry from named argument dict."""
    return {
        "code": code,
        "title": code_to_title(code),
        "description": named.get("description", ""),
        "category": normalize_category(named.get("category", "SYSTEM")),
        "severity": "error",
        "suggestedFix": named.get("suggestedFix", ""),
        "retryable": named.get("retryable", "false") == "true",
        "runbookUrl": named.get("runbookUrl") if named.get("runbookUrl") != "null" else None,
    }


def parse_dict_init(cs_content: str) -> list[dict]:
    """Parse ``["CODE"] = new ErrorInfo(...)`` dictionary-init entries."""
    entries: list[dict] = []
    for m in DICT_INIT_RE.finditer(cs_content):
        code = m.group(1)
        body = m.group(2)
        named = {k: strip_quotes(v) for k, v in NAMED_ARG_RE.findall(body)}
        if named:
            entry = build_entry_from_named(code, named)
        else:
            positional = split_positional_args(body)
            if len(positional) < 1:
                log_warn(f"'{code}': no args in ErrorInfo constructor")
            entry = build_entry_from_positional(code, positional)
        entries.append(entry)
    return entries


def parse_cs_file(cs_content: str) -> dict[str, dict]:
    """Run both parsers, merge results (dict-init wins on conflict)."""
    field_entries = parse_field_init(cs_content)
    dict_entries = parse_dict_init(cs_content)

    merged: dict[str, dict] = {}
    for entry in field_entries:
        code = entry.pop("code")
        merged[code] = entry
    for entry in dict_entries:
        code = entry.pop("code")
        if code in merged:
            log_info(f"dict-init '{code}' overrides field-init entry")
        merged[code] = entry
    return merged


# ---------------------------------------------------------------------------
# Curated loader
# ---------------------------------------------------------------------------

def load_curated(curated_path: Path) -> dict[str, dict]:
    """Load curated error codes. Returns empty dict if file missing."""
    if not curated_path.exists():
        log_info(f"No curated file at {curated_path} — proceeding without")
        return {}
    try:
        with open(curated_path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        log_error(f"Malformed curated JSON: {curated_path}: {exc}")
        sys.exit(EXIT_IO)

    if not isinstance(data, dict):
        log_error(f"Curated file root must be an object: {curated_path}")
        sys.exit(EXIT_VALIDATION)

    return data.get("codes", {})


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def merge_codes(parsed: dict[str, dict], curated: dict[str, dict]) -> dict[str, dict]:
    """Merge parsed codes over curated. Parsed wins on conflict."""
    merged = dict(curated)
    for code, entry in parsed.items():
        if code in merged:
            log_info(f"parsed '{code}' overrides curated entry")
        merged[code] = entry
    return merged


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_entry(code: str, entry: dict) -> list[str]:
    """Returns list of validation errors (empty = valid)."""
    errors: list[str] = []

    if not CODE_PATTERN.match(code):
        errors.append(f"Code '{code}' does not match PREFIX_UPPER_SNAKE pattern")

    for field in REQUIRED_FIELDS:
        if field not in entry:
            errors.append(f"'{code}': missing required field '{field}'")
        elif not isinstance(entry[field], str):
            errors.append(f"'{code}.{field}': expected string, got {type(entry[field]).__name__}")
        elif not entry[field].strip():
            errors.append(f"'{code}.{field}': must not be empty/whitespace")

    cat = entry.get("category")
    if cat not in VALID_CATEGORIES:
        errors.append(f"'{code}.category': '{cat}' not in {VALID_CATEGORIES}")

    sev = entry.get("severity")
    if sev not in VALID_SEVERITIES:
        errors.append(f"'{code}.severity': '{sev}' not in {VALID_SEVERITIES}")

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

    title = entry.get("title", "")
    if isinstance(title, str) and len(title) > 100:
        errors.append(f"WARN: '{code}.title': exceeds 100 chars ({len(title)})")

    return errors


def validate_all(codes: dict[str, dict]) -> list[str]:
    """Validate entire code database. Returns all errors."""
    all_errors: list[str] = []
    for code, entry in codes.items():
        all_errors.extend(validate_entry(code, entry))

    # Cross-reference: relatedCodes should reference existing codes
    known = set(codes.keys())
    for code, entry in codes.items():
        for rel in entry.get("relatedCodes", []):
            if rel not in known:
                all_errors.append(
                    f"WARN: '{code}.relatedCodes': references unknown code '{rel}'"
                )
    return all_errors


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_output(codes: dict[str, dict], source: str, output_path: Path) -> None:
    """Write error-codes-data.js with window.ERROR_CODES_DB assignment."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    header = (
        "// AUTO-GENERATED by scripts/generate-error-codes.py — Do not edit manually\n"
        f"// Source: {source}\n"
        f"// Generated: {now}\n"
        f"// Error codes: {len(codes)}\n"
    )
    js_body = json.dumps(codes, indent=2, ensure_ascii=False)
    content = f"{header}window.ERROR_CODES_DB = {js_body};\n"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")
    log_info(f"Output: {output_path} ({len(codes)} codes, {len(content):,} bytes)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate error-codes-data.js from FLT ErrorRegistry.cs",
    )
    parser.add_argument(
        "--registry", "-r",
        type=Path,
        default=None,
        help="Path to ErrorRegistry.cs (optional; curated-only if omitted)",
    )
    parser.add_argument(
        "--curated", "-c",
        type=Path,
        default=PROJECT_DIR / "src" / "data" / "error-codes-curated.json",
        help="Path to curated error codes JSON (default: src/data/error-codes-curated.json)",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=PROJECT_DIR / "src" / "frontend" / "js" / "error-codes-data.js",
        help="Output JS file path (default: src/frontend/js/error-codes-data.js)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors (relatedCodes refs, long titles)",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip schema validation (dev/debug only)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print summary without writing output file",
    )
    args = parser.parse_args()

    # ----- Pipeline: parse -> load curated -> merge -> validate -> write -----

    parsed: dict[str, dict] = {}
    source_parts: list[str] = []

    # 1. Parse C# registry (if provided)
    if args.registry:
        if not args.registry.exists():
            log_error(f"Registry file not found: {args.registry}")
            sys.exit(EXIT_IO)
        try:
            cs_content = args.registry.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            log_error(f"Cannot read registry file: {exc}")
            sys.exit(EXIT_IO)
        parsed = parse_cs_file(cs_content)
        source_parts.append(f"{args.registry.name} (parsed {len(parsed)} codes)")
        log_info(f"Parsed: {len(parsed)} codes from {args.registry}")

        # Guard: non-trivial file produced zero codes
        if len(parsed) == 0:
            cs_size = args.registry.stat().st_size
            if cs_size > 100:
                log_error(
                    f"Parsed 0 codes from {args.registry} ({cs_size} bytes). "
                    "File may use an unrecognized pattern."
                )
                sys.exit(EXIT_PARSE)

    # 2. Load curated baseline
    curated = load_curated(args.curated)
    if curated:
        source_parts.append(f"curated ({len(curated)} codes)")
        log_info(f"Curated: {len(curated)} codes from {args.curated}")

    # 3. Merge (parsed wins on conflict)
    merged = merge_codes(parsed, curated)
    source = " + ".join(source_parts) if source_parts else "empty"
    log_info(f"Merged: {len(merged)} total codes (source: {source})")

    # 4. Validate
    if not args.skip_validation:
        errors = validate_all(merged)
        warnings = [e for e in errors if e.startswith("WARN")]
        hard_errors = [e for e in errors if not e.startswith("WARN")]
        if args.strict:
            hard_errors.extend(warnings)
            warnings = []
        for w in warnings:
            log_warn(w)
        if hard_errors:
            log_error(f"{len(hard_errors)} validation error(s):")
            for e in hard_errors:
                print(f"    - {e}", file=sys.stderr)
            sys.exit(EXIT_VALIDATION)

    # 5. Output
    if args.dry_run:
        log_info(f"DRY RUN: would write {len(merged)} codes to {args.output}")
        # Print summary to stdout for scripting
        print(json.dumps({"count": len(merged), "codes": sorted(merged.keys())}, indent=2))
        sys.exit(EXIT_OK)

    write_output(merged, source, args.output)
    log_info("Done.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        main()
    except json.JSONDecodeError as exc:
        log_error(f"Invalid JSON: {exc}")
        sys.exit(EXIT_IO)
    except FileNotFoundError as exc:
        log_error(f"File not found: {exc}")
        sys.exit(EXIT_IO)
    except PermissionError as exc:
        log_error(f"Permission denied: {exc}")
        sys.exit(EXIT_IO)
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as exc:
        log_error(f"Internal error: {exc}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(EXIT_INTERNAL)
