"""
Additional telemetry channel — source-level guards.

Bug history (Hemant 2026-06-07 13:13):
  "not all telemetry are getting emitted correctly"

Root cause: FLT has TWO telemetry interfaces. Studio only intercepted ONE.

  ICustomLiveTableTelemetryReporter.EmitStandardizedServerReporting     ← intercepted
  ILiveTableAdditionalTelemetryReporter.EmitTelemetry                   ← INVISIBLE

The Additional channel carries NodeExecutor per-node events,
DagExecutionHandlerV2 RunDag feature-usage, and every controller's
feature-usage emission. Those landed as plain Tracer log lines (losing
their semantic) and were buried as noise.

Fix: EdogAdditionalTelemetryInterceptor decorates the Additional channel,
maps EmitTelemetry → TelemetryEvent { Channel="additional" }, routes to
the same EdogLogServer.AddTelemetry. Registered via the late-DI TryWrap
pattern in EdogDevModeRegistrar (NOT in WorkloadApp.cs constructor —
LiveTableAdditionalTelemetryReporter's ctor resolves MWC services that
aren't available that early).

These tests enforce the constraints that, if any one is violated, would
re-introduce the bug:

  1. The interceptor file exists.
  2. It decorates the right interface (ILiveTableAdditionalTelemetryReporter).
  3. It tags events with Channel="additional" (not the default "ssr").
  4. It pulls IterationId using the same priority order as SSR.
  5. It calls EdogLogInterceptor.RegisterRootActivityMapping so log lines
     with the same correlation id inherit the iteration (cross-channel
     consistency).
  6. It forwards to the inner reporter (production telemetry flow stays
     intact — sidecar, not replacement).
  7. The TelemetryEvent model carries the Channel + EventId fields.
  8. EdogDevModeRegistrar.RegisterAll() calls
     RegisterAdditionalTelemetryInterceptor().
  9. EdogDiRegistryCapture publishes the wrap (DI registry UI shows it).
 10. edog.py SOURCE_FILES dict includes the new interceptor (it gets
     copied into FLT on deploy).
"""

from __future__ import annotations

import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVMODE = os.path.join(REPO, "src", "backend", "DevMode")

ADDL_INTERCEPTOR = os.path.join(DEVMODE, "EdogAdditionalTelemetryInterceptor.cs")
SSR_INTERCEPTOR = os.path.join(DEVMODE, "EdogTelemetryInterceptor.cs")
LOG_MODELS = os.path.join(DEVMODE, "EdogLogModels.cs")
REGISTRAR = os.path.join(DEVMODE, "EdogDevModeRegistrar.cs")
DI_CAPTURE = os.path.join(DEVMODE, "EdogDiRegistryCapture.cs")
EDOG_PY = os.path.join(REPO, "edog.py")
TOPBAR_JS = os.path.join(REPO, "src", "frontend", "js", "topbar.js")


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


# ── 1. The interceptor file exists and declares the right shape ─────────


class TestInterceptorFileShape:
    def test_file_exists(self):
        assert os.path.exists(ADDL_INTERCEPTOR), (
            f"EdogAdditionalTelemetryInterceptor.cs missing at {ADDL_INTERCEPTOR}. "
            f"The Additional telemetry channel is invisible without it."
        )

    def test_declares_class_that_implements_additional_reporter(self):
        src = _read(ADDL_INTERCEPTOR)
        m = re.search(
            r"class\s+EdogAdditionalTelemetryInterceptor\s*:\s*ILiveTableAdditionalTelemetryReporter\b",
            src,
        )
        assert m, (
            "EdogAdditionalTelemetryInterceptor must implement "
            "ILiveTableAdditionalTelemetryReporter (the interface defined in "
            "FLT's Telemetry/ILiveTableAdditionalTelemetryReporter.cs). Without "
            "the right interface declaration, the DI wrap is a no-op."
        )

    def test_constructor_takes_inner_reporter_and_log_server(self):
        src = _read(ADDL_INTERCEPTOR)
        # Constructor signature: takes the inner reporter (for forwarding) AND
        # EdogLogServer (sink for TelemetryEvent records).
        m = re.search(
            r"public\s+EdogAdditionalTelemetryInterceptor\s*\(\s*"
            r"ILiveTableAdditionalTelemetryReporter\s+\w+\s*,\s*"
            r"EdogLogServer\s+\w+\s*\)",
            src,
        )
        assert m, (
            "Constructor must be (ILiveTableAdditionalTelemetryReporter inner, "
            "EdogLogServer server). Anything else breaks the registrar's "
            "createWrapper lambda."
        )


# ── 2. Channel tagging is correct ───────────────────────────────────────


class TestChannelTagging:
    def test_event_tagged_with_channel_additional(self):
        src = _read(ADDL_INTERCEPTOR)
        # Must explicitly set Channel = "additional" on every emitted event.
        # If this guard fires green but events still show as "ssr" in the UI,
        # the assignment is in the wrong code path (e.g., inside a never-hit
        # branch). Mutation test by deleting the assignment.
        m = re.search(
            r'telemetryEvent\.Channel\s*=\s*"additional"\s*;',
            src,
        )
        assert m, (
            'Emitted TelemetryEvent must set Channel = "additional". Without '
            "this, the UI cannot distinguish SSR from Additional events, and "
            "all the channel-aware aggregations and filters will silently "
            "treat Additional as SSR."
        )

    def test_event_id_preserved(self):
        src = _read(ADDL_INTERCEPTOR)
        assert re.search(r"telemetryEvent\.EventId\s*=\s*eventId\s*;", src), (
            "EventId must be preserved on the TelemetryEvent. Additional events "
            "have a meaningful eventId distinct from activityName (e.g. "
            "NodeExecutionCompleted vs. activity-style RunDag) and dropping it "
            "loses semantic information needed for the new tab's filtering."
        )


# ── 3. IterationId resolution mirrors SSR ───────────────────────────────


class TestIterationIdResolution:
    def test_prefers_iteration_id_from_attributes(self):
        src = _read(ADDL_INTERCEPTOR)
        # Same priority as SSR: attributes.IterationId first, then trailing
        # GUID on correlationId. If either is dropped, the new Telemetry tab's
        # iteration spine will under-attribute Additional events.
        assert re.search(
            r'attributes\.TryGetValue\(\s*"IterationId"',
            src,
        ), "Must prefer IterationId from attributes (same as SSR interceptor)."

    def test_falls_back_to_correlation_id_guid_suffix(self):
        src = _read(ADDL_INTERCEPTOR)
        assert "GuidSuffixRegex" in src, (
            "Must define GuidSuffixRegex matching the SSR interceptor — used "
            "as the IterationId fallback when attributes don't carry it. "
            "Activities like GetLatestDAG won't have attributes.IterationId."
        )
        # Regex shape: trailing GUID after | or -.
        assert re.search(
            r"\[\|\\-\]\(\[0-9a-fA-F\]\{8\}-",
            src,
        ), (
            "GuidSuffixRegex must match the trailing |GUID or -GUID pattern "
            "(rootActivityId|iterationId for async, rootActivityId-iterationId "
            "for sync). Mismatch with SSR's regex creates cross-channel "
            "iteration assignment drift."
        )


# ── 4. Cross-channel log enrichment ────────────────────────────────────


class TestRegistersRootActivityMappingForLogEnrichment:
    def test_calls_register_root_activity_mapping(self):
        src = _read(ADDL_INTERCEPTOR)
        # When an Additional event has an IterationId, we register the
        # rootActivityId → iterationId mapping with EdogLogInterceptor so
        # subsequent log lines sharing that correlationId inherit the
        # iteration. The SSR interceptor does this; the Additional one must
        # too, otherwise Additional-only iterations have no log enrichment.
        assert re.search(
            r"EdogLogInterceptor\.RegisterRootActivityMapping\(",
            src,
        ), (
            "Must call EdogLogInterceptor.RegisterRootActivityMapping for "
            "every event with an IterationId. Without it, an iteration that "
            "only emits Additional telemetry (no SSR) won't propagate "
            "IterationId to its logs, leaving the Logs tab unable to filter "
            "by that iteration."
        )


# ── 5. Forwards to inner (production flow preserved) ───────────────────


class TestForwardsToInnerReporter:
    def test_forwards_emit_telemetry(self):
        src = _read(ADDL_INTERCEPTOR)
        # The whole point of being a decorator is to be transparent to the
        # production telemetry pipeline. If we don't forward, ASTrace loses
        # every Additional event.
        assert re.search(
            r"this\.inner\.EmitTelemetry\(\s*eventId\s*,\s*correlationId\s*,\s*telemetryDetails\s*\)",
            src,
        ), (
            "Must forward EmitTelemetry to this.inner with the original "
            "arguments. Without this, the production ASTrace telemetry "
            "pipeline stops receiving Additional events — that's a P0 "
            "production-data outage caused by a dev tool."
        )

    def test_studio_capture_never_throws(self):
        src = _read(ADDL_INTERCEPTOR)
        # The studio-capture block must be wrapped in try/catch so a bug
        # there never affects FLT's production telemetry. Three guards
        # together prove the contract (semantic checks, not regex parsing
        # of nested C# try/catch — that road leads to madness):
        #   (a) EmitTelemetry's body starts with `try`.
        #   (b) AddTelemetry is called inside that body.
        #   (c) The body contains a catch block whose comment marks it as
        #       the "never throw" guard (matches the SSR interceptor's
        #       documented convention).
        m = re.search(
            r"public\s+void\s+EmitTelemetry\s*\([^)]*\)\s*\{(.*)\n        \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate EmitTelemetry method body."
        body = m.group(1)

        stripped = body.lstrip()
        assert stripped.startswith("try"), (
            f"EmitTelemetry body must open with a try block guarding the studio-capture path. Found: {stripped[:80]!r}"
        )

        assert "this.edogLogServer.AddTelemetry" in body, (
            "AddTelemetry must be invoked in EmitTelemetry — otherwise no "
            "Additional events ever reach the Telemetry tab."
        )

        # The "swallow all" catch block is the explicit contract that this
        # interceptor never propagates studio-side faults back into FLT's
        # telemetry pipeline. The marker comment makes the intent
        # un-deletable-by-accident — a refactor that removes it should
        # fail this guard loudly.
        assert re.search(
            r"catch\s*\{\s*[^}]*Never throw from interception",
            body,
        ), (
            "EmitTelemetry must include a catch block annotated `Never throw "
            "from interception` (matches SSR interceptor convention). Without "
            "this explicit swallow, a studio-side bug bubbles up and kills "
            "FLT's production telemetry."
        )


# ── 6. TelemetryEvent model carries new fields ──────────────────────────


class TestTelemetryEventModel:
    def test_has_channel_property_default_ssr(self):
        src = _read(LOG_MODELS)
        # Channel must be a settable property defaulting to "ssr" so the
        # SSR interceptor (which does not explicitly set it) continues to
        # produce events that the new UI classifies correctly.
        m = re.search(
            r'public\s+string\s+Channel\s*\{\s*get;\s*set;\s*\}\s*=\s*"ssr"\s*;',
            src,
        )
        assert m, (
            "TelemetryEvent.Channel must be `public string Channel { get; set; } "
            '= "ssr";` (default "ssr" preserves backward compat for SSR events '
            "that don't explicitly assign Channel)."
        )

    def test_has_event_id_property(self):
        src = _read(LOG_MODELS)
        assert re.search(
            r"public\s+string\s+EventId\s*\{\s*get;\s*set;\s*\}",
            src,
        ), (
            "TelemetryEvent.EventId must be a settable string. Additional "
            "events have a meaningful eventId; SSR events leave it null."
        )


# ── 7. Registrar wires the new interceptor ──────────────────────────────


class TestRegistrarWiring:
    def test_register_all_calls_additional_interceptor_registration(self):
        src = _read(REGISTRAR)

        # Strip line comments + block comments so a commented-out call
        # cannot satisfy the guard. (The bug we're guarding against is the
        # call being deleted OR commented out during a refactor — either
        # makes the new interceptor dead code.)
        def _strip_comments(s):
            s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
            s = re.sub(r"//[^\n]*", "", s)
            return s

        clean = _strip_comments(src)

        assert re.search(
            r"RegisterAdditionalTelemetryInterceptor\s*\(\s*\)\s*;",
            clean,
        ), (
            "EdogDevModeRegistrar.RegisterAll must invoke "
            "RegisterAdditionalTelemetryInterceptor() — otherwise the new "
            "interceptor is dead code, the Additional channel stays "
            "invisible, and this whole task was for nothing. (Commenting "
            "out the call does NOT satisfy this guard.)"
        )

        # Locate RegisterAll body and confirm the call sits inside it
        # (in the comment-stripped source).
        m = re.search(
            r"public\s+static\s+void\s+RegisterAll\s*\(\s*\)\s*\{(.*?)\n        \}",
            clean,
            re.DOTALL,
        )
        assert m, "Could not locate RegisterAll method body."
        body = m.group(1)
        assert "RegisterAdditionalTelemetryInterceptor()" in body, (
            "RegisterAdditionalTelemetryInterceptor() must be CALLED from "
            "within RegisterAll's body — not just defined and not commented "
            "out."
        )

    def test_registration_uses_trywrap_pattern(self):
        src = _read(REGISTRAR)
        # Locate the RegisterAdditionalTelemetryInterceptor method body.
        m = re.search(
            r"private\s+static\s+void\s+RegisterAdditionalTelemetryInterceptor\s*\(\s*\)\s*\{(.*?)\n        \}",
            src,
            re.DOTALL,
        )
        assert m, (
            "Could not locate RegisterAdditionalTelemetryInterceptor() method. "
            "It must exist as a private static void method on EdogDevModeRegistrar."
        )
        body = m.group(1)
        assert "TryWrap" in body, (
            "Registration must use the existing TryWrap<T> helper (handles "
            "idempotency + already-wrapped detection + error capture). "
            "Hand-rolling registration with WireUp.RegisterInstance bypasses "
            "the safety net."
        )
        assert "ILiveTableAdditionalTelemetryReporter" in body, (
            "TryWrap must be parameterized on ILiveTableAdditionalTelemetryReporter "
            "(not the concrete LiveTableAdditionalTelemetryReporter)."
        )
        assert "new EdogAdditionalTelemetryInterceptor" in body, (
            "createWrapper lambda must construct EdogAdditionalTelemetryInterceptor."
        )


# ── 8. DI registry UI sees the wrap ────────────────────────────────────


class TestDiRegistryCaptureSurfaces:
    def test_publishes_registration_for_additional_reporter(self):
        src = _read(DI_CAPTURE)
        # PublishRegistration for ILiveTableAdditionalTelemetryReporter
        # with EdogAdditionalTelemetryInterceptor as the implementation.
        assert re.search(
            r'PublishRegistration\(\s*"ILiveTableAdditionalTelemetryReporter"\s*,\s*'
            r'"EdogAdditionalTelemetryInterceptor"',
            src,
        ), (
            "EdogDiRegistryCapture must publish the ILiveTableAdditionalTelemetryReporter "
            "registration with EdogAdditionalTelemetryInterceptor as the impl. "
            "Without this, the DI Registry UI shows the original "
            "LiveTableAdditionalTelemetryReporter (unwrapped) and the user has "
            "no way to verify the interception is active."
        )

    def test_intercepted_map_includes_additional_reporter(self):
        src = _read(DI_CAPTURE)
        # IsEdogIntercepted switch must contain the new interface.
        assert re.search(
            r'"ILiveTableAdditionalTelemetryReporter"\s*=>\s*true',
            src,
        ), "IsEdogIntercepted must return true for ILiveTableAdditionalTelemetryReporter."
        assert re.search(
            r'"ILiveTableAdditionalTelemetryReporter"\s*=>\s*"EdogAdditionalTelemetryInterceptor"',
            src,
        ), "GetEdogWrapperName must return EdogAdditionalTelemetryInterceptor for the Additional reporter."


# ── 9. Deployment: edog.py copies the new file into FLT ─────────────────


class TestEdogPyCopiesInterceptor:
    def test_source_files_includes_interceptor(self):
        src = _read(EDOG_PY)
        # The DEVMODE_FILES dict must contain the new entry. Without this,
        # the file lives in this repo but never makes it into the FLT deploy.
        assert re.search(
            r'"EdogAdditionalTelemetryInterceptor"\s*:\s*SERVICE_PATH\s*/\s*'
            r'"DevMode/EdogAdditionalTelemetryInterceptor\.cs"',
            src,
        ), (
            'edog.py DEVMODE_FILES must include "EdogAdditionalTelemetryInterceptor". '
            "Otherwise the C# file lives in edog-studio's repo but is never "
            "copied into workload-fabriclivetable on `edog deploy`, the FLT "
            "build can't find the class, EdogDevModeRegistrar fails to find the "
            "wrapper type, and we silently regress to the no-interceptor state."
        )


# ── 10. Topbar marker recognizes the new interceptor ───────────────────


class TestTopbarMarkerRecognition:
    def test_topbar_regex_recognizes_additional_interceptor(self):
        src = _read(TOPBAR_JS)
        assert re.search(
            r"/EdogAdditionalTelemetryInterceptor/",
            src,
        ), (
            "topbar.js _edogAnnotations must include a regex for "
            "EdogAdditionalTelemetryInterceptor so the marker dropdown "
            "labels mentions of the new interceptor correctly."
        )
