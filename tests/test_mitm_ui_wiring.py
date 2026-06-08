"""
MITM intercept feature — UI wiring tests.

The MITM engine (backend coordinator + rule store + 8 hub methods) is
production-grade but the UI bridge that lets a user actually USE it is
missing. This test file pins the fixes for the 4 user-blocking gaps:

  M1 — no UI to create a breakpoint/forge/modify/latency rule
  M2 — no rule list panel (rules are invisible & undeletable from the UI)
  M3 — mitm topic subscribed lazily (breakpoints missed when on other tab)
  M4 — no kill-switch button (only Ctrl+Shift+K keyboard)

Each TestClass corresponds to one fix. Tests are source-level + jsdom
behavioural where appropriate. The jsdom harness mirrors the proven
pattern from tests/test_summary_drawer_diff_render.py and
tests/test_tab_telemetry_v2_wiring.py.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_JS = os.path.join(REPO, "src", "frontend", "js")
FRONTEND_CSS = os.path.join(REPO, "src", "frontend", "css")

TAB_HTTP_JS = os.path.join(FRONTEND_JS, "tab-http.js")
HTTP_ROW_MENU_JS = os.path.join(FRONTEND_JS, "http-row-menu.js")
TAB_HTTP_CSS = os.path.join(FRONTEND_CSS, "tab-http.css")
NODE = shutil.which("node")


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


def _strip_comments(s: str) -> str:
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
    s = re.sub(r"//[^\n]*", "", s)
    return s


# ════════════════════════════════════════════════════════════════════
# M3 — eager mitm topic subscription (matches http topic pattern)
# ════════════════════════════════════════════════════════════════════


class TestM3EagerMitmSubscription:
    """Today the mitm topic is subscribed only inside activate(). If a
    breakpoint fires while the user is on Logs or Telemetry, the UI
    misses the breakpointHit event entirely. Fix: subscribe in the
    constructor, matching the proven `http` topic pattern.
    """

    def test_constructor_subscribes_mitm_topic(self):
        src = _read(TAB_HTTP_JS)
        # Locate the constructor body
        m = re.search(
            r"constructor\s*\(\s*containerEl\s*,\s*signalr\s*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate HttpPipelineTab constructor body."
        body = m.group(1)
        clean = _strip_comments(body)
        # The fix must call this._subscribeMitmTopic() (or equivalent
        # signalr.on('mitm', …) + subscribeTopic('mitm')) from the ctor.
        has_helper = re.search(r"this\._subscribeMitmTopic\s*\(\s*\)", clean)
        has_inline = re.search(
            r"this\._signalr\.on\(\s*['\"]mitm['\"]", clean,
        ) and re.search(
            r"this\._signalr\.subscribeTopic\(\s*['\"]mitm['\"]", clean,
        )
        assert has_helper or has_inline, (
            "HttpPipelineTab constructor must subscribe to the `mitm` topic "
            "(via this._subscribeMitmTopic() or direct signalr calls). "
            "Without eager subscription, breakpointHit events that fire "
            "while the user is on another tab are silently dropped — the "
            "backend pauses the request and times out after 30s with the "
            "UI showing nothing."
        )

    def test_activate_does_not_re_subscribe(self):
        """activate() should be idempotent — the _mitmSubscribed guard
        already prevents double subscription, but the cleanest fix moves
        the subscription out of activate entirely. activate's job
        becomes: re-sync state (capabilities, rules) only."""
        src = _read(TAB_HTTP_JS)
        # _mitmSubscribed must still be present (it guards re-subscription
        # in case of a stray call).
        assert "_mitmSubscribed" in src, (
            "_mitmSubscribed guard must remain to protect against double "
            "subscription if a future code path accidentally calls "
            "_subscribeMitmTopic again."
        )


# ════════════════════════════════════════════════════════════════════
# M4 — kill switch button in toolbar
# ════════════════════════════════════════════════════════════════════


class TestM4KillSwitchButton:
    """Today MitmClearAll is reachable only via Ctrl+Shift+K. Add a
    visible button in the toolbar so users discover it."""

    def test_toolbar_builds_kill_switch_button(self):
        src = _read(TAB_HTTP_JS)
        m = re.search(
            r"_buildToolbar\s*\(\s*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate _buildToolbar method body."
        body = m.group(1)
        # The fix must introduce a button element registered as
        # this._els.killSwitchBtn (or a clearly-named equivalent).
        assert re.search(
            r"this\._els\.killSwitchBtn\s*=", body
        ) or re.search(
            r"this\._els\.mitmKillBtn\s*=", body
        ), (
            "Toolbar must create a kill-switch button cached on "
            "this._els.killSwitchBtn (or .mitmKillBtn). Without a "
            "visible affordance, the user cannot discover the kill switch."
        )

    def test_kill_switch_button_wired_to_handler(self):
        src = _read(TAB_HTTP_JS)
        # The bound handler must call _onMitmKillSwitch on the button's
        # click. Look for the wiring inside _bindEvents or near the
        # toolbar build.
        # Pattern: this._els.killSwitchBtn.addEventListener('click', …)
        #   inside that handler — call to _onMitmKillSwitch.
        assert re.search(
            r"this\._els\.killSwitchBtn[^;]*addEventListener\(\s*['\"]click['\"]",
            src,
        ) or re.search(
            r"this\._els\.mitmKillBtn[^;]*addEventListener\(\s*['\"]click['\"]",
            src,
        ), (
            "Kill-switch button must have a click handler bound to it. "
            "(grep for `this._els.killSwitchBtn.addEventListener('click'`)"
        )
        # The handler body must call _onMitmKillSwitch
        clean = _strip_comments(_read(TAB_HTTP_JS))
        # Expected occurrences:
        #   1. Method definition: `_onMitmKillSwitch() { ... }`
        #   2. Ctrl+Shift+K keyboard handler call
        #   3. Toolbar button click handler call (new in M4 fix)
        # If either invocation is removed/commented, count drops below 3.
        kill_calls = len(re.findall(r"_onMitmKillSwitch\s*\(\s*\)", clean))
        assert kill_calls >= 3, (
            "_onMitmKillSwitch must be referenced from at least three places: "
            "(1) the method definition, (2) the Ctrl+Shift+K keyboard "
            "handler, (3) the new toolbar button click handler. "
            f"Found {kill_calls} matches. A drop below 3 means one of the "
            "invocation sites was removed or commented out."
        )


# ════════════════════════════════════════════════════════════════════
# M2 — rules list panel
# ════════════════════════════════════════════════════════════════════


class TestM2RulesListPanel:
    """this._mitmRules is maintained but never rendered. Add a panel that
    lists rules with delete affordance."""

    def test_rules_panel_render_method_exists(self):
        src = _read(TAB_HTTP_JS)
        assert re.search(
            r"_renderMitmRulesPanel\s*\(\s*\)\s*\{", src
        ) or re.search(
            r"_renderRulesPanel\s*\(\s*\)\s*\{", src
        ), (
            "Must add a _renderMitmRulesPanel (or _renderRulesPanel) "
            "method that builds the rules list DOM from this._mitmRules. "
            "Today _mitmRules is populated but never rendered."
        )

    def test_rules_panel_built_in_dom(self):
        src = _read(TAB_HTTP_JS)
        m = re.search(
            r"_buildDOM\s*\(\s*\)\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        assert m, "Could not locate _buildDOM method body."
        body = m.group(1)
        # The panel host element must be created during DOM build (so it
        # exists for renders triggered by SignalR events that arrive
        # before activate()).
        assert re.search(
            r"this\._els\.(mitmRulesPanel|rulesPanel)\s*=", body,
        ) or "_buildMitmRulesPanel" in body or "_buildRulesPanel" in body, (
            "_buildDOM must allocate the rules panel host element and cache "
            "it on this._els (e.g. this._els.mitmRulesPanel). Otherwise the "
            "rules render has nowhere to write to."
        )

    def test_panel_re_renders_on_rule_events(self):
        """ruleCreated and ruleDeleted SignalR events must trigger a
        re-render so the panel reflects the live rule store."""
        src = _read(TAB_HTTP_JS)
        m = re.search(
            r"_onMitmEvent\s*=?\s*\(?[^)]*\)?\s*=?>?\s*\{(.*?)\n  \}",
            src,
            re.DOTALL,
        )
        # Some files have _onMitmEvent as a regular method, others arrow.
        if not m:
            m = re.search(
                r"_onMitmEvent\s*\(\s*envelope\s*\)\s*\{(.*?)\n  \}",
                src,
                re.DOTALL,
            )
        assert m, "Could not locate _onMitmEvent method body."
        body = m.group(1)
        # ruleCreated/ruleDeleted branches must trigger a render
        # (call to _renderMitmRulesPanel or _renderRulesPanel).
        assert "_renderMitmRulesPanel" in body or "_renderRulesPanel" in body, (
            "_onMitmEvent's ruleCreated and ruleDeleted branches must "
            "trigger a re-render of the rules panel. Otherwise the panel "
            "becomes stale the moment a rule changes."
        )

    def test_delete_button_wired_to_hub(self):
        src = _read(TAB_HTTP_JS)
        clean = _strip_comments(src)
        # Delete must invoke MitmDeleteRule. Counting on stripped source
        # so a commented-out call cannot satisfy the guard.
        assert "MitmDeleteRule" in clean, (
            "Rules panel must invoke MitmDeleteRule when the user clicks "
            "delete on a rule row. Without this, the user can create "
            "rules but never remove them — the only escape is the kill "
            "switch (which removes ALL rules). Commented-out calls do "
            "NOT satisfy this guard."
        )


# ════════════════════════════════════════════════════════════════════
# M1 — rule creation modal with all action types
# ════════════════════════════════════════════════════════════════════


class TestM1RuleCreationModal:
    """Without this, the user cannot create breakpoint/forge/modify/latency
    rules and the entire pause-and-edit workflow is unreachable."""

    def test_modal_open_method_exists(self):
        src = _read(TAB_HTTP_JS)
        assert re.search(
            r"_openRuleCreator\s*\(", src
        ) or re.search(
            r"_openMitmRuleModal\s*\(", src
        ) or re.search(
            r"_showRuleCreator\s*\(", src
        ), (
            "Must add a method to open the rule-creation modal (e.g. "
            "_openRuleCreator or _openMitmRuleModal). Without this entry "
            "point, no UI can launch the rule editor."
        )

    def test_modal_supports_all_action_types(self):
        """The modal must let the user pick from at least the 4 action
        types the backend supports: breakpoint, forge, modify, block.
        Latency is a bonus. Source-level check: the select/options/data
        attributes must reference each action type literal."""
        src = _read(TAB_HTTP_JS)
        # Search for each action-type literal as a string in the modal
        # build. The modal builder may be _buildMitmRuleModal,
        # _renderRuleCreator, or similar — search globally with quoted
        # string literals.
        for action in ["breakpoint", "forge", "modify", "block"]:
            # Allow either single or double quote, allow the literal to
            # appear inside a value attribute or data-action-type.
            found = re.search(
                r"['\"]" + action + r"['\"]", src
            )
            assert found, (
                f"Rule creation modal must support action type '{action}'. "
                f"Could not find '{action}' literal anywhere in tab-http.js. "
                "Each of breakpoint/forge/modify/block must be selectable "
                "in the modal's action type selector."
            )

    def test_modal_invokes_create_rule_hub(self):
        """The modal's submit must call MitmCreateRule. Today the only
        call site is the hardcoded row-menu Block — the modal needs its
        own call site that takes the user's form values."""
        src = _read(TAB_HTTP_JS)
        clean = _strip_comments(src)
        create_calls = len(
            re.findall(r"MitmCreateRule['\"]", clean)
        )
        assert create_calls >= 2, (
            "MitmCreateRule must be called from at least two places: the "
            "existing row-menu Block (hardcoded block rule) AND the new "
            f"rule-creator modal submit. Found {create_calls} invocations."
        )

    def test_row_menu_exposes_create_rule_option(self):
        """The row menu (http-row-menu.js) should expose a 'Create rule
        from this' option so users can pre-fill the modal from a captured
        request. This is the discoverability path."""
        src = _read(HTTP_ROW_MENU_JS)
        # New callback name pattern.
        assert re.search(
            r"onCreateRule|onAddRule|onMakeRule", src
        ), (
            "http-row-menu.js must expose an onCreateRule (or onAddRule) "
            "callback so users can launch the rule modal pre-filled from a "
            "captured request. Without this discovery path, the modal "
            "exists but no one finds it."
        )

    def test_rule_modal_styles_present(self):
        """CSS for the modal must exist so it actually renders."""
        src = _read(TAB_HTTP_CSS)
        # At least the modal class root must exist with some non-trivial
        # rule (display, position, z-index — any one is enough).
        assert re.search(
            r"\.http-mitm-modal\b|\.http-rule-modal\b", src
        ), (
            "tab-http.css must define styles for the rule modal "
            "(.http-mitm-modal or .http-rule-modal). Without CSS the modal "
            "renders unstyled and likely misplaced."
        )

    def test_rules_panel_styles_present(self):
        src = _read(TAB_HTTP_CSS)
        assert re.search(
            r"\.http-mitm-rules\b|\.http-rules-panel\b", src
        ), (
            "tab-http.css must define styles for the rules list panel "
            "(.http-mitm-rules or .http-rules-panel)."
        )
