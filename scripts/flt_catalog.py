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

EXCLUDED_FILES = frozenset(
    {
        "InternalServiceController.cs",
        "PublicAadProtectedController.cs",
        "PublicUnprotectedController.cs",
        "BaseApiController.cs",
    }
)

_CLASS_ROUTE_RE = re.compile(r'\[Route\(\s*"([^"]+)"\s*\)\]')
_HTTP_VERB_RE = re.compile(
    r'\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\(\s*"([^"]*)"\s*\))?\]'
)
_METHOD_ROUTE_RE = re.compile(r'\[Route\(\s*"([^"]*)"\s*\)\]')
_CLASS_DECL_RE = re.compile(r'public\s+(?:abstract\s+|sealed\s+)?class\s+(\w+)')
_METHOD_DECL_RE = re.compile(
    r'public\s+(?:async\s+)?'
    r'(?:Task<IActionResult>|Task<ActionResult[^>]*>|IActionResult|ActionResult[^>]*|'
    r'Task<IHttpActionResult>|IHttpActionResult)\s+(\w+)\s*\('
)
_XML_SUMMARY_RE = re.compile(
    r'///\s*<summary>\s*(.*?)\s*///\s*</summary>',
    re.DOTALL,
)
_XML_SUMMARY_LINE_RE = re.compile(r'///\s*(.*)')
_FROM_QUERY_RE = re.compile(
    r'\[FromQuery(?:\([^)]*\))?\]\s+'
    r'(?:[A-Za-z_][\w<>\[\],?\s\.]*?)\s+'
    r'([A-Za-z_]\w*)'
)
_FROM_BODY_RE = re.compile(r'\[FromBody(?:\([^)]*\))?\]')
_DYNAMIC_ROUTE_RE = re.compile(r'\[Route\(\s*[A-Za-z_]')  # [Route(Constants.Foo)]

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
        result["warnings"].append(
            f"Controllers directory not found: {controllers_dir}"
        )
        return result

    cs_files = sorted(controllers_dir.rglob("*Controller.cs"))
    for cs_file in cs_files:
        if cs_file.name in EXCLUDED_FILES:
            continue
        # Skip PublicAPI subfolder for now (different auth routing — see module doc).
        try:
            rel = cs_file.relative_to(controllers_dir)
        except ValueError:
            rel = Path(cs_file.name)
        if rel.parts and rel.parts[0] == "PublicAPI":
            result["warnings"].append(
                f"Deferred (PublicAPI): {cs_file.name} — bearer-vs-mwc routing unresolved"
            )
            continue

        try:
            text = cs_file.read_text(encoding="utf-8-sig", errors="replace")
        except OSError as exc:
            result["warnings"].append(f"Could not read {cs_file.name}: {exc}")
            continue

        controller_endpoints, controller_warnings = _parse_controller(
            text, cs_file.name
        )
        if controller_endpoints is None:
            # Filtered (wrong class-route prefix) — silent.
            result["warnings"].extend(controller_warnings)
            continue

        result["stats"]["controllers_scanned"] += 1
        result["endpoints"].extend(controller_endpoints)
        result["warnings"].extend(controller_warnings)

    result["stats"]["endpoints_found"] = len(result["endpoints"])
    result["groups"] = _derive_groups(result["endpoints"])
    return result


def _parse_controller(
    text: str, file_name: str
) -> tuple[list[dict] | None, list[str]]:
    """Parse a single controller file.

    Returns (endpoints, warnings). `endpoints` is None when the controller's
    class-level [Route] doesn't match the FLT inclusion prefix (silent filter).
    """
    warnings: list[str] = []

    class_route = _extract_class_route(text)
    if class_route is None:
        return None, []
    if not class_route.startswith(INCLUDED_CLASS_ROUTE_PREFIX):
        return None, []

    class_name_match = _CLASS_DECL_RE.search(text)
    controller_name = class_name_match.group(1) if class_name_match else file_name.replace(".cs", "")

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
            warnings.append(
                f"{file_name}: skipped method (dynamic [Route(...)] cannot be resolved)"
            )
            continue

        method_route = inline_route if inline_route is not None else (sibling_route or "")

        method_match = _METHOD_DECL_RE.search(window)
        if not method_match:
            warnings.append(
                f"{file_name}: [Http{verb.title()}] without matching method declaration"
            )
            continue
        method_name = method_match.group(1)

        # XML summary lives BEFORE the [HttpVerb] attribute. Find the most recent
        # one in the preceding 2000 chars.
        backtrack_start = max(0, match.start() - 2000)
        preceding = text[backtrack_start : match.start()]
        description = _extract_last_summary(preceding)

        # Query params are extracted from the method body parameter list.
        params_window = window[method_match.start() : method_match.start() + 2000]
        # Limit to the parameter list — first balanced parens.
        params_text = _slice_param_list(params_window)
        query_params = [m.group(1) for m in _FROM_QUERY_RE.finditer(params_text)]
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
    return [
        {"id": g, "label": _group_label(g), "order": i}
        for i, g in enumerate(seen)
    ]


_GROUP_LABEL_OVERRIDES = {
    "liveTable": "LiveTable",
    "liveTable/insights": "Insights",
    "liveTable/refreshTriggers": "Refresh Triggers",
    "liveTableMaintanance": "Maintenance",
    "liveTableSchedule": "Scheduler",
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
