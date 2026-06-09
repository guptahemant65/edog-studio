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

/* ── Popover component (DOM glue; decisions delegated to the helpers) ─────── */

function BranchSwitcher(opts) {
  opts = opts || {};
  this._triggerEl = opts.triggerEl || null; // the git branch chip
  this._phase = 'idle';
  this._popover = null;
  this._listEl = null;
  this._searchEl = null;
  this._emptyEl = null;
  this._confirmEl = null;
  // Data captured from the most recent /api/edog/git-branches fetch.
  this._branches = [];
  this._current = '';
  this._configured = false;
  this._valid = false;
  this._detached = false;
  this._userDirty = 0;
  this._unpushed = 0;
  this._stashes = 0;
  this._edogDirty = 0;
  this._busy = false;
  // onToast(message, variant, action?) and onRefresh() are injected by the
  // host so this module never reaches for a global that may not exist.
  this._onToast = typeof opts.onToast === 'function' ? opts.onToast : function () {};
  this._onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : function () {};
  this._docClick = this._onDocClick.bind(this);
  this._docKey = this._onDocKey.bind(this);
}

BranchSwitcher.prototype.setPhase = function (phase) {
  this._phase = phase || '';
  var allowed = canSwitch(this._phase);
  if (this._triggerEl) {
    this._triggerEl.classList.toggle('is-locked', !allowed);
    this._triggerEl.setAttribute(
      'title',
      allowed ? 'Switch branch' : 'Stop the running environment to change branch.'
    );
  }
  if (!allowed && this.isOpen()) this.close();
};

BranchSwitcher.prototype.isOpen = function () {
  return !!(this._popover && this._popover.classList.contains('open'));
};

BranchSwitcher.prototype.toggle = function () {
  if (this.isOpen()) this.close();
  else this.open();
};

BranchSwitcher.prototype.open = function () {
  if (!canSwitch(this._phase)) return;
  this._ensurePopover();
  this._showList();
  this._popover.classList.add('open');
  this._position();
  document.addEventListener('mousedown', this._docClick, true);
  document.addEventListener('keydown', this._docKey, true);
  if (this._searchEl) {
    this._searchEl.value = '';
    this._searchEl.focus();
  }
  this._renderLoading();
  this._fetch();
};

BranchSwitcher.prototype.close = function () {
  if (!this._popover) return;
  this._popover.classList.remove('open');
  document.removeEventListener('mousedown', this._docClick, true);
  document.removeEventListener('keydown', this._docKey, true);
};

BranchSwitcher.prototype._onDocClick = function (e) {
  if (!this.isOpen()) return;
  if (this._popover.contains(e.target)) return;
  if (this._triggerEl && this._triggerEl.contains(e.target)) return;
  this.close();
};

BranchSwitcher.prototype._onDocKey = function (e) {
  if (e.key === 'Escape') { e.preventDefault(); this.close(); }
};

BranchSwitcher.prototype._ensurePopover = function () {
  if (this._popover) return;
  var self = this;
  var pop = document.createElement('div');
  pop.id = 'branch-switcher-popover';
  pop.className = 'bs-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Switch git branch');

  var header = document.createElement('div');
  header.className = 'bs-header';
  var search = document.createElement('div');
  search.className = 'bs-search';
  search.innerHTML =
    '<svg class="bs-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/>' +
    '<path d="M10.5 10.5l3 3"/></svg>';
  var input = document.createElement('input');
  input.type = 'search';
  input.className = 'bs-search-input';
  input.placeholder = 'Switch branch\u2026';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.addEventListener('input', function () { self._renderList(); });
  search.appendChild(input);
  header.appendChild(search);
  pop.appendChild(header);

  var list = document.createElement('ul');
  list.className = 'bs-list';
  pop.appendChild(list);

  var empty = document.createElement('div');
  empty.className = 'bs-empty';
  empty.hidden = true;
  pop.appendChild(empty);

  var confirm = document.createElement('div');
  confirm.className = 'bs-confirm';
  confirm.hidden = true;
  pop.appendChild(confirm);

  document.body.appendChild(pop);
  this._popover = pop;
  this._searchEl = input;
  this._listEl = list;
  this._emptyEl = empty;
  this._confirmEl = confirm;
};

BranchSwitcher.prototype._position = function () {
  if (!this._popover || !this._triggerEl) return;
  var r = this._triggerEl.getBoundingClientRect();
  var pop = this._popover;
  pop.style.position = 'fixed';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  var width = pop.offsetWidth || 320;
  var left = r.left;
  var maxLeft = window.innerWidth - width - 8;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  pop.style.left = Math.round(left) + 'px';
};

BranchSwitcher.prototype._showList = function () {
  if (this._confirmEl) { this._confirmEl.hidden = true; this._confirmEl.innerHTML = ''; }
  if (this._listEl) this._listEl.hidden = false;
  if (this._popover) {
    var h = this._popover.querySelector('.bs-header');
    if (h) h.hidden = false;
  }
};

BranchSwitcher.prototype._renderLoading = function () {
  if (this._emptyEl) { this._emptyEl.hidden = true; }
  if (this._listEl) {
    this._listEl.hidden = false;
    this._listEl.innerHTML = '<li class="bs-loading">Loading branches\u2026</li>';
  }
};

BranchSwitcher.prototype._showEmpty = function (message) {
  if (this._listEl) this._listEl.hidden = true;
  if (this._emptyEl) {
    this._emptyEl.hidden = false;
    this._emptyEl.textContent = '';
    var icon = document.createElement('span');
    icon.className = 'bs-empty-mark';
    icon.textContent = '\u25C7'; // hollow diamond
    var msg = document.createElement('span');
    msg.className = 'bs-empty-msg';
    msg.textContent = message;
    this._emptyEl.appendChild(icon);
    this._emptyEl.appendChild(msg);
  }
};

BranchSwitcher.prototype._fetch = function () {
  var self = this;
  fetch('/api/edog/git-branches?remote=0')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      data = data || {};
      self._branches = data.local || [];
      self._current = data.current || '';
      self._configured = !!data.configured;
      self._valid = !!data.valid;
      self._detached = !!data.detached;
      self._userDirty = data.userDirty || 0;
      self._unpushed = data.unpushed || 0;
      self._stashes = data.stashes || 0;
      self._edogDirty = data.edogDirty || 0;
      if (!self._configured) {
        self._showEmpty('No FLT repo configured yet. Set one in the Environment tab to switch branches.');
        return;
      }
      if (!self._valid) {
        self._showEmpty('The configured FLT path is not a git repository.');
        return;
      }
      if (!self._branches.length) {
        self._showEmpty('No local branches found in this repository.');
        return;
      }
      self._renderList();
    })
    .catch(function () {
      self._showEmpty('Could not load branches \u2014 the dev-server may be unavailable.');
    });
};

BranchSwitcher.prototype._renderList = function () {
  if (!this._listEl) return;
  if (this._emptyEl) this._emptyEl.hidden = true;
  this._listEl.hidden = false;
  var query = this._searchEl ? this._searchEl.value : '';
  var rows = filterBranches(this._branches, query);
  var self = this;
  this._listEl.innerHTML = '';
  if (!rows.length) {
    var none = document.createElement('li');
    none.className = 'bs-loading';
    none.textContent = 'No branches match \u201C' + query + '\u201D';
    this._listEl.appendChild(none);
    return;
  }
  rows.forEach(function (b) {
    self._listEl.appendChild(self._buildRow(b));
  });
};

BranchSwitcher.prototype._buildRow = function (b) {
  var self = this;
  var li = document.createElement('li');
  li.className = 'bs-row';
  if (b.name === this._current) li.classList.add('is-current');
  li.setAttribute('role', 'button');
  li.setAttribute('tabindex', '0');

  var nameWrap = document.createElement('span');
  nameWrap.className = 'bs-name-wrap';
  var dot = document.createElement('span');
  dot.className = 'bs-row-dot';
  nameWrap.appendChild(dot);
  var name = document.createElement('span');
  name.className = 'bs-name';
  name.textContent = b.name;
  nameWrap.appendChild(name);
  if (b.touchesEdogSurface) {
    var warn = document.createElement('span');
    warn.className = 'bs-warn';
    warn.textContent = '\u26A0'; // warning sign
    warn.title = 'Differs in EDOG-patched files';
    nameWrap.appendChild(warn);
  }
  if (b.name === this._current) {
    var cur = document.createElement('span');
    cur.className = 'bs-current-tag';
    cur.textContent = 'current';
    nameWrap.appendChild(cur);
  }
  li.appendChild(nameWrap);

  var sub = document.createElement('span');
  sub.className = 'bs-sub';
  sub.textContent = formatBranchSubtitle(b);
  li.appendChild(sub);

  if (b.name !== this._current) {
    li.addEventListener('click', function () { self.select(b.name); });
    li.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.select(b.name); }
    });
  }
  return li;
};

BranchSwitcher.prototype.select = function (branch) {
  if (this._busy) return;
  if (branch === this._current) return;
  var target = this._branches.filter(function (b) { return b.name === branch; })[0] || { name: branch };
  var plan = buildSwitchPlan(this._current, this._userDirty, target, {
    unpushed: this._unpushed,
    stashes: this._stashes,
    edogDirty: this._edogDirty,
  });
  if (plan.needsPrompt || plan.hazards.length) {
    this._renderConfirm(plan, branch);
  } else {
    this._doCheckout(branch, 'carry');
  }
};

BranchSwitcher.prototype._renderConfirm = function (plan, branch) {
  var self = this;
  var header = this._popover.querySelector('.bs-header');
  if (header) header.hidden = true;
  if (this._listEl) this._listEl.hidden = true;
  if (this._emptyEl) this._emptyEl.hidden = true;
  var box = this._confirmEl;
  box.hidden = false;
  box.innerHTML = '';

  var title = document.createElement('div');
  title.className = 'bs-confirm-title';
  title.textContent = 'Switch to ' + branch;
  box.appendChild(title);

  var msg = document.createElement('div');
  msg.className = 'bs-confirm-msg';
  msg.textContent = plan.message;
  box.appendChild(msg);

  if (plan.hazards.length) {
    var haz = document.createElement('ul');
    haz.className = 'bs-hazards';
    plan.hazards.forEach(function (h) {
      var li = document.createElement('li');
      li.className = 'bs-hazard';
      var mark = document.createElement('span');
      mark.className = 'bs-hazard-mark';
      mark.textContent = '\u26A0';
      var txt = document.createElement('span');
      txt.textContent = h;
      li.appendChild(mark);
      li.appendChild(txt);
      haz.appendChild(li);
    });
    box.appendChild(haz);
  }

  var actions = document.createElement('div');
  actions.className = 'bs-confirm-actions';

  if (plan.needsPrompt) {
    // Uncommitted non-EDOG files present — offer the three resolutions.
    var choices = [
      { key: 'stash', label: 'Stash', hint: 'set aside, restorable' },
      { key: 'carry', label: 'Carry', hint: 'bring changes along' },
      { key: 'discard', label: 'Discard', hint: 'throw away', danger: true },
    ];
    choices.forEach(function (c) {
      var btn = document.createElement('button');
      btn.className = 'bs-btn' + (c.danger ? ' bs-btn-danger' : ' bs-btn-primary');
      btn.title = c.hint;
      btn.textContent = c.label;
      btn.addEventListener('click', function () { self._doCheckout(branch, c.key); });
      actions.appendChild(btn);
    });
  } else {
    var go = document.createElement('button');
    go.className = 'bs-btn bs-btn-primary';
    go.textContent = 'Switch';
    go.addEventListener('click', function () { self._doCheckout(branch, 'carry'); });
    actions.appendChild(go);
  }

  var cancel = document.createElement('button');
  cancel.className = 'bs-btn bs-btn-ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', function () { self._showList(); self._renderList(); });
  actions.appendChild(cancel);

  box.appendChild(actions);
  this._position();
};

BranchSwitcher.prototype._doCheckout = function (branch, onDirty) {
  if (this._busy) return;
  this._busy = true;
  var self = this;
  fetch('/api/edog/git-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: branch, onDirty: onDirty }),
  })
    .then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j || {} }; });
    })
    .then(function (res) {
      self._busy = false;
      var j = res.j;
      if (j.ok) {
        self.close();
        if (j.stashed) {
          self._onToast('Switched to ' + branch, 'success', {
            label: 'Restore',
            onClick: function () { self.restoreStash(j.stashed); },
          });
        } else {
          self._onToast('Switched to ' + branch, 'success', null);
        }
        self._onRefresh();
      } else if (res.status === 409 && j.error === 'phase_locked') {
        self._onToast('Cannot switch while ' + (j.phase || 'running') + '.', 'warning', null);
        self.close();
      } else if (res.status === 409 && j.error === 'checkout_conflict') {
        self._onToast('Switch blocked: ' + (j.message || 'checkout conflict'), 'error', null);
      } else {
        self._onToast('Switch failed: ' + (j.message || j.error || 'unknown error'), 'error', null);
      }
    })
    .catch(function () {
      self._busy = false;
      self._onToast('Switch failed \u2014 the dev-server may be unavailable.', 'error', null);
    });
};

BranchSwitcher.prototype.restoreStash = function (ref) {
  var self = this;
  fetch('/api/edog/git-stash-apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: ref }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      j = j || {};
      if (j.ok) {
        self._onToast('Stashed changes restored.', 'success', null);
        self._onRefresh();
      } else {
        self._onToast('Restore failed: ' + (j.message || j.error || 'unknown error'), 'error', null);
      }
    })
    .catch(function () {
      self._onToast('Restore failed \u2014 the dev-server may be unavailable.', 'error', null);
    });
};

if (typeof window !== 'undefined') {
  window.BranchSwitcherUtils = {
    filterBranches: filterBranches,
    formatBranchSubtitle: formatBranchSubtitle,
    canSwitch: canSwitch,
    buildSwitchPlan: buildSwitchPlan,
  };
  window.BranchSwitcher = BranchSwitcher;
}
