"""FLT API catalog extractor.

Scans the FabricLiveTable C# source for ASP.NET controllers and produces a
JSON-serializable catalog of HTTP endpoints for the API Playground.

Pure-function module: no I/O outside of file reads, no global state.
Parses C# attribute syntax via regex. Tolerant of formatting variations
within the FLT codebase (which is consistent thanks to .editorconfig + StyleCop).

Output shape:
    {
        "endpoints": [
            {
                "id": "get-livetable-getlatestdag",
                "name": "Get Latest Dag",
                "method": "GET",
                "urlTemplate": "/liveTable/getLatestDag",
                "fullPath": "/v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable/getLatestDag",
                "group": "liveTable",
                "tokenType": "mwc",
                "controller": "LiveTableController",
                "description": "Gets the latest Dag for given lakehouse.",
                "queryParams": ["showExtendedLineage"],
                "dangerLevel": "safe",
                "bodyTemplate": null,
                "kind": "rest",          # F09 SF-001
                "source": "controller",  # F09 SF-001
            },
            ...
        ],
        "groups": ["liveTable", "liveTableMaintanance", "liveTableSchedule", ...],
        "source": "C:/.../workload-fabriclivetable",
        "extractedAt": "2026-05-15T13:45:00Z",
        "warnings": ["Skipped Foo.cs: dynamic route attribute"],
        "stats": {"controllers_scanned": 5, "endpoints_found": 27},
    }

Architecture notes:
    - Controllers MUST live under <flt_repo>/Service/Microsoft.LiveTable.Service/Controllers/.
    - Only controllers whose class-level [Route(...)] starts with
      "v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable" are included.
      This auto-excludes InternalServiceController ([Route("internal")]),
      PublicAadProtectedController ([Route("publicaad")]), and
      PublicUnprotectedController ([Route("publicUnprotected")]).
    - PublicAPI/* controllers (materializedlakeviews, mlvexecutiondefinitions) are
      flagged but excluded from the active catalog because their tokenType
      routing through the Fabric edge is ambiguous (bearer-via-edge vs mwc).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

CONTROLLERS_SUBPATH = Path("Service") / "Microsoft.LiveTable.Service" / "Controllers"

INCLUDED_CLASS_ROUTE_PREFIX = "v1/workspaces/{workspaceId}/lakehouses/{artifactId}/liveTable"

# F09 swagger-discovery taxonomy. Every endpoint in the catalog carries a
# `kind` and a `source` so the Playground UI and dispatch layer can branch
# on them. `kind` describes WHAT the endpoint is; `source` describes WHERE
# we learned about it.
#
# kind:
#   - "rest"     : normal JSON REST endpoint (the default for all controllers)
#   - "spec"     : OpenAPI/swagger spec JSON document (special: triggers diff
#                  view inside the Playground response viewer)
#   - "ui"       : human-facing HTML page (e.g. swagger-ui); not invokable as
#                  an API request - Playground offers "Open in browser"
#   - "signalr"  : SignalR hub (websocket); Playground uses a hub-events tab
#
# source:
#   - "controller" : extracted from a [HttpVerb] method in a *Controller.cs
#   - "framework"  : hand-curated entry from data/framework-endpoints.json
#                    (covers app.UseSwagger / MapHub / MapGet middleware that
#                    is invisible to the controller scanner)
#   - "runtime"    : observed in the live swagger.json at runtime but not
#                    matched against any static source (catch-all for routes
#                    we missed statically)
VALID_ENDPOINT_KINDS = frozenset({"rest", "spec", "ui", "signalr"})
VALID_ENDPOINT_SOURCES = frozenset({"controller", "framework", "runtime"})

EXCLUDED_FILES = frozenset(
    {
        "InternalServiceController.cs",
        "PublicAadProtectedController.cs",
        "PublicUnprotectedController.cs",
        "BaseApiController.cs",
    }
)

_CLASS_ROUTE_RE = re.compile(r'\[Route\(\s*"([^"]+)"\s*\)\]')
_HTTP_VERB_RE = re.compile(r'\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\(\s*"([^"]*)"\s*\))?\]')
_METHOD_ROUTE_RE = re.compile(r'\[Route\(\s*"([^"]*)"\s*\)\]')
_CLASS_DECL_RE = re.compile(r"public\s+(?:abstract\s+|sealed\s+)?class\s+(\w+)")
_METHOD_DECL_RE = re.compile(
    r"public\s+(?:async\s+)?"
    r"(?:Task<IActionResult>|Task<ActionResult[^>]*>|IActionResult|ActionResult[^>]*|"
    r"Task<IHttpActionResult>|IHttpActionResult)\s+(\w+)\s*\("
)
_XML_SUMMARY_RE = re.compile(
    r"///\s*<summary>\s*(.*?)\s*///\s*</summary>",
    re.DOTALL,
)
_XML_SUMMARY_LINE_RE = re.compile(r"///\s*(.*)")
_FROM_QUERY_RE = re.compile(
    r"\[FromQuery(?:\([^)]*\))?\]\s+"
    r"(?:[A-Za-z_][\w<>\[\],?\s\.]*?)\s+"
    r"([A-Za-z_]\w*)"
)
_FROM_BODY_RE = re.compile(r"\[FromBody(?:\([^)]*\))?\]")
_DYNAMIC_ROUTE_RE = re.compile(r"\[Route\(\s*[A-Za-z_]")  # [Route(Constants.Foo)]

# ── F09 query-param enrichment ────────────────────────────────────────────
# Capture: optional [FromQuery(Name="alias")], type (preserving generics/?),
# parameter name, optional default expression up to next ',' or ')'.
# Type group keeps `<>`, `?`, `,`, `.` so we can preserve `List<Guid>`,
# `int?`, `Microsoft.Foo.Bar`, etc.
_FROM_QUERY_FULL_RE = re.compile(
    r'\[FromQuery(?:\(\s*(?:Name\s*=\s*"(?P<alias>[^"]*)")?\s*\))?\]\s+'
    r"(?P<type>[A-Za-z_][\w<>\[\],?\s\.]*?)\s+"
    r"(?P<name>[A-Za-z_]\w*)"
    r"(?:\s*=\s*(?P<default>[^,)]+?))?"
    r"\s*(?=,|\))",
    re.DOTALL,
)

# Const declarations: optional access modifier(s), const|static readonly, type, name, value.
# Examples matched:
#   private const int X = 30;
#   public const string Y = "foo";
#   public static readonly int Z = 50;
_CONST_RE = re.compile(
    r"(?:public|private|internal|protected)?\s*"
    r"(?:(?:const)|(?:static\s+readonly))\s+"
    r"(?P<type>[A-Za-z_][\w?]*)\s+"
    r"(?P<name>[A-Za-z_]\w*)\s*=\s*"
    r"(?P<value>[^;]+?)\s*;"
)

# Enum declaration. Captures the enum name and the body between `{` and `}`.
_ENUM_RE = re.compile(
    r"public\s+enum\s+(?P<name>[A-Za-z_]\w*)\s*(?::\s*[A-Za-z_]\w*\s*)?\{"
    r"(?P<body>[^}]*)\}",
    re.DOTALL,
)

# XML <param name="...">description</param>. Description can span lines and
# include `///` line continuations.
_XML_PARAM_RE = re.compile(
    r'<param\s+name\s*=\s*"(?P<name>[^"]+)"\s*>(?P<desc>.*?)</param>',
    re.DOTALL,
)

# Methods named with these suffixes/keywords get bumped to a higher danger level.
_FORCE_KEYWORDS = ("force", "delete", "remove", "purge", "unlock")


def extract_catalog(flt_repo_path: str) -> dict:
    """Extract the FLT API catalog from the given workload-fabriclivetable checkout.

    Args:
        flt_repo_path: absolute path to the workload-fabriclivetable repo root.

    Returns:
        dict matching the schema described in the module docstring.
        Always returns a dict; populates `warnings` on partial failures.
    """
    repo = Path(flt_repo_path)
    controllers_dir = repo / CONTROLLERS_SUBPATH

    result = {
        "endpoints": [],
        "groups": [],
        "source": str(repo),
        "extractedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "warnings": [],
        "stats": {"controllers_scanned": 0, "endpoints_found": 0},
    }

    if not controllers_dir.is_dir():
        result["warnings"].append(f"Controllers directory not found: {controllers_dir}")
        return result

    cs_files = sorted(controllers_dir.rglob("*Controller.cs"))

    # F09 enrichment: collect enum names→values once for the whole repo so we
    # can classify List<DagExecutionStatus> etc. as enum-list and ship the
    # value list to the playground for typed dropdowns.
    enum_values = _collect_enum_values(repo)

    for cs_file in cs_files:
        if cs_file.name in EXCLUDED_FILES:
            continue
        # Skip PublicAPI subfolder for now (different auth routing — see module doc).
        try:
            rel = cs_file.relative_to(controllers_dir)
        except ValueError:
            rel = Path(cs_file.name)
        if rel.parts and rel.parts[0] == "PublicAPI":
            result["warnings"].append(f"Deferred (PublicAPI): {cs_file.name} — bearer-vs-mwc routing unresolved")
            continue

        try:
            text = cs_file.read_text(encoding="utf-8-sig", errors="replace")
        except OSError as exc:
            result["warnings"].append(f"Could not read {cs_file.name}: {exc}")
            continue

        controller_endpoints, controller_warnings = _parse_controller(text, cs_file.name, enum_values)
        if controller_endpoints is None:
            # Filtered (wrong class-route prefix) — silent.
            result["warnings"].extend(controller_warnings)
            continue

        result["stats"]["controllers_scanned"] += 1
        result["endpoints"].extend(controller_endpoints)
        result["warnings"].extend(controller_warnings)

    result["stats"]["endpoints_found"] = len(result["endpoints"])

    # SF-002: merge framework endpoints (swagger spec, UI, SignalR hubs) from
    # the hand-curated catalog. Done after controller scan so controller IDs
    # take precedence in any (unlikely) collision.
    framework_endpoints, framework_warnings = _load_framework_endpoints()
    result["warnings"].extend(framework_warnings)
    existing_ids = {ep["id"] for ep in result["endpoints"]}
    for ep in framework_endpoints:
        if ep["id"] in existing_ids:
            result["warnings"].append(
                f"Framework endpoint id '{ep['id']}' collides with controller endpoint — keeping controller"
            )
            continue
        result["endpoints"].append(ep)
        existing_ids.add(ep["id"])
    result["stats"]["framework_endpoints"] = len(framework_endpoints)
    result["stats"]["endpoints_found"] = len(result["endpoints"])

    result["groups"] = _derive_groups(result["endpoints"])
    return result


# ── SF-002: framework endpoints loader ────────────────────────────────────────
# Hand-curated entries for non-controller routes (UseSwagger, UseSwaggerUI,
# MapHub). Lives at data/framework-endpoints.json relative to the edog-studio
# repo root, NOT the FLT repo. Loader is fault-tolerant: missing file →
# warning + empty list, malformed file → warning + empty list.

_FRAMEWORK_ENDPOINTS_PATH = Path(__file__).resolve().parent.parent / "data" / "framework-endpoints.json"

_REQUIRED_FRAMEWORK_KEYS = (
    "id",
    "name",
    "method",
    "urlTemplate",
    "fullPath",
    "group",
    "tokenType",
    "controller",
    "description",
    "queryParams",
    "dangerLevel",
    "bodyTemplate",
    "kind",
    "source",
)


def _load_framework_endpoints() -> tuple[list[dict], list[str]]:
    """Read and validate data/framework-endpoints.json.

    Returns (endpoints, warnings). Never raises; non-fatal issues become
    warnings so the controller-derived catalog still serves.
    """
    import json

    warnings: list[str] = []
    path = _FRAMEWORK_ENDPOINTS_PATH
    if not path.is_file():
        warnings.append(f"Framework endpoints file not found: {path}")
        return [], warnings

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        warnings.append(f"Could not read framework endpoints file: {exc}")
        return [], warnings

    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        warnings.append(f"Framework endpoints file is not valid JSON: {exc}")
        return [], warnings

    raw_endpoints = doc.get("endpoints")
    if not isinstance(raw_endpoints, list):
        warnings.append("Framework endpoints file missing 'endpoints' list")
        return [], warnings

    validated: list[dict] = []
    for idx, ep in enumerate(raw_endpoints):
        if not isinstance(ep, dict):
            warnings.append(f"Framework endpoint #{idx} is not an object — skipped")
            continue
        missing = [k for k in _REQUIRED_FRAMEWORK_KEYS if k not in ep]
        if missing:
            warnings.append(f"Framework endpoint '{ep.get('id', f'#{idx}')}' missing keys: {missing} — skipped")
            continue
        if ep["kind"] not in VALID_ENDPOINT_KINDS:
            warnings.append(f"Framework endpoint '{ep['id']}' has invalid kind '{ep['kind']}' — skipped")
            continue
        if ep["source"] != "framework":
            warnings.append(
                f"Framework endpoint '{ep['id']}' must have source='framework', got '{ep['source']}' — skipped"
            )
            continue
        validated.append(ep)
    return validated, warnings


def framework_endpoints_mtime() -> float | None:
    """Return the mtime of data/framework-endpoints.json, or None if missing.

    SF-002: separate cache invalidation key for framework-endpoint edits, so
    the dev-server playground cache invalidates when this file changes
    without needing a controller file touch.
    """
    try:
        return _FRAMEWORK_ENDPOINTS_PATH.stat().st_mtime
    except OSError:
        return None


def _parse_controller(
    text: str, file_name: str, enum_values: dict[str, list[str]] | None = None
) -> tuple[list[dict] | None, list[str]]:
    """Parse a single controller file.

    Returns (endpoints, warnings). `endpoints` is None when the controller's
    class-level [Route] doesn't match the FLT inclusion prefix (silent filter).

    `enum_values` is the repo-wide enum name→values map used to enrich
    queryParams. Pass an empty dict for tests that don't care about enums.
    """
    enum_values = enum_values or {}
    enum_names = set(enum_values.keys())
    warnings: list[str] = []

    class_route = _extract_class_route(text)
    if class_route is None:
        return None, []
    if not class_route.startswith(INCLUDED_CLASS_ROUTE_PREFIX):
        return None, []

    class_name_match = _CLASS_DECL_RE.search(text)
    controller_name = class_name_match.group(1) if class_name_match else file_name.replace(".cs", "")

    # Collect const values defined in this file once — used to resolve symbol
    # default expressions like `dateRange = DefaultDateRangeDays`.
    file_consts = _extract_consts(text)

    # Path suffix after the {artifactId}/ piece — e.g. "liveTable", "liveTableMaintanance",
    # "liveTableSchedule", "liveTable/insights", "liveTable/refreshTriggers".
    suffix_idx = class_route.find("{artifactId}/") + len("{artifactId}/")
    class_suffix = class_route[suffix_idx:]

    # Group identifier == the full class_suffix. This gives one group per
    # controller and keeps Insights / RefreshTriggers separate from the base
    # LiveTable group (which would otherwise swallow them when split on '/').
    group = class_suffix

    endpoints: list[dict] = []
    used_ids: set[str] = set()

    # Walk method-level attributes by scanning forward from each method declaration's
    # preceding attribute block. We anchor on the [HttpVerb] attribute since it's
    # the unambiguous start-of-action-method marker.
    for match in _HTTP_VERB_RE.finditer(text):
        verb = match.group(1).upper()
        inline_route = match.group(2)  # may be None
        attr_end = match.end()

        # Look ahead a small window for the method declaration and a possible
        # separate [Route("...")] sibling attribute.
        window_end = min(len(text), attr_end + 4000)
        window = text[attr_end:window_end]

        sibling_route = None
        if inline_route is None:
            route_match = _METHOD_ROUTE_RE.search(window)
            if route_match:
                # Ensure the [Route] occurs *before* the method declaration in the window.
                method_match = _METHOD_DECL_RE.search(window)
                if method_match and route_match.start() < method_match.start():
                    sibling_route = route_match.group(1)

        if _DYNAMIC_ROUTE_RE.search(window[:200]) and inline_route is None and sibling_route is None:
            warnings.append(f"{file_name}: skipped method (dynamic [Route(...)] cannot be resolved)")
            continue

        method_route = inline_route if inline_route is not None else (sibling_route or "")

        method_match = _METHOD_DECL_RE.search(window)
        if not method_match:
            warnings.append(f"{file_name}: [Http{verb.title()}] without matching method declaration")
            continue
        method_name = method_match.group(1)

        # XML summary lives BEFORE the [HttpVerb] attribute. Find the most recent
        # one in the preceding 2000 chars.
        backtrack_start = max(0, match.start() - 2000)
        preceding = text[backtrack_start : match.start()]
        description = _extract_last_summary(preceding)

        # XML <param> descriptions live in the same preceding doc-comment block.
        # Strip the `///` prefixes so the regex sees clean XML.
        cleaned_xml = "\n".join(line.strip().lstrip("/").strip() for line in preceding.splitlines())
        param_docs = _extract_param_descriptions(cleaned_xml)

        # Query params are extracted from the method body parameter list.
        params_window = window[method_match.start() : method_match.start() + 2000]
        # Limit to the parameter list — first balanced parens.
        params_text = _slice_param_list(params_window)
        query_params = _parse_query_params(params_text, file_consts, enum_names, param_docs)
        # Attach enum values when the type is a known enum (or list of one).
        for qp in query_params:
            if qp["kind"] in ("enum", "enum-list"):
                base = qp["type"].rstrip("?")
                if base.startswith("List<"):
                    base = base[len("List<") : -1].strip()
                qp["enumValues"] = enum_values.get(base)
            else:
                qp["enumValues"] = None
        has_from_body = bool(_FROM_BODY_RE.search(params_text))

        # Compose paths.
        url_template = _compose_path(class_suffix, method_route)
        full_path = _compose_path(class_route, method_route)
        url_template = "/" + url_template.lstrip("/")
        full_path = "/" + full_path.lstrip("/")

        # Build endpoint record.
        ep_id = _make_id(verb, url_template)
        # De-duplicate against earlier entries in this controller.
        if ep_id in used_ids:
            ep_id = ep_id + "-" + str(len(used_ids))
        used_ids.add(ep_id)

        body_template = {} if has_from_body and verb in ("POST", "PUT", "PATCH") else None

        endpoints.append(
            {
                "id": ep_id,
                "name": _humanize_method_name(method_name),
                "method": verb,
                "urlTemplate": url_template,
                "fullPath": full_path,
                "group": group,
                "tokenType": "mwc",
                "controller": controller_name,
                "description": description or "",
                "queryParams": query_params,
                "dangerLevel": _danger_level(verb, method_name),
                "bodyTemplate": body_template,
                "kind": "rest",
                "source": "controller",
            }
        )

    return endpoints, warnings


def _extract_class_route(text: str) -> str | None:
    """Return the class-level [Route("...")] string, or None.

    The class-level Route is the [Route(...)] attribute that appears just before
    the `public class FooController` declaration. We anchor on the class
    declaration and search backwards in a small window.
    """
    class_match = _CLASS_DECL_RE.search(text)
    if not class_match:
        return None
    # Look in the 2000 chars preceding the class declaration for [Route("...")].
    start = max(0, class_match.start() - 2000)
    preceding = text[start : class_match.start()]
    # Last [Route("...")] in the preceding window is the class-level one.
    routes = _CLASS_ROUTE_RE.findall(preceding)
    if not routes:
        return None
    return routes[-1]


def _extract_last_summary(text_before_attr: str) -> str:
    """Return the most recent <summary>...</summary> block as a single-line string."""
    matches = list(_XML_SUMMARY_RE.finditer(text_before_attr))
    if not matches:
        return ""
    raw = matches[-1].group(1)
    # Strip leading "/// " from each line, join, collapse whitespace.
    lines = []
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            stripped = stripped[3:].strip()
        if stripped:
            lines.append(stripped)
    return " ".join(lines)


def _slice_param_list(text_from_method: str) -> str:
    """Return the text between the first '(' and its matching ')'.

    Used to constrain regex extraction of [FromQuery] / [FromBody] to the
    parameter list, avoiding false positives from later code.
    """
    depth = 0
    start = -1
    for i, ch in enumerate(text_from_method):
        if ch == "(":
            if depth == 0:
                start = i
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and start >= 0:
                return text_from_method[start : i + 1]
    return text_from_method


def _compose_path(left: str, right: str) -> str:
    """Join two route segments with a single '/'."""
    left = left.rstrip("/")
    right = right.lstrip("/")
    if not right:
        return left
    return left + "/" + right


def _make_id(verb: str, path: str) -> str:
    """Build a slug id from verb + path. Placeholders kept, special chars stripped."""
    slug = path.strip("/").lower()
    slug = re.sub(r"[{}]", "", slug)
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return f"{verb.lower()}-{slug}" if slug else verb.lower()


def _humanize_method_name(name: str) -> str:
    """Turn 'GetLatestDagAsync' into 'Get Latest Dag'."""
    if name.endswith("Async"):
        name = name[:-5]
    # Insert space before capital letters preceded by a lowercase letter or digit.
    spaced = re.sub(r"(?<=[a-z0-9])([A-Z])", r" \1", name)
    # Also split runs like "DAGSettings" → "DAG Settings".
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return spaced.strip()


def _danger_level(verb: str, method_name: str) -> str:
    """Heuristic danger level: safe / caution / destructive."""
    lower_name = method_name.lower()
    if verb == "DELETE":
        return "destructive"
    if any(kw in lower_name for kw in _FORCE_KEYWORDS):
        return "destructive"
    if verb in ("POST", "PUT", "PATCH"):
        return "caution"
    return "safe"


def _derive_groups(endpoints: list[dict]) -> list[dict]:
    """Return a stable-ordered list of unique groups with human-friendly labels.

    Each group is a dict: {"id": "<class_suffix>", "label": "<friendly>", "order": N}.
    """
    seen: list[str] = []
    for ep in endpoints:
        g = ep["group"]
        if g not in seen:
            seen.append(g)
    return [{"id": g, "label": _group_label(g), "order": i} for i, g in enumerate(seen)]


_GROUP_LABEL_OVERRIDES = {
    "liveTable": "LiveTable",
    "liveTable/insights": "Insights",
    "liveTable/refreshTriggers": "Refresh Triggers",
    "liveTableMaintanance": "Maintenance",
    "liveTableSchedule": "Scheduler",
    "framework/swagger": "Framework · Swagger",
}


def _group_label(group_id: str) -> str:
    """Friendly label for a group id; falls back to a humanized last segment."""
    if group_id in _GROUP_LABEL_OVERRIDES:
        return _GROUP_LABEL_OVERRIDES[group_id]
    # Generic fallback: take last path segment, split camelCase.
    last = group_id.rsplit("/", 1)[-1]
    return _humanize_method_name(last) or last


def controllers_dir_mtime(flt_repo_path: str) -> float | None:
    """Return the max mtime across the Controllers directory tree, or None.

    Used by the dev-server endpoint to cache extraction results. Any change to
    a controller file (new, modified, deleted) updates the directory tree mtime
    on most filesystems; we walk explicitly to be safe.
    """
    controllers_dir = Path(flt_repo_path) / CONTROLLERS_SUBPATH
    if not controllers_dir.is_dir():
        return None
    max_mtime = controllers_dir.stat().st_mtime
    for cs_file in controllers_dir.rglob("*Controller.cs"):
        try:
            mtime = cs_file.stat().st_mtime
            if mtime > max_mtime:
                max_mtime = mtime
        except OSError:
            continue
    return max_mtime


# ════════════════════════════════════════════════════════════════
# F09 query-param enrichment helpers
# ════════════════════════════════════════════════════════════════

# Subset of C# numeric primitives we treat as integer for default parsing.
_INT_TYPES = {"int", "short", "long", "byte", "uint", "ushort", "ulong", "sbyte"}
# C# float-ish primitives (kept for completeness even if rare in FLT controllers).
_FLOAT_TYPES = {"float", "double", "decimal"}


def _extract_consts(text: str) -> dict:
    """Return {NAME: value} for every parseable `const` / `static readonly` in `text`.

    Values are parsed as Python literals when possible (int, str, bool). When
    the right-hand side isn't a simple literal (e.g. expression, method call),
    the entry is omitted. Best-effort: callers must handle absence gracefully.
    """
    out: dict = {}
    for m in _CONST_RE.finditer(text):
        name = m.group("name")
        ctype = m.group("type")
        raw = m.group("value").strip()
        value, _, ok = _resolve_default(raw, {})
        if ok:
            out[name] = value
        else:
            # Try harder for typed primitives where the literal may include
            # suffixes like `30L` or `1.5f` — strip and retry.
            if ctype in _INT_TYPES and raw and raw[-1].lower() in ("l", "u"):
                stripped = raw.rstrip("uUlL")
                v2, _, ok2 = _resolve_default(stripped, {})
                if ok2:
                    out[name] = v2
    return out


def _resolve_default(literal: str, consts: dict) -> tuple:
    """Resolve a default expression to (value, raw_literal, resolved_bool).

    Handles simple C# literals (numbers, strings, true/false, null) plus
    symbol references that may resolve via `consts`. Anything else returns
    (None, literal, False) so the caller can preserve the symbol for the UI.
    """
    raw = (literal or "").strip()
    if not raw:
        return None, raw, False

    # null literal
    if raw == "null":
        return None, raw, True
    # bool literals
    if raw == "true":
        return True, raw, True
    if raw == "false":
        return False, raw, True
    # string literal — verbatim (`@"..."`) or regular
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1], raw, True
    if raw.startswith('@"') and raw.endswith('"') and len(raw) >= 3:
        return raw[2:-1], raw, True
    # int literal (incl. negative)
    try:
        return int(raw), raw, True
    except ValueError:
        pass
    # float literal
    try:
        return float(raw), raw, True
    except ValueError:
        pass
    # Symbol reference — try const lookup, otherwise leave unresolved
    if raw in consts:
        return consts[raw], raw, True
    return None, raw, False


def _classify_type(type_str: str, enum_names: set) -> tuple:
    """Return (kind, nullable) for a C# parameter type.

    kind ∈ {"scalar", "list", "enum", "enum-list"}.
    `nullable` is True only for explicit `T?` syntax — we don't treat
    reference types (string, etc.) as nullable for required-flag purposes,
    because absence of a default still means the caller must supply a value.
    """
    raw = (type_str or "").strip()
    nullable = raw.endswith("?")
    base = raw.rstrip("?").strip()

    # List<T> / IEnumerable<T> / IReadOnlyList<T> — treat as list.
    list_prefixes = ("List<", "IList<", "IEnumerable<", "IReadOnlyList<", "ICollection<")
    for prefix in list_prefixes:
        if base.startswith(prefix) and base.endswith(">"):
            inner = base[len(prefix) : -1].strip().rstrip("?")
            if inner in enum_names:
                return "enum-list", nullable
            return "list", nullable

    if base in enum_names:
        return "enum", nullable
    return "scalar", nullable


def _extract_param_descriptions(xml_block: str) -> dict:
    """Return {param_name: description} from `<param name="...">desc</param>` tags.

    Description text is whitespace-collapsed but multi-line content is preserved
    as a single space-joined string. Empty descriptions return an empty string.
    """
    out: dict = {}
    for m in _XML_PARAM_RE.finditer(xml_block):
        name = m.group("name").strip()
        raw = (m.group("desc") or "").strip()
        # Collapse whitespace runs (including newlines) to single spaces.
        cleaned = re.sub(r"\s+", " ", raw).strip()
        out[name] = cleaned
    return out


def _parse_query_params(
    params_text: str,
    consts: dict,
    enum_names: set,
    param_docs: dict,
) -> list:
    """Parse `[FromQuery]` parameters from a balanced parameter list `params_text`.

    Returns a list of enriched parameter dicts:
        {name, type, kind, default, defaultLiteral, required, alias, description}

    `enumValues` is set to None here — the caller attaches enum value lists
    after parsing (it has the full enum_values dict, not just the names).
    """
    out: list = []
    for m in _FROM_QUERY_FULL_RE.finditer(params_text):
        name = m.group("name")
        raw_type = re.sub(r"\s+", "", m.group("type") or "").strip()
        alias = m.group("alias")
        default_expr = m.group("default")
        kind, nullable = _classify_type(raw_type, enum_names)

        if default_expr is None:
            default_value: object | None = None
            default_literal: str | None = None
            has_default = False
        else:
            v, lit, ok = _resolve_default(default_expr.strip(), consts)
            default_value = v if ok else None
            default_literal = lit
            has_default = True

        # Required iff non-nullable AND no default supplied.
        required = (not nullable) and (not has_default)

        out.append(
            {
                "name": name,
                "type": raw_type,
                "kind": kind,
                "default": default_value,
                "defaultLiteral": default_literal,
                "required": required,
                "alias": alias,
                "description": param_docs.get(name, ""),
                "enumValues": None,
            }
        )
    return out


def _collect_enum_values(repo_path) -> dict:
    """Scan `Service/Microsoft.LiveTable.Service/**/*.cs` and return enum name→values.

    Best-effort: parses simple `public enum Foo { A, B = 1, C, }` shapes. Strips
    XML doc comments and attribute blocks (e.g. `[EnumMember(Value="x")]`) before
    splitting on commas — FLT enums frequently carry both. Values with explicit
    `= <value>` assignments still contribute the symbolic name.
    Missing service directory returns `{}`.
    """
    repo = Path(repo_path)
    svc_dir = repo / "Service" / "Microsoft.LiveTable.Service"
    if not svc_dir.is_dir():
        return {}

    out: dict = {}
    for cs_file in svc_dir.rglob("*.cs"):
        try:
            text = cs_file.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        for m in _ENUM_RE.finditer(text):
            ename = m.group("name")
            body = m.group("body")
            # Strip XML doc-comment lines (`/// ...`) — they contain `=` inside
            # attribute references which would break our comma splitting.
            body_no_xml = "\n".join(line for line in body.splitlines() if not line.lstrip().startswith("///"))
            # Strip attribute blocks `[Foo(...)]` (may span lines, contain `=`).
            body_no_attrs = _strip_balanced(body_no_xml, "[", "]")
            values = []
            for raw_val in body_no_attrs.split(","):
                token = raw_val.strip()
                if not token:
                    continue
                # Strip trailing assignment: `Active = 1` → `Active`.
                token = token.split("=", 1)[0].strip()
                # Identifier sanity check.
                if re.match(r"^[A-Za-z_]\w*$", token):
                    values.append(token)
            if values and ename not in out:
                out[ename] = values
    return out


def _strip_balanced(text: str, open_ch: str, close_ch: str) -> str:
    """Remove substrings bounded by balanced `open_ch`/`close_ch` (depth-aware).

    Used to strip `[Attribute(args)]` blocks from C# enum bodies before
    comma-splitting. Unbalanced text is returned with whatever was opened
    silently dropped — acceptable for best-effort parsing.
    """
    out = []
    depth = 0
    for ch in text:
        if ch == open_ch:
            depth += 1
            continue
        if ch == close_ch and depth > 0:
            depth -= 1
            continue
        if depth == 0:
            out.append(ch)
    return "".join(out)
