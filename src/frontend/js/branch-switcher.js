/* FLT Branch Switcher — top-bar branch popover.
 *
 * Pure helpers are module-level functions (testable via node:vm); the popover
 * component is attached to window.BranchSwitcher. No framework, vanilla JS to
 * match the rest of the front-end (ADR-002). The pure logic carries every
 * decision so the DOM glue stays thin and the helpers stay unit-tested.
 *
 * @author Pixel — EDOG Studio hivemind
 */

/* ── Pure helpers (unit-tested in tests/js/test-branch-switcher.mjs) ──────── */

function filterBranches(branches, query) {
  var q = (query || '').trim().toLowerCase();
  if (!q) return (branches || []).slice();
  return (branches || []).filter(function (b) {
    return (b.name || '').toLowerCase().indexOf(q) !== -1;
  });
}

function formatBranchSubtitle(row) {
  row = row || {};
  var bits = [];
  var ahead = row.ahead || 0;
  var behind = row.behind || 0;
  if (ahead) bits.push(ahead + '\u2191'); // up arrow
  if (behind) bits.push(behind + '\u2193'); // down arrow
  if (row.relativeDate) bits.push(row.relativeDate);
  if (row.author) bits.push(row.author);
  return bits.join(' \u00b7 '); // middot
}

// Pre-deploy phases are the only ones where a checkout is safe. Mirrors the
// backend phase guard (LOCKED_PHASES) so the chip locks the moment FLT runs.
var ALLOWED_PHASES = { idle: 1, stopped: 1, crashed: 1 };

function canSwitch(phase) {
  return !!ALLOWED_PHASES[phase];
}

/* Decide whether switching needs the stash/carry/discard prompt and collect
 * the "don't-lose-work" hazards (spec §6 #2) — informational, never blocking.
 *   leftBranch  — branch we're leaving (for unpushed messaging)
 *   userDirty   — count of uncommitted NON-EDOG files (drives the prompt)
 *   target      — the branch row being switched to (EDOG-surface predictive)
 *   safety      — { unpushed, stashes, edogDirty } from the same branch list
 */
function buildSwitchPlan(leftBranch, userDirty, target, safety) {
  safety = safety || {};
  var hazards = [];

  if (target && target.touchesEdogSurface) {
    var files = (target.edogSurfaceFiles || []).join(', ');
    hazards.push(
      'Target branch differs in EDOG-patched files' +
        (files ? ' (' + files + ')' : '') +
        ' \u2014 next deploy may need attention.'
    );
  }

  var unpushed = safety.unpushed || 0;
  if (unpushed > 0) {
    hazards.push(
      unpushed + ' unpushed commit' + (unpushed === 1 ? '' : 's') +
        ' on ' + (leftBranch || 'this branch') +
        ' \u2014 they stay on that branch, not lost.'
    );
  }

  var stashes = safety.stashes || 0;
  if (stashes > 0) {
    hazards.push(
      stashes + ' existing stash' + (stashes === 1 ? '' : 'es') +
        ' in this repo \u2014 still available after switching.'
    );
  }

  if ((safety.edogDirty || 0) > 0) {
    hazards.push(
      "EDOG patch files dirty from a prior session \u2014 they'll be carried."
    );
  }

  var needsPrompt = (userDirty || 0) > 0;
  var message = needsPrompt
    ? 'You have ' + userDirty + ' uncommitted change' + (userDirty === 1 ? '' : 's') +
      '. Stash, carry, or discard before switching?'
    : 'Switch to ' + (target ? target.name : '') + '?';

  return {
    needsPrompt: needsPrompt,
    message: message,
    hazards: hazards,
    leftBranch: leftBranch,
  };
}

if (typeof window !== 'undefined') {
  window.BranchSwitcherUtils = {
    filterBranches: filterBranches,
    formatBranchSubtitle: formatBranchSubtitle,
    canSwitch: canSwitch,
    buildSwitchPlan: buildSwitchPlan,
  };
}
