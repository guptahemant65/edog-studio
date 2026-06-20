"""Derive the scenario plan (m categories x n cases) FROM the change — not by taste.

The earlier protocol left the enumeration to judgement ("applicable categories are
chosen from the blast radius"), which let a hand-picked count slip in. This module
makes the derivation mechanical: each change-feature maps to a risk-dimension
(category) and to the input classes (cases) that the change makes meaningful. The
count is therefore a *function of the diff* — a one-line PR yields a couple of
cases, a sprawling one yields many — and is identical on every run.

The agent still does the grounding (the exact stimulus, the cited checks, the
honest caveats) per stub; this module only guarantees the skeleton is **complete**
— you cannot forget the regression guard, the cap+1, or the contract diff, because
each is emitted whenever its triggering feature is present.

Feature vocabulary (built from `qa_pr_diff` output + the Beat-2 code read):
  param_enum_added   endpoint, param, added:[..], cap?, is_list?, also_on:[..]
  default_changed    endpoint, param, to, alts:[..]
  dto_breaking       type, detail, cap?
  flag               name
  mlv_write          table
  auth_posture       detail
  no_surface         symbol      (a changed symbol with no runtime-observable surface)

Each case carries an ``input_class`` so coverage can be audited (a plan missing the
``negative`` or ``boundary-over`` class for a guard change is provably incomplete).
"""

from __future__ import annotations

# Category priority: cheapest + highest-value first (contract needs no deploy),
# then behaviour, then guards/limits, then matrix/data, then detect-only/coverage.
_ORDER = [
    "API contract",
    "Newly accepted input",
    "Input still rejected",
    "Limits",
    "Default behaviour",
    "Feature flag",
    "Data correctness",
    "Security \u2014 needs a human",
    "Did the changed code run",
]


def _case(title: str, input_class: str, **extra: object) -> dict:
    return {"title": title, "input_class": input_class, **extra}


def derive(features: list[dict]) -> list[dict]:
    """Map change-features to an ordered list of ``{name, suffix?, cases:[…]}``.

    m = the categories that got >=1 case; n = the total cases. Both emerge from
    ``features``; no fixed template, no minimum, no maximum.
    """
    buckets: dict[str, dict] = {}

    def add(category: str, case: dict, *, suffix: str | None = None) -> None:
        b = buckets.setdefault(category, {"name": category, "cases": []})
        if suffix and not b.get("suffix"):
            b["suffix"] = suffix
        b["cases"].append(case)

    for f in features:
        kind = f["feature"]

        if kind == "param_enum_added":
            ep = f["endpoint"]
            also = f.get("also_on") or []
            cover = f"same binding also covers: {', '.join(also)}" if also else None
            for v in f.get("added", []):
                add("Newly accepted input",
                    _case(f'"{v}" is now accepted (was rejected)', "newly-allowed", endpoint=ep, note=cover))
            add("Newly accepted input",
                _case("the new value actually filters (it isn't silently ignored)", "differential", endpoint=ep))
            if f.get("is_list"):
                add("Newly accepted input",
                    _case("a mixed valid set binds correctly", "multi-value", endpoint=ep))
            # Loosening an allow-set is the real risk: prove it didn't over-loosen.
            add("Input still rejected",
                _case("a still-disallowed value is rejected (didn't over-loosen)", "negative", endpoint=ep))
            add("Input still rejected",
                _case("the rejection message lists the new allowed set", "message", endpoint=ep))
            cap = f.get("cap")
            if cap:
                add("Limits",
                    _case(f"more than {cap} values is rejected", "boundary-over", endpoint=ep,
                          note="if the URL-length limit bites first, reported honestly"))

        elif kind == "default_changed":
            alts = ", ".join(f.get("alts", []))
            title = f"no {f['param']} asked == {f['to']} (was: all)"
            if alts:
                title += f"; differs from {alts}"
            add("Default behaviour", _case(title, "default", endpoint=f["endpoint"]))

        elif kind == "dto_breaking":
            add("API contract",
                _case("compare the API before vs after \u2014 catch the breaking change", "contract",
                      note=f.get("detail")),
                suffix="the breaking change \u00b7 no deploy needed")
            if f.get("cap"):
                add("API contract",
                    _case(f"the field is a list, capped at {f['cap']}", "runtime-shape",
                          note="shape proven by the contract diff; runtime cap is best-effort"))

        elif kind == "flag":
            add("Feature flag", _case(f"{f['name']}: ON vs OFF", "flag-matrix"))

        elif kind == "mlv_write":
            add("Data correctness",
                _case(f"stored {f['table']} equals a fresh recompute", "data"))

        elif kind == "auth_posture":
            add("Security \u2014 needs a human",
                _case("auth posture changed \u2014 flagged for review, never tested here", "security",
                      detect_only=True, note=f.get("detail")))

        elif kind == "no_surface":
            add("Did the changed code run",
                _case(f"{f['symbol']} has no runtime surface \u2014 report not-provably-exercised",
                      "execution-proof"))

        else:  # unknown feature kind: surface it, never silently drop coverage
            add("Did the changed code run",
                _case(f"unmapped change feature {kind!r} \u2014 investigate by hand", "unmapped"))

    return [buckets[name] for name in _ORDER if name in buckets]


def case_count(plan: list[dict]) -> int:
    """Total cases (n) across all categories."""
    return sum(len(c["cases"]) for c in plan)
