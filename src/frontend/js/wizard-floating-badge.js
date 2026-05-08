/**
 * FloatingBadge — Fixed-position pill badge for minimized wizard execution.
 *
 * Appears bottom-right when wizard is minimized during pipeline execution (Page 5).
 * Shows step progress, handles success/failure states, auto-dismisses on success.
 * Clicking restores the full wizard dialog via onRestore callback.
 *
 * CSS prefix: .iw-
 * @author Pixel — EDOG Studio hivemind
 */

/* ═══════════════════════════════════════════════════════════════════
   FLOATING BADGE
   ═══════════════════════════════════════════════════════════════════ */

var BADGE_AUTO_DISMISS_MS = 8000;
var BADGE_ENTRANCE_MS = 400;
var BADGE_EXIT_MS = 300;
var BADGE_SPRING_EASING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

class FloatingBadge {

  /**
   * @param {object} options
   * @param {Function} [options.onRestore] — called when user clicks badge to restore wizard
   */
  constructor(options) {
    var opts = options || {};
    this._onRestore = opts.onRestore || null;
    this._el = null;
    this._state = 'hidden';
    this._stepIndex = 0;
    this._totalSteps = 6;
    this._stepName = '';
    this._elapsedMs = 0;
    this._timerInterval = null;
    this._dismissTimeout = null;
    this._hovered = false;

    // Singleton: destroy any existing badge
    var existing = document.querySelector('.iw-badge');
    if (existing && existing._floatingBadgeRef) {
      existing._floatingBadgeRef.destroy();
    } else if (existing) {
      existing.remove();
    }

    this._createElement();
  }

  /* ─── Public API ─────────────────────────────────────────────── */

  /** Show badge with running state. */
  show(stepIndex, stepName) {
    this._stepIndex = stepIndex;
    this._stepName = stepName || '';
    this._elapsedMs = 0;
    this._state = 'running';
    this._render();
    document.body.appendChild(this._el);
    this._animateEntrance();
    this._startTimer();
  }

  /** Update progress during execution. */
  updateStep(stepIndex, stepName) {
    this._stepIndex = stepIndex;
    this._stepName = stepName || '';
    this._render();
  }

  /** Brief completing state before success. */
  showCompleting() {
    this._state = 'completing';
    this._stopTimer();
    this._render();
  }

  /** Pipeline succeeded — auto-dismiss after 8s unless hovered. */
  showSuccess() {
    this._state = 'success';
    this._stopTimer();
    this._render();
    this._startAutoDismiss();
  }

  /** Pipeline failed — stays visible until clicked. */
  showFailure(errorMsg) {
    this._state = 'failure';
    this._stepName = errorMsg || this._stepName;
    this._stopTimer();
    this._render();
  }

  /** Remove badge with exit animation. */
  hide() {
    if (!this._el || !this._el.parentNode) return;
    this._clearAutoDismiss();
    this._animateExit();
  }

  /** Full teardown. */
  destroy() {
    this._stopTimer();
    this._clearAutoDismiss();
    if (this._el) {
      this._el.removeEventListener('click', this._boundClick);
      this._el.removeEventListener('keydown', this._boundKeydown);
      this._el.removeEventListener('mouseenter', this._boundMouseEnter);
      this._el.removeEventListener('mouseleave', this._boundMouseLeave);
      if (this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._el._floatingBadgeRef = null;
      this._el = null;
    }
    this._state = 'hidden';
  }

  /* ─── Internal ───────────────────────────────────────────────── */

  _createElement() {
    var el = document.createElement('div');
    el.className = 'iw-badge iw-badge--hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('tabindex', '0');
    el._floatingBadgeRef = this;

    // Dot
    var dot = document.createElement('span');
    dot.className = 'iw-badge-dot';

    // Text
    var text = document.createElement('span');
    text.className = 'iw-badge-text';

    // Progress bar container
    var progress = document.createElement('span');
    progress.className = 'iw-badge-progress';
    var fill = document.createElement('span');
    fill.className = 'iw-badge-progress-fill';
    progress.appendChild(fill);

    el.appendChild(dot);
    el.appendChild(text);
    el.appendChild(progress);

    // Bind event handlers
    this._boundClick = this._handleClick.bind(this);
    this._boundKeydown = this._handleKeydown.bind(this);
    this._boundMouseEnter = this._handleMouseEnter.bind(this);
    this._boundMouseLeave = this._handleMouseLeave.bind(this);
    el.addEventListener('click', this._boundClick);
    el.addEventListener('keydown', this._boundKeydown);
    el.addEventListener('mouseenter', this._boundMouseEnter);
    el.addEventListener('mouseleave', this._boundMouseLeave);

    this._el = el;
  }

  _render() {
    if (!this._el) return;

    var el = this._el;
    el.className = 'iw-badge iw-badge--' + this._state;

    var textEl = el.querySelector('.iw-badge-text');
    var fillEl = el.querySelector('.iw-badge-progress-fill');
    var progressEl = el.querySelector('.iw-badge-progress');

    var displayText = '';
    var ariaLabel = '';
    var percent = 0;
    var showProgress = false;

    if (this._state === 'running') {
      var stepNum = this._stepIndex + 1;
      displayText = 'Step ' + stepNum + '/' + this._totalSteps + ' \u2014 ' + this._stepName;
      ariaLabel = 'Wizard execution progress: Step ' + stepNum + ' of ' + this._totalSteps +
        ', currently ' + this._stepName + '. Click to restore wizard.';
      percent = (stepNum / this._totalSteps) * 100;
      showProgress = true;
    } else if (this._state === 'completing') {
      displayText = 'Completing\u2026';
      ariaLabel = 'Wizard execution completing. Click to restore wizard.';
      percent = 100;
      showProgress = true;
    } else if (this._state === 'success') {
      displayText = 'Environment created \u25CF';
      ariaLabel = 'Wizard execution succeeded. Environment created. Click to restore wizard.';
    } else if (this._state === 'failure') {
      var failStep = this._stepIndex + 1;
      displayText = 'Step ' + failStep + '/' + this._totalSteps + ' failed \u2014 ' + this._stepName + ' \u2715';
      ariaLabel = 'Wizard execution failed at step ' + failStep + ' of ' + this._totalSteps +
        ', ' + this._stepName + '. Click to restore wizard.';
    }

    textEl.textContent = displayText;
    el.setAttribute('aria-label', ariaLabel);
    fillEl.style.width = percent + '%';
    progressEl.style.display = showProgress ? '' : 'none';
  }

  _startTimer() {
    this._stopTimer();
    var self = this;
    this._timerInterval = setInterval(function() {
      self._elapsedMs += 1000;
    }, 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  _formatElapsed(ms) {
    var totalSec = Math.floor(ms / 1000);
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;
    return min + ':' + (sec < 10 ? '0' : '') + sec;
  }

  _handleClick() {
    if (this._onRestore) this._onRestore();
  }

  _handleKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this._handleClick();
    }
  }

  _handleMouseEnter() {
    this._hovered = true;
    if (this._state === 'success' && this._dismissTimeout) {
      clearTimeout(this._dismissTimeout);
      this._dismissTimeout = null;
    }
  }

  _handleMouseLeave() {
    this._hovered = false;
    if (this._state === 'success' && !this._dismissTimeout) {
      this._startAutoDismiss();
    }
  }

  _startAutoDismiss() {
    this._clearAutoDismiss();
    if (this._hovered) return;
    var self = this;
    this._dismissTimeout = setTimeout(function() {
      self.hide();
    }, BADGE_AUTO_DISMISS_MS);
  }

  _clearAutoDismiss() {
    if (this._dismissTimeout) {
      clearTimeout(this._dismissTimeout);
      this._dismissTimeout = null;
    }
  }

  _animateEntrance() {
    var el = this._el;
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px) scale(0.9)';
    // Force reflow before animating
    void el.offsetWidth;
    el.style.transition = 'opacity ' + BADGE_ENTRANCE_MS + 'ms ' + BADGE_SPRING_EASING +
      ', transform ' + BADGE_ENTRANCE_MS + 'ms ' + BADGE_SPRING_EASING;
    el.style.opacity = '1';
    el.style.transform = 'translateY(0) scale(1)';
  }

  _animateExit() {
    var el = this._el;
    if (!el) return;
    el.style.transition = 'opacity ' + BADGE_EXIT_MS + 'ms ease, transform ' + BADGE_EXIT_MS + 'ms ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px) scale(0.9)';
    var self = this;
    setTimeout(function() {
      self.destroy();
    }, BADGE_EXIT_MS);
  }
}

window.FloatingBadge = FloatingBadge;
