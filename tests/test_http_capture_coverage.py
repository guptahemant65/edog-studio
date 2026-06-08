"""
HTTP capture coverage — failing tests pinning the "only OneLake captured"
bug.

Bug catalog (matches plan.md):

  Coverage gaps:
    C1  Critical  GTS / Spark control plane traffic invisible
                  (GTSBasedSparkClient uses workloadContext.WorkloadCommunicationProvider
                  bypass; EDOG hook is only on IHttpClientFactory).
    C2  Critical  Notebook API traffic invisible (same bypass).
    C3  High      LiveTableCommunicationClient (Trident throttling) traffic
                  invisible (constructor-injected provider; auto-fixed by the
                  IWorkloadCommunicationProvider wrap).

  Existing handler bugs (re-audited from previous turn):
    H1  Critical  base.SendAsync not in try/catch — failed HTTP calls
                  (DNS / timeout / socket reset / cert errors) NEVER publish.
    H2  High      No rootActivityId / iterationId on event payload —
                  HTTP calls can't be correlated to a DAG iteration.

Fix architecture:
    - EdogWorkloadCommunicationProviderWrapper — wraps IWorkloadCommunicationProvider.
      Every Get*HttpClient*Async return value is reflectively re-handlered to
      prepend EdogHttpPipelineHandler. Closes C3 immediately (via WireUp).
    - 2 edog.py patches that rewrite GTSBasedSparkClient.cs:119 and
      NotebookApiClient.cs:87 to use WireUp.Resolve<IWorkloadCommunicationProvider>()
      instead of this.workloadContext.WorkloadCommunicationProvider. Closes C1, C2.
    - EdogHttpPipelineHandler gets try/catch + rootActivityId + iterationId.
      Closes H1, H2 for ALL captured paths (OneLake + new MWC ones).
"""

from __future__ import annotations

import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVMODE = os.path.join(REPO, "src", "backend", "DevMode")
FRONTEND_JS = os.path.join(REPO, "src", "frontend", "js")

HTTP_HANDLER = os.path.join(DEVMODE, "EdogHttpPipelineHandler.cs")
TOKEN_INTERCEPTOR = os.path.join(DEVMODE, "EdogTokenInterceptor.cs")
WRAPPER_CS = os.path.join(DEVMODE, "EdogWorkloadCommunicationProviderWrapper.cs")
REGISTRAR_CS = os.path.join(DEVMODE, "EdogDevModeRegistrar.cs")
DI_CAPTURE_CS = os.path.join(DEVMODE, "EdogDiRegistryCapture.cs")
LOG_INTERCEPTOR = os.path.join(DEVMODE, "EdogLogInterceptor.cs")
EDOG_PY = os.path.join(REPO, "edog.py")
TOPBAR_JS = os.path.join(FRONTEND_JS, "topbar.js")


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


def _strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
    s = re.sub(r"//[^\n]*", "", s)
    return s


# ════════════════════════════════════════════════════════════════════
# C1 + C2 + C3 — IWorkloadCommunicationProvider wrap class exists
# ════════════════════════════════════════════════════════════════════


class TestWorkloadCommunicationProviderWrapperExists:
    """Without this class, GTS/Spark/Notebook/Trident HTTP traffic is
    invisible — they go through Get*HttpClient*Async, not
    IHttpClientFactory. The wrap reflectively re-handlers the returned
    HttpClient with EdogHttpPipelineHandler."""

    def test_file_exists(self):
        assert os.path.exists(WRAPPER_CS), (
            f"EdogWorkloadCommunicationProviderWrapper.cs missing at {WRAPPER_CS}. "
            "Without this class, MWC-platform HttpClients (GTS, Notebook, Trident "
            "throttling, etc.) are uncaptured."
        )

    def test_class_implements_iworkload_communication_provider(self):
        """The wrapper uses System.Reflection.DispatchProxy to generate
        a runtime proxy that implements the interface (the interface has
        internal members that cannot be implemented by hand from outside
        the MWC assembly — see the class XML doc for the full Catch-22
        explanation). Verify the DispatchProxy contract: extends
        DispatchProxy, factory method Create() returns an instance
        cast to the interface, Invoke override forwards to inner."""
        src = _read(WRAPPER_CS)
        assert re.search(
            r"class\s+EdogWorkloadCommunicationProviderWrapper\s*:\s*DispatchProxy\b",
            src,
        ), (
            "EdogWorkloadCommunicationProviderWrapper must extend "
            "System.Reflection.DispatchProxy. A hand-rolled "
            "`: IWorkloadCommunicationProvider` implementation cannot "
            "compile because the interface has internal members that "
            "the FLT assembly cannot reference."
        )
        # The Create factory must return the interface type, not the class.
        assert re.search(
            r"public\s+static\s+IWorkloadCommunicationProvider\s+Create\s*\(",
            src,
        ), (
            "EdogWorkloadCommunicationProviderWrapper must expose a "
            "`public static IWorkloadCommunicationProvider Create(...)` "
            "factory (DispatchProxy requires runtime construction)."
        )

    def test_constructor_takes_inner_provider(self):
        """DispatchProxy needs a parameterless ctor (so the runtime can
        instantiate the generated proxy), AND Create() must accept the
        inner provider so it can be stashed for forwarding."""
        src = _read(WRAPPER_CS)
        assert re.search(
            r"public\s+EdogWorkloadCommunicationProviderWrapper\s*\(\s*\)",
            src,
        ), (
            "DispatchProxy requires a public parameterless constructor on "
            "the proxy class. Without it, DispatchProxy.Create throws at "
            "runtime."
        )
        assert re.search(
            r"public\s+static\s+IWorkloadCommunicationProvider\s+Create\s*\(\s*"
            r"IWorkloadCommunicationProvider\s+\w+\s*\)",
            src,
        ), "Create factory must take the inner provider so it can be stashed for Invoke() to forward to."

    def test_wraps_get1p_workload_http_client_async(self):
        """DispatchProxy intercepts ALL methods via Invoke(MethodInfo, args)
        — including Get1PWorkloadHttpClientAsync. We don't reference the
        method by name in source (that's the whole point — internal members
        cannot be named). Verify the Invoke override exists and that
        HttpClient-returning calls get wrapped."""
        src = _read(WRAPPER_CS)
        assert re.search(
            r"protected\s+override\s+object\s+Invoke\s*\(\s*MethodInfo\b",
            src,
        ), (
            "DispatchProxy subclass must override "
            "`protected override object Invoke(MethodInfo targetMethod, object[] args)` "
            "— that's the single hook through which ALL interface methods "
            "(including Get1PWorkloadHttpClientAsync) are intercepted."
        )
        # Invoke must do the wrap for HttpClient-returning tasks.
        assert "Task<HttpClient>" in src, (
            "Invoke must check for Task<HttpClient> return types and wrap "
            "them — that's the entire point of the wrapper."
        )
        # And it must call WrapHttpClient (or equivalent) so the EDOG
        # handler chain is spliced in.
        assert re.search(r"WrapHttpClient", src), (
            "Invoke must call WrapHttpClient on HttpClient returns to "
            "splice EdogHttpPipelineHandler into the handler chain."
        )

    def test_wraps_inner_client_with_edog_handler(self):
        """The whole point: wrapped HttpClients must have
        EdogHttpPipelineHandler prepended to their handler chain."""
        src = _read(WRAPPER_CS)
        clean = _strip_comments(src)
        assert "EdogHttpPipelineHandler" in clean, (
            "Wrapper must construct EdogHttpPipelineHandler and inject it into "
            "the returned HttpClient's handler chain. Without that, the wrap "
            "is decoration with no effect."
        )

    def test_uses_reflection_on_http_message_invoker_handler(self):
        """The pattern used by EdogHttpClientFactoryWrapper.CreateClient:
        reflect into HttpMessageInvoker._handler to grab the existing
        chain, then wrap it with EDOG handlers."""
        src = _read(WRAPPER_CS)
        clean = _strip_comments(src)
        # Either uses the field name "_handler" via reflection, OR delegates
        # to a shared helper. The reflection literal is the marker.
        assert re.search(r"\"_handler\"", clean) or "WrapHttpClient" in clean, (
            "Wrapper must use the same reflection trick as "
            "EdogHttpClientFactoryWrapper to inject EdogHttpPipelineHandler. "
            'Look for `"_handler"` GetField() or a shared WrapHttpClient helper.'
        )


# ════════════════════════════════════════════════════════════════════
# Registrar wires the new wrap
# ════════════════════════════════════════════════════════════════════


class TestRegistrarWiringForWorkloadCommunicationProvider:
    def test_register_all_calls_workload_comm_provider_registration(self):
        src = _read(REGISTRAR_CS)
        clean = _strip_comments(src)
        assert re.search(
            r"RegisterWorkloadCommunicationProviderInterceptor\s*\(\s*\)\s*;",
            clean,
        ), (
            "EdogDevModeRegistrar.RegisterAll must invoke "
            "RegisterWorkloadCommunicationProviderInterceptor() — otherwise "
            "the new wrapper class is dead code."
        )
        # And it must be inside RegisterAll's body, not just defined.
        m = re.search(
            r"public\s+static\s+void\s+RegisterAll\s*\(\s*\)\s*\{(.*?)\n        \}",
            clean,
            re.DOTALL,
        )
        assert m, "Could not locate RegisterAll method body."
        assert "RegisterWorkloadCommunicationProviderInterceptor()" in m.group(1), (
            "The call must live INSIDE RegisterAll's body, not commented out and not defined-but-uncalled."
        )

    def test_registration_bypasses_trywrap_for_disposable_provider(self):
        # ROOT CAUSE PIN (2026-06-07): the concrete WorkloadCommunicationProvider
        # implements IDisposable. TryWrap<T> has a committed, intentional guard
        # (EdogDevModeRegistrar.cs "if (inner is IDisposable ...)") that REFUSES
        # to wrap any IDisposable/IAsyncDisposable inner and records Failed — its
        # own comment says "Use a dedicated registration method". Routing this
        # provider through TryWrap is therefore precisely the "only OneLake
        # captured" bug: GTS/Spark/Notebook never get the EDOG handler.
        #
        # This test pins the fix: the method must NOT invoke TryWrap, and must
        # instead Resolve -> already-wrapped check -> Create -> RegisterInstance
        # -> Record itself. Comments are stripped first so the explanatory
        # "DO NOT use TryWrap" comment cannot mask a real TryWrap call.
        src = _read(REGISTRAR_CS)
        m = re.search(
            r"private\s+static\s+void\s+RegisterWorkloadCommunicationProviderInterceptor\s*\(\s*\)\s*\{(.*?)\n        \}",
            src,
            re.DOTALL,
        )
        assert m, "RegisterWorkloadCommunicationProviderInterceptor must exist as a private static void method."
        body = _strip_comments(m.group(1))

        assert not re.search(r"\bTryWrap\s*[<(]", body), (
            "RegisterWorkloadCommunicationProviderInterceptor must NOT call "
            "TryWrap — the provider implements IDisposable and TryWrap's "
            "IDisposable guard blocks it (records Failed), which is the "
            "root cause of the 'only OneLake captured' bug. Wrap the existing "
            "instance directly instead."
        )
        assert re.search(
            r"WireUp\.Resolve<\s*Microsoft\.MWC\.Workload\.Client\.Library\.Providers\.IWorkloadCommunicationProvider\s*>\(\s*\)",
            body,
        ), "Must Resolve the existing IWorkloadCommunicationProvider singleton."
        assert "EdogWorkloadCommunicationProviderWrapper.Create" in body, (
            "Must wrap the existing instance via the DispatchProxy factory "
            "EdogWorkloadCommunicationProviderWrapper.Create (the wrapper "
            "extends DispatchProxy, so it cannot be constructed with `new`)."
        )
        assert re.search(r"is\s+EdogWorkloadCommunicationProviderWrapper", body), (
            "Must keep an already-wrapped idempotency check "
            "(`inner is EdogWorkloadCommunicationProviderWrapper`) so a second "
            "RegisterAll pass does not double-wrap."
        )
        assert re.search(
            r"RegisterInstance<\s*Microsoft\.MWC\.Workload\.Client\.Library\.Providers\.IWorkloadCommunicationProvider\s*>",
            body,
        ), "Must RegisterInstance the wrapper under IWorkloadCommunicationProvider."
        assert "EdogInterceptorRegistry.Record" in body, (
            "Must record registration status (Ok/Failed/AlreadyWrapped) to "
            "EdogInterceptorRegistry so the DevTools registry surfaces it."
        )


# ════════════════════════════════════════════════════════════════════
# DI registry capture surfaces the wrap
# ════════════════════════════════════════════════════════════════════


class TestDiRegistryCaptureSurfacesWorkloadCommProvider:
    def test_publishes_registration_for_provider(self):
        src = _read(DI_CAPTURE_CS)
        assert re.search(
            r'PublishRegistration\(\s*"IWorkloadCommunicationProvider"\s*,\s*'
            r'"EdogWorkloadCommunicationProviderWrapper"',
            src,
        ), (
            "EdogDiRegistryCapture must publish IWorkloadCommunicationProvider "
            "with EdogWorkloadCommunicationProviderWrapper as the impl. Without "
            "this, the DI registry UI shows the original (unwrapped) provider "
            "and the user has no way to verify interception is active."
        )

    def test_intercepted_map_includes_workload_comm_provider(self):
        src = _read(DI_CAPTURE_CS)
        assert re.search(r'"IWorkloadCommunicationProvider"\s*=>\s*true', src), (
            "IsEdogIntercepted must return true for IWorkloadCommunicationProvider."
        )
        assert re.search(
            r'"IWorkloadCommunicationProvider"\s*=>\s*"EdogWorkloadCommunicationProviderWrapper"',
            src,
        ), "GetEdogWrapperName must return EdogWorkloadCommunicationProviderWrapper."


# ════════════════════════════════════════════════════════════════════
# edog.py: deploy the new file
# ════════════════════════════════════════════════════════════════════


class TestEdogPyDeploysWrapperFile:
    def test_source_files_includes_wrapper(self):
        src = _read(EDOG_PY)
        assert re.search(
            r'"EdogWorkloadCommunicationProviderWrapper"\s*:\s*SERVICE_PATH\s*/\s*'
            r'"DevMode/EdogWorkloadCommunicationProviderWrapper\.cs"',
            src,
        ), (
            "edog.py DEVMODE_FILES must include EdogWorkloadCommunicationProviderWrapper "
            "— otherwise the file never reaches the FLT deploy and the registrar "
            "fails to resolve the type."
        )


# ════════════════════════════════════════════════════════════════════
# edog.py: patches for GTS and Notebook bypass sites
# ════════════════════════════════════════════════════════════════════


class TestEdogPyPatchesBypassSites:
    """GTSBasedSparkClient and NotebookApiClient read the provider via
    `this.workloadContext.WorkloadCommunicationProvider`, which bypasses
    the WireUp registration we're wrapping. Two edog.py patches rewrite
    those exact lines to use WireUp.Resolve<IWorkloadCommunicationProvider>()
    so they pick up the wrapped instance."""

    def test_patch_for_gts_spark_client_defined(self):
        src = _read(EDOG_PY)
        # The patch function should mention the file we're patching by name
        # and the anchor we're replacing.
        assert re.search(
            r"GTSBasedSparkClient\.cs",
            src,
        ), (
            "edog.py must reference GTSBasedSparkClient.cs in the patch "
            "logic. Without the patch, GTS still reads the provider via the "
            "this.workloadContext bypass and the wrap is ineffective for the "
            "single biggest HTTP surface (every Spark job submit + status poll)."
        )
        # The patch must contain the search-and-replace anchor — specifically
        # the "this.workloadContext.WorkloadCommunicationProvider" string the
        # patch is supposed to find.
        assert re.search(
            r"this\.workloadContext\.WorkloadCommunicationProvider",
            src,
        ), (
            "edog.py must contain the literal "
            "`this.workloadContext.WorkloadCommunicationProvider` anchor "
            "string for the GTS patch."
        )

    def test_patch_for_notebook_api_client_defined(self):
        src = _read(EDOG_PY)
        assert re.search(
            r"NotebookApiClient\.cs",
            src,
        ), (
            "edog.py must reference NotebookApiClient.cs in the patch logic. "
            "Without the patch, Notebook API calls remain invisible."
        )

    def test_replacement_uses_wireup_resolve(self):
        src = _read(EDOG_PY)
        # Both GTS and Notebook each need apply + revert functions, AND each
        # of those must reference the fully-qualified WireUp.Resolve marker.
        # Total expected: 4 occurrences (2 patches * {apply, revert}).
        # Requiring >= 4 pins the marker in all 4 spots — a mutation that
        # silently undoes any one of them fails this guard.
        matches = re.findall(
            r"WireUp\.Resolve<\s*Microsoft\.MWC\.Workload\.Client\.Library\.Providers\.IWorkloadCommunicationProvider\s*>\(\s*\)",
            src,
        )
        assert len(matches) >= 4, (
            "edog.py must contain at least 4 occurrences of "
            "`WireUp.Resolve<Microsoft.MWC.Workload.Client.Library.Providers.IWorkloadCommunicationProvider>()` "
            "— one in each of: apply_workload_comm_provider_bypass_gts, "
            "revert_workload_comm_provider_bypass_gts, "
            "apply_workload_comm_provider_bypass_notebook, "
            "revert_workload_comm_provider_bypass_notebook. "
            f"Found {len(matches)}. A single missing marker means a "
            "patch silently reverts to the bypassed call site."
        )


# ════════════════════════════════════════════════════════════════════
# H1 — failed HTTP calls are captured (try/catch around base.SendAsync)
# ════════════════════════════════════════════════════════════════════


class TestH1FailedHttpCallsCaptured:
    """Today, when base.SendAsync throws (DNS, timeout, socket reset, cert
    error), the exception escapes line 217 and the response-publish block
    at line 220 is never entered. Failed HTTP calls are silent. Fix:
    try/catch around base.SendAsync; on throw, publish a synthetic event
    with success=false, errorMessage, errorType BEFORE rethrowing."""

    def test_send_async_call_is_inside_try_catch(self):
        src = _read(HTTP_HANDLER)
        # Extract the SendAsync method body.
        m = re.search(
            r"protected\s+override\s+async\s+Task<HttpResponseMessage>\s+SendAsync\s*\([^)]*\)\s*\{(.*)\n        \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate SendAsync method body."
        body = m.group(1)

        # Pre-fix vs post-fix discrimination: today the only `catch` block
        # in SendAsync just logs to Debug.WriteLine — it never publishes a
        # failure event. The fix introduces a catch block that publishes
        # before rethrowing. We require AT LEAST ONE catch in SendAsync
        # whose body contains a Publish* call AND a `throw` statement —
        # that's the unique shape of the failure-capture catch.
        # (Naive brace-walk fails on this file due to nested MITM tries
        # whose ranges overlap the structural detection.)
        catch_blocks = []
        for cm in re.finditer(r"\bcatch\b[^{]*\{", body):
            open_idx = cm.end() - 1
            depth = 0
            i = open_idx
            while i < len(body):
                if body[i] == "{":
                    depth += 1
                elif body[i] == "}":
                    depth -= 1
                    if depth == 0:
                        catch_blocks.append(body[open_idx + 1 : i])
                        break
                i += 1

        assert catch_blocks, "No catch blocks found in SendAsync method."

        publishes_failure = False
        for cb in catch_blocks:
            has_publish = re.search(r"Publish(HttpEvent|Failure|HttpFailure|Error)\s*\(", cb)
            has_throw = re.search(r"\bthrow\b", cb)
            if has_publish and has_throw:
                publishes_failure = True
                break

        assert publishes_failure, (
            "SendAsync has no catch block that publishes a failure event "
            "before rethrowing. Today the upstream throws from "
            "`await base.SendAsync(...)` escape entirely and the failed HTTP "
            "call is INVISIBLE on the HTTP tab. Fix: wrap base.SendAsync in "
            "try/catch; the catch must call PublishHttpEvent/PublishFailure "
            "with success=false (or equivalent) AND `throw;` to preserve the "
            "original FLT behaviour."
        )

    def test_publish_event_has_error_fields(self):
        src = _read(HTTP_HANDLER)
        # PublishHttpEvent (or a sibling PublishFailure) must accept error
        # info so the catch block can publish meaningful failure events.
        has_error_param = re.search(
            r"PublishHttpEvent\b[^)]*\b(errorMessage|errorType|exception|isError|success)\b",
            src,
            re.DOTALL,
        )
        has_failure_method = re.search(
            r"\bprivate\s+void\s+(PublishFailure|PublishHttpFailure|PublishError)\b",
            src,
        )
        assert has_error_param or has_failure_method, (
            "PublishHttpEvent must support error fields (errorMessage / "
            "errorType / success), OR a sibling PublishFailure method must "
            "exist. Otherwise the catch block has nothing meaningful to publish."
        )


# ════════════════════════════════════════════════════════════════════
# H2 — rootActivityId + iterationId on event payload
# ════════════════════════════════════════════════════════════════════


class TestH2RootActivityAndIterationInPayload:
    def test_handler_reads_root_activity_id(self):
        src = _read(HTTP_HANDLER)
        assert re.search(r"MonitoredScope\.RootActivityId", src), (
            "EdogHttpPipelineHandler must read MonitoredScope.RootActivityId "
            "at publish time. Without this, HTTP events cannot be correlated "
            "to a DAG iteration."
        )

    def test_handler_uses_iteration_lookup(self):
        src = _read(HTTP_HANDLER)
        clean = _strip_comments(src)
        assert re.search(
            r"EdogLogInterceptor\.TryGetIterationForRootActivity\s*\(",
            clean,
        ), (
            "EdogHttpPipelineHandler must derive iterationId via "
            "EdogLogInterceptor.TryGetIterationForRootActivity(...) — same "
            "pattern as the file-system and Additional-telemetry interceptors. "
            "(Commenting out the call does NOT satisfy this guard.)"
        )

    def test_payload_includes_root_activity_id_field(self):
        src = _read(HTTP_HANDLER)
        # The published payload (anon object or Dictionary) must include
        # rootActivityId as a key. Search the full file for either:
        #   { ..., rootActivityId = ..., ... }     (anon object)
        #   ["rootActivityId"] = ...                (dictionary)
        assert re.search(r"\brootActivityId\b\s*[=,]", src) or re.search(r'\["rootActivityId"\]', src), (
            "The http event payload must include a `rootActivityId` field. "
            "Without it, downstream consumers (iteration spine, cross-tab "
            "correlation) have no way to group HTTP calls by RAID."
        )

    def test_payload_includes_iteration_id_field(self):
        src = _read(HTTP_HANDLER)
        assert re.search(r"\biterationId\b\s*[=,]", src) or re.search(r'\["iterationId"\]', src), (
            "The http event payload must include an `iterationId` field "
            "(best-effort, may be null). Without it, the Telemetry / Logs / "
            "DAG views cannot filter HTTP calls by iteration."
        )


# ════════════════════════════════════════════════════════════════════
# Topbar marker recognises the new wrapper
# ════════════════════════════════════════════════════════════════════


class TestTopbarMarkerRecognition:
    def test_topbar_recognises_workload_comm_provider_wrapper(self):
        src = _read(TOPBAR_JS)
        assert re.search(r"/EdogWorkloadCommunicationProviderWrapper/", src), (
            "topbar.js _edogAnnotations must include a regex for "
            "EdogWorkloadCommunicationProviderWrapper so deploy-banner "
            "mentions of the new wrapper get a friendly label."
        )
