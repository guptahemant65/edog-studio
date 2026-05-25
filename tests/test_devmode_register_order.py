"""Guardrail: `EdogDevModeRegistrar.RegisterAll()` must install the S2S
token bypass BEFORE any interceptor whose `TryWrap` call can transitively
construct a singleton that constructor-injects `IS2STokenProvider`.

Why this matters
----------------
Unity resolves singleton graphs eagerly. When `TryWrap<ICatalogHandler>()`
calls `Resolve<ICatalogHandler>()`, Unity also constructs the transitively
required `S2STokenProvider` and freezes that reference into `CatalogHandler`'s
`readonly s2STokenProvider` field. If we then `RegisterInstance` a wrapped
S2S provider, the DI binding updates but the already-constructed
`CatalogHandler` still holds the original — every subsequent call to it
bypasses our bypass.

This bug was latent from `c5b7e3b feat: S2S token bypass` until it bit us
in production with `S2SAuthenticationException` on `/getLatestDag`. The fix
was to hoist `RegisterS2STokenBypass()` to run before any S2S consumer is
constructed. This test pins that invariant.

Known FLT singletons that constructor-inject `IS2STokenProvider`:
  • CatalogHandler                  -> wrapped by RegisterCatalogInterceptor
  • GTSBasedSparkClientFactory      -> wrapped by RegisterSparkSessionInterceptor
  • PBIHttpClientFactory            -> not currently wrapped (still safe-guarded)
  • OneLakeRestClient               -> not currently wrapped (still safe-guarded)
  • GTSBasedSparkClient             -> built on demand by the factory above

When adding a new `Register*` call that triggers `TryWrap` on a type that
takes `IS2STokenProvider` in its constructor, add it to
`_S2S_CONSUMER_REGISTRATIONS` below so this test enforces the ordering.
"""

import re
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
REGISTRAR_CS = PROJECT_DIR / "src" / "backend" / "DevMode" / "EdogDevModeRegistrar.cs"

# Interceptors whose TryWrap call may transitively cause Unity to construct
# a singleton that constructor-injects IS2STokenProvider. The S2S bypass
# MUST be registered before any of these.
_S2S_CONSUMER_REGISTRATIONS = (
    "RegisterCatalogInterceptor",  # builds CatalogHandler
    "RegisterSparkSessionInterceptor",  # builds GTSBasedSparkClientFactory
)

_BYPASS_REGISTRATION = "RegisterS2STokenBypass"


def _extract_register_all_call_order() -> list[str]:
    """Parse RegisterAll()'s body and return the ordered list of `Register*`
    static-call names. Stops at the closing brace of RegisterAll's outer try."""
    src = REGISTRAR_CS.read_text(encoding="utf-8")

    # Find "public static void RegisterAll()" then capture until the matching
    # closing brace of the OUTER method. Brace-counting is sufficient because
    # all comments inside use // (no /* */), so braces only live in real code.
    start = src.find("public static void RegisterAll()")
    assert start >= 0, "RegisterAll() method not found in EdogDevModeRegistrar.cs"

    body_start = src.find("{", start)
    assert body_start >= 0

    depth = 0
    body_end = -1
    for i in range(body_start, len(src)):
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                body_end = i
                break
    assert body_end > body_start, "Could not find end of RegisterAll() method"

    body = src[body_start : body_end + 1]

    # Strip // line comments so a commented-out `// RegisterFoo();` doesn't
    # leak into the order list.
    body_no_comments = re.sub(r"//[^\n]*", "", body)

    # Match `RegisterXxx(` at statement position, capture the name only.
    # The leading `\b` ensures we don't catch e.g. `EdogDevModeRegistrar.RegisterAll`.
    return re.findall(r"\b(Register[A-Z]\w*)\s*\(", body_no_comments)


def test_s2s_bypass_runs_before_all_s2s_consumer_wrappers():
    """RegisterS2STokenBypass() must precede every interceptor that
    transitively constructs an IS2STokenProvider consumer singleton.

    Failure mode if violated:
        Production: /getLatestDag, Spark calls etc. raise
        S2SAuthenticationException on storage.azure.com whenever the
        workload's own S2S certificate path is broken (PPE cert rotation,
        AAD authority outage, etc.) because the consumer's readonly field
        was captured BEFORE our wrapper was installed.
    """
    order = _extract_register_all_call_order()

    assert _BYPASS_REGISTRATION in order, (
        f"{_BYPASS_REGISTRATION} is no longer called from RegisterAll(). "
        "The S2S token bypass is required for FLT to survive workload "
        "certificate rotations against PPE AAD."
    )

    bypass_index = order.index(_BYPASS_REGISTRATION)

    violations = []
    for consumer in _S2S_CONSUMER_REGISTRATIONS:
        if consumer not in order:
            # Skip silently — consumer interceptor may have been removed in
            # a separate refactor. This test only enforces the ordering of
            # what is still called.
            continue
        consumer_index = order.index(consumer)
        if consumer_index < bypass_index:
            violations.append(
                f"  {consumer}() is at position {consumer_index} but "
                f"{_BYPASS_REGISTRATION}() is at position {bypass_index} — "
                f"S2S bypass must come first or the wrapper is invisible to "
                f"the consumer's readonly ctor-injected field."
            )

    assert not violations, (
        "RegisterAll() interceptor order violates S2S bypass invariant:\n"
        + "\n".join(violations)
        + "\n\nFix: hoist RegisterS2STokenBypass() above the listed consumers "
        "in src/backend/DevMode/EdogDevModeRegistrar.cs RegisterAll()."
    )


def test_register_all_has_explanatory_comment_for_s2s_ordering():
    """The ordering constraint is non-obvious and the comment block above
    RegisterS2STokenBypass() is what stops the next engineer from
    reshuffling the list 'for tidiness' and silently breaking prod.

    Don't delete the comment without first deleting this test. If you change
    the wording, update the trigger phrases below.
    """
    src = REGISTRAR_CS.read_text(encoding="utf-8")

    assert "ORDER MATTERS" in src, (
        "The 'ORDER MATTERS' explanatory comment block above "
        "RegisterS2STokenBypass() has been removed. Restore it — without "
        "it, the next refactor will silently regress the S2S DI ordering."
    )
    assert "IS2STokenProvider" in src, (
        "The S2S ordering comment must mention `IS2STokenProvider` so a "
        "developer grepping for the interface lands on the explanation."
    )
