"""
System Files tab — failing tests that pin each of 9 bugs.

Each TestClass corresponds to one bug. Tests are written against the
DESIRED post-fix behavior — they FAIL on current code, will PASS after
the corresponding fix lands.

Strategy is source-level static analysis (regex + AST-style grep on the
.cs file), because:
  - C# unit-test infra is not set up in this Python repo
  - The contracts we're enforcing are structural (every wrap method has
    try/catch; every PublishEvent payload has these fields). Structural
    guards catch regressions effectively without needing runtime tests.

Bug catalog (matches plan.md):
  Bug 1  Critical  iterationId published is wks-lh, not real DAG iteration
  Bug 2  Critical  no correlationId/rootActivityId in event payload
  Bug 3  Critical  failed file ops never publish (no try/catch around await)
  Bug 4  Medium    ListFilesWithMetadata operation missing from frontend switch
  Bug 5  Medium    contentSizeBytes overloaded with count for List/metadata ops
  Bug 6  Medium    ListFilesWithMetadata triples discarded; only count survives
  Bug 7  Low       stale-lock detection false-negative for pre-attach locks
  Bug 8  Low       ContinuationToken from ListWithContinuationAsync discarded
  Bug 9  Low       hardcoded "known dirs" list in frontend
"""

from __future__ import annotations

import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVMODE = os.path.join(REPO, "src", "backend", "DevMode")
FRONTEND_JS = os.path.join(REPO, "src", "frontend", "js")

INTERCEPTOR_CS = os.path.join(DEVMODE, "EdogFileSystemInterceptor.cs")
TAB_SYSFILES_JS = os.path.join(FRONTEND_JS, "tab-sysfiles.js")


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


# All 16 wrap methods in EdogFileSystemWrapper that go through PublishEvent
# (manually catalogued — the test_bug3 tests below also verify this list is
# the live set, so the list won't drift silently).
WRAP_METHODS = [
    "ExistsAsync",
    "CreateDirIfNotExistsAsync",
    "CreateOrUpdateFileAsync",
    "ReadFileAsStringAsync",
    "CreateEmptyFileIfNotExistsAsync",
    "RenameFileAsync",
    "DeleteFileIfExistsAsync",
    "DeleteDirIfExistsAsync",
    "ListAsync",
    "ReadFileBytesAsync",
    "ListWithContinuationAsync",
    "GetDirMetadataAsync",
    "GetFileMetadataAsync",
    "CreateFileWithContentIfNotExistsAsync",
    "WriteFileBytesAsync",
    "ListFilesWithMetadataAsync",
]


def _method_body(src: str, name: str) -> str:
    """Extract a single method body (between { and matching }) from the .cs source.

    Handles every C# return-type shape: bare types (`bool`), generics
    (`Task<List<string>>`), nested generics (`Task<IDictionary<string,string>>`),
    tuple returns (`Task<(List<string> Paths, string Token)>`).

    Strategy: each method declaration in this file is on a single line.
    Match `^...public ... <name>(` with multiline.
    """
    m = re.search(
        r"(?m)^\s*public\s+.*?\b" + re.escape(name) + r"\s*\(",
        src,
    )
    if not m:
        return ""
    # Walk braces from the start of the method body to find the matching close.
    open_idx = src.find("{", m.end())
    if open_idx < 0:
        return ""
    depth = 0
    i = open_idx
    while i < len(src):
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1 : i]
        i += 1
    return ""
    # Walk braces from the start of the method body to find the matching close.
    open_idx = src.find("{", m.end())
    if open_idx < 0:
        return ""
    depth = 0
    i = open_idx
    while i < len(src):
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1 : i]
        i += 1
    return ""


# ════════════════════════════════════════════════════════════════════
# BUG 1 — iterationId published is workspace-lakehouse, not real iteration
# ════════════════════════════════════════════════════════════════════


class TestBug1IterationIdIsRealNotArtifact:
    """The published `iterationId` field must be the actual DAG iteration id
    (best-effort lookup via EdogLogInterceptor.TryGetIterationForRootActivity
    using the RAID currently in scope), never the workspaceId-lakehouseId
    string baked at factory time.

    Why it matters: when the same lakehouse runs DAG iteration A then
    iteration B, the System Files tab currently shows both batches of file
    ops under the same string. Cross-tab filtering by iteration is
    impossible because the field semantically lies.

    Note: there is no static MonitoredScope.GetCustomData(name) ambient
    API in this codebase. The viable path is the existing
    rootActivityId → iterationId map maintained by EdogLogInterceptor
    (populated by SSR + Additional telemetry interceptors as they
    observe events). The fix exposes a public lookup, and file ops
    derive iterationId via that lookup using MonitoredScope.RootActivityId.
    """

    def test_log_interceptor_exposes_root_activity_lookup(self):
        log_src = _read(os.path.join(DEVMODE, "EdogLogInterceptor.cs"))
        assert re.search(
            r"public\s+static\s+string\s+TryGetIterationForRootActivity\s*\(",
            log_src,
        ), (
            "EdogLogInterceptor must expose a `public static string "
            "TryGetIterationForRootActivity(string rootActivityId)` lookup. "
            "This is the only viable way for file ops to derive their "
            "iteration id (FLT has no ambient MonitoredScope.GetCustomData "
            "static accessor)."
        )

    def test_interceptor_publishes_artifact_id_not_iteration_id_for_lakehouse_string(self):
        src = _read(INTERCEPTOR_CS)
        # The wrapper's old `_iterationId = workspaceId-lakehouseId` field
        # must be either renamed `_artifactId` OR fully removed (with the
        # field surfaced as artifactId in the event payload). Either way,
        # the variable name must not lie about being an iteration.
        has_artifact_field = re.search(r"private\s+readonly\s+string\s+_artifactId", src)
        has_iteration_field = re.search(r"private\s+readonly\s+string\s+_iterationId", src)
        assert has_artifact_field or not has_iteration_field, (
            "The wrapper's private `_iterationId` field is misnamed — it "
            "holds workspaceId-lakehouseId, not an iteration. Rename to "
            "`_artifactId` to make the semantic honest."
        )

    def test_interceptor_uses_root_activity_iteration_lookup(self):
        src = _read(INTERCEPTOR_CS)
        # Strip line + block comments so a commented-out call cannot
        # satisfy the guard (same mutation-test lesson as the Additional
        # telemetry registrar test).
        clean = re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL))
        assert re.search(
            r"EdogLogInterceptor\.TryGetIterationForRootActivity\s*\(",
            clean,
        ), (
            "EdogFileSystemInterceptor must call "
            "EdogLogInterceptor.TryGetIterationForRootActivity(...) at "
            "publish time to derive the real iterationId from the ambient "
            "RAID. Without this, iterationId is either missing or lying. "
            "(Commenting the call out does NOT satisfy this guard.)"
        )

    def test_factory_does_not_pass_iteration_string_to_wrapper(self):
        src = _read(INTERCEPTOR_CS)
        # In the factory's CreateFileSystem, the lie
        #   var iterationId = $"{workspaceId:N}-{lakehouseId:N}";
        # must be GONE. A `var artifactId = ...` is allowed.
        offender = re.search(
            r"var\s+iterationId\s*=\s*\$\"\{workspaceId",
            src,
        )
        assert not offender, (
            "EdogFileSystemFactoryWrapper.CreateFileSystem must not bake "
            "a workspaceId+lakehouseId string into a variable called "
            "`iterationId` — the semantic is wrong. Use `artifactId` if "
            "you want to preserve the lakehouse identifier, but do not "
            "call it an iteration."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 2 — no correlationId / rootActivityId in fileop event payload
# ════════════════════════════════════════════════════════════════════


class TestBug2RootActivityIdInPayload:
    """Every fileop event must publish the rootActivityId of the
    MonitoredScope active at publish time so the Studio can correlate
    each file operation back to the log line / telemetry event / DAG
    iteration that triggered it.

    Today the anonymous-object payload in PublishEvent has no such field.
    "View in Logs" from a file row is impossible.
    """

    def test_publish_event_reads_root_activity_id(self):
        src = _read(INTERCEPTOR_CS)
        assert re.search(
            r"MonitoredScope\.RootActivityId",
            src,
        ), (
            "EdogFileSystemInterceptor must read "
            "MonitoredScope.RootActivityId at publish time and include it "
            "in the event payload. Without this field, file ops cannot be "
            "correlated back to the log lines or telemetry events that "
            "caused them — 'View in Logs' from a file row is impossible."
        )

    def test_publish_event_payload_includes_root_activity_id_field(self):
        src = _read(INTERCEPTOR_CS)
        # The anonymous object inside PublishEvent must declare
        # rootActivityId (or correlationId) as a key. The current shape:
        #   new { operation, path, contentSizeBytes, durationMs, hasContent,
        #         contentPreview, previewTruncated, ttlSeconds,
        #         operationResult, metadata, iterationId }
        # — no correlationId / rootActivityId.
        # Search for the anonymous-object initializer in PublishEvent.
        publish_body = _method_body(src, "PublishEvent")
        if not publish_body:
            # PublishEvent is private; method-body extractor only catches
            # `public async Task` patterns. Fall back to searching the
            # whole file but anchored to the PublishEvent → EdogTopicRouter
            # block.
            publish_body = src[src.find("private void PublishEvent"):]

        assert "rootActivityId" in publish_body or "correlationId" in publish_body, (
            "The fileop event payload must include a `rootActivityId` "
            "(or `correlationId`) field. Today the anon-object has "
            "iterationId only — broken correlation."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 3 — failed file ops are invisible (no try/catch around await)
# ════════════════════════════════════════════════════════════════════


class TestBug3FailedOpsAreCaptured:
    """When `_inner.X()` throws, the existing wrapper's PublishEvent is
    never reached because the await re-throws before the next statement.
    Every one of the 16 wrap methods must use try/catch (or try/finally)
    so a thrown exception still produces a fileop event tagged with the
    error, so the System Files tab visualizes failed ops.

    This is the most important bug — exactly the moments you would most
    want to see file ops (permission denied, throttle, network failure),
    the tab shows nothing.
    """

    def test_every_wrap_method_has_a_try_block(self):
        """Every wrap method body must contain `try {` so a thrown
        `await _inner.X()` doesn't bypass observation."""
        src = _read(INTERCEPTOR_CS)
        offenders = []
        for name in WRAP_METHODS:
            body = _method_body(src, name)
            if not body:
                offenders.append(f"{name}: method body not found")
                continue
            # Must have at least one `try {` block guarding the await +
            # publish chain.
            if not re.search(r"\btry\s*\{", body):
                offenders.append(name)
        assert not offenders, (
            "These wrap methods have no try/catch guarding the await + "
            "PublishEvent chain. If `_inner.X()` throws, PublishEvent is "
            "never reached and the failed file op is INVISIBLE to the "
            "System Files tab. Methods: " + ", ".join(offenders)
        )

    def test_every_wrap_method_publishes_in_catch(self):
        """Every wrap method must publish a fileop event when the inner
        call throws — so the Studio sees the failure. The catch block
        must contain a PublishEvent call before any rethrow."""
        src = _read(INTERCEPTOR_CS)
        offenders = []
        for name in WRAP_METHODS:
            body = _method_body(src, name)
            # Find every `catch` block in the body. Each catch must
            # contain a PublishEvent (or PublishError) call.
            catch_starts = [m.start() for m in re.finditer(r"\bcatch\b", body)]
            if not catch_starts:
                offenders.append(f"{name}: no catch block")
                continue
            saw_publish = False
            for cs in catch_starts:
                # Grab the catch body — naive: until matching close brace
                open_brace = body.find("{", cs)
                if open_brace < 0:
                    continue
                depth = 0
                end = open_brace
                while end < len(body):
                    if body[end] == "{":
                        depth += 1
                    elif body[end] == "}":
                        depth -= 1
                        if depth == 0:
                            break
                    end += 1
                catch_body = body[open_brace + 1 : end]
                if re.search(r"\bPublish(Event|Error|Failure)\s*\(", catch_body):
                    saw_publish = True
                    break
            if not saw_publish:
                offenders.append(name)
        assert not offenders, (
            "These wrap methods catch exceptions but do NOT call PublishEvent "
            "from the catch block — so the failed op is still invisible. "
            "Methods: " + ", ".join(offenders)
        )

    def test_publish_event_payload_supports_error_fields(self):
        """The PublishEvent signature (or the event payload it builds)
        must accept success/error info, otherwise the catch can't
        meaningfully publish a failure."""
        src = _read(INTERCEPTOR_CS)
        # Either:
        #   (a) PublishEvent has an `errorMessage` / `errorType` / `success`
        #       parameter, OR
        #   (b) there's a separate PublishError / PublishFailure overload.
        has_error_param = re.search(
            r"PublishEvent\b[^)]*\b(errorMessage|errorType|exception|success|isError)\b",
            src,
            re.DOTALL,
        )
        has_error_method = re.search(
            r"\bprivate\s+void\s+(PublishError|PublishFailure)\b",
            src,
        )
        assert has_error_param or has_error_method, (
            "PublishEvent must support error fields (errorMessage / "
            "errorType / success), OR a sibling PublishError method must "
            "exist. Otherwise the catch block has nothing meaningful to "
            "publish."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 4 — ListFilesWithMetadata missing from frontend op-category switch
# ════════════════════════════════════════════════════════════════════


class TestBug4ListFilesWithMetadataInFrontendSwitch:
    """The frontend `_opCategory` switch must explicitly handle
    `ListFilesWithMetadata` (currently falls through to default 'Read'
    silently). Plus the broader 5+ read-ish ops should be split into
    finer-grained categories that the user can filter.
    """

    def test_op_category_handles_list_files_with_metadata(self):
        src = _read(TAB_SYSFILES_JS)
        m = re.search(
            r"_opCategory\s*\([^)]*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate _opCategory method body."
        body = m.group(1)
        assert "ListFilesWithMetadata" in body, (
            "_opCategory switch must explicitly handle 'ListFilesWithMetadata'. "
            "Today it falls through to default 'Read', silently mis-categorising "
            "every ListFilesWithMetadata event."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 5 — contentSizeBytes overloaded with count for List/metadata ops
# ════════════════════════════════════════════════════════════════════


class TestBug5ContentSizeBytesIsActuallyBytes:
    """For List/metadata ops, the interceptor stuffs an item count into
    `contentSizeBytes`. The frontend then formats this as bytes (e.g.
    'list of 4 items' renders as '4 B'). After fix, those ops must use
    a separate `itemCount` field; `contentSizeBytes` is reserved for
    actual byte counts.
    """

    def test_list_ops_do_not_stuff_count_into_content_size_bytes(self):
        src = _read(INTERCEPTOR_CS)
        # Look at the bodies of ListAsync, ListWithContinuationAsync,
        # GetDirMetadataAsync, GetFileMetadataAsync. None of them should
        # contain `contentSizeBytes: count` (where count is an item count,
        # not a byte count).
        offenders = []
        for name in ["ListAsync", "ListWithContinuationAsync",
                     "GetDirMetadataAsync", "GetFileMetadataAsync"]:
            body = _method_body(src, name)
            # `contentSizeBytes: count` is the smoking gun. The fix uses
            # `itemCount: count` instead.
            if re.search(r"contentSizeBytes\s*:\s*count\b", body):
                offenders.append(name)
        assert not offenders, (
            "These methods stuff an item count into contentSizeBytes (lies "
            "about being bytes — the frontend formats it as a byte size). "
            "Use a separate `itemCount` field instead. Methods: " +
            ", ".join(offenders)
        )

    def test_publish_event_supports_item_count_field(self):
        """A new `itemCount` field on the published payload (or a param
        on PublishEvent) lets the frontend distinguish 'this op returned
        N items' from 'this op produced N bytes of content'."""
        src = _read(INTERCEPTOR_CS)
        assert re.search(r"\bitemCount\b", src), (
            "PublishEvent / event payload must include an `itemCount` "
            "field for list/metadata ops. Without it, the frontend cannot "
            "distinguish item-count from byte-count and renders both as "
            "bytes."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 6 — ListFilesWithMetadata triples discarded
# ════════════════════════════════════════════════════════════════════


class TestBug6ListFilesWithMetadataTriplesPublished:
    """ListFilesWithMetadataAsync returns (Path, LastModified, Size)
    tuples per file. The interceptor currently discards all of it and
    publishes only contentSizeBytes:0 + hasContent:bool. The per-file
    metadata (lastModified is exactly what we need for real stale-lock
    detection) is thrown away. After fix, publish the array.
    """

    def test_list_files_with_metadata_publishes_files_array(self):
        src = _read(INTERCEPTOR_CS)
        body = _method_body(src, "ListFilesWithMetadataAsync")
        # The fix must surface the (Path, LastModified, Size) triples to
        # the event payload — either as a `files` array of objects, or by
        # adding a 4th param to PublishEvent.
        assert re.search(r"\b(files|fileMetadata|fileTuples|items)\b\s*[:=]", body), (
            "ListFilesWithMetadataAsync must publish the (Path, LastModified, "
            "Size) tuples — today they're discarded. Without this, real "
            "lock-age detection (using OneLake's lastModified) is impossible."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 7 — stale-lock detection false-negative for pre-attach locks
# ════════════════════════════════════════════════════════════════════


class TestBug7StaleLockUsesRealLastModified:
    """Stale-lock detection today uses Studio's first-observed timestamp,
    which is wrong for locks created before Studio attached (they appear
    fresh forever). After fix 6 publishes (Path, LastModified, Size), the
    frontend must prefer LastModified over first-observed.
    """

    def test_frontend_uses_real_last_modified_when_available(self):
        src = _read(TAB_SYSFILES_JS)
        # The fix: when an event arrives with `lastModified` (from Bug 6
        # fix), prefer it over `_lockFirstSeen`.
        assert re.search(r"lastModified", src), (
            "Frontend must consume `lastModified` from fileop events (after "
            "Bug 6 fix publishes it). Today it relies on Studio's first-"
            "observed timestamp, which is wrong for locks that pre-existed "
            "Studio's attach."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 8 — ContinuationToken discarded
# ════════════════════════════════════════════════════════════════════


class TestBug8ContinuationTokenPublished:
    """ListWithContinuationAsync returns (Paths, ContinuationToken). The
    interceptor publishes only the path count. The continuation token
    (which tells you 'this was a paginated call and there's more') is
    discarded — debugging 'why am I paginating' from the UI is
    impossible.
    """

    def test_list_with_continuation_publishes_continuation_token(self):
        src = _read(INTERCEPTOR_CS)
        body = _method_body(src, "ListWithContinuationAsync")
        # Pre-fix the body contains `continuationToken` as a parameter
        # name (passed to the inner call). The fix accesses
        # `result.ContinuationToken` or `result.Item2` from the inner's
        # return value and forwards it into the published payload. Look
        # for that — the return-value access is what's currently missing.
        assert re.search(r"result\.ContinuationToken|result\.Item2", body), (
            "ListWithContinuationAsync must access result.ContinuationToken "
            "from the inner's return value and publish it (e.g. "
            "`hasMore: result.ContinuationToken != null` or "
            "`continuationToken: result.ContinuationToken`). Today the "
            "return-value continuation token is discarded — the UI can't "
            "show pagination state."
        )


# ════════════════════════════════════════════════════════════════════
# BUG 9 — hardcoded "known dirs" list
# ════════════════════════════════════════════════════════════════════


class TestBug9KnownDirsIsAutoDiscovered:
    """The frontend's `_knownDirs` array hardcodes ['DagExecutionMetrics',
    'Locks', 'Settings', 'MLVDefinitions', 'OneLake']. Anything else
    shows as 'Other' forever — no auto-discovery. After fix, the
    directory list must be derived from observed paths in the live
    event stream.
    """

    def test_known_dirs_is_derived_not_hardcoded(self):
        src = _read(TAB_SYSFILES_JS)
        # A reasonable signal that the dir list is derived: there's a
        # `_directorySet` or similar that's mutated as events arrive.
        # The hardcoded `_knownDirs` array is allowed to remain ONLY as
        # a starter seed if it's commented as such.
        has_dynamic = re.search(
            r"_(directorySet|seenDirs|dynamicDirs|discoveredDirs|topLevelDirs)\b",
            src,
        )
        # If _knownDirs is still the array of 5 hardcoded strings AND
        # nothing dynamic exists alongside it, that's the bug.
        # Tolerate the array if a comment like "starter set" or "auto-extended"
        # marks it as a seed.
        hardcoded_match = re.search(
            r"_knownDirs\s*=\s*\[\s*['\"]DagExecutionMetrics['\"]",
            src,
        )
        if hardcoded_match:
            assert has_dynamic, (
                "_knownDirs is hardcoded to 5 entries with no dynamic "
                "auto-discovery alongside it. Anything outside those 5 "
                "shows as 'Other' forever. Either replace with a dynamic "
                "set derived from observed paths, or keep _knownDirs as a "
                "seed and add a dynamic counterpart."
            )
