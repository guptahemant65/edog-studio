/**
 * IterationCorrelator — resolves the full set of RootActivityIds that
 * belong to a single DAG iteration.
 *
 * # The problem
 *
 * An FLT DAG iteration spans many RAIDs:
 *   - the background MVRefresh scope's RAID (the long-running thread)
 *   - per-GTS-poll "overriding Monitored Scope" RAIDs (one per status poll)
 *   - per-incoming-request RAIDs (each /getDAGExecStatus, /cancelDAG, etc.)
 *   - per-hook RAIDs, per-OneLake-call RAIDs, ...
 *
 * Only ~4% of log lines literally contain the iteration ID in their message
 * body. The rest carry only their own scope's RAID in the prefix, with no
 * direct reference to the iteration. A naive substring filter on iterationId
 * gets only the explicit mentions — useless for tracing.
 *
 * # The solution
 *
 * Forward-scan the log buffer. For the active iteration:
 *
 *   Seed:   any log mentioning the iteration ID by name → capture its
 *           rootActivityId. Catches MVRefresh, hook fires, telemetry emits.
 *
 *   Chase:  any log saying "An overriding Monitored Scope is created with
 *           RootActivityId: X" where the EMITTER's rootActivityId is already
 *           in our set → add X. (NB: the link is via the EMITTER's RAID,
 *           NOT the ParentActivityId field inside the message — that's a
 *           per-call intermediate, not the parent scope.)
 *
 *   Routes: any log message containing /runDAG/{id}, /getDAGExecStatus/{id},
 *           or /cancelDAG/{id} → capture its rootActivityId. Catches the
 *           separate incoming-request RAIDs.
 *
 * The chase may need 2-3 passes to converge because of transitively-chained
 * scopes (bg-RAID → mid-RAID → leaf-RAID). We loop until the set stops
 * growing.
 *
 * # Performance
 *
 * Initial resolve: O(n × convergence-depth), depth ≤ ~3 in practice. At
 * n=10k that's ~30k regex tests, ~5-10ms.
 *
 * Incremental update: on each batch of new logs, scan only the new range
 * for seeds + chase; re-converge if new RAIDs were added. Amortized O(k)
 * per new log where k is small.
 *
 * # Contract
 *
 *   setActiveIteration(id | null)  — start/clear correlation
 *   matches(rootActivityId)        — O(1) check
 *   onNewLogs()                    — call after addLog to refresh
 *   resolvedRaids                  — read-only Set for debugging
 *
 * @author Pixel — EDOG Studio hivemind
 */

class IterationCorrelator {
  constructor(state) {
    this.state = state;
    this.activeIteration = null;
    this.resolvedRaids = new Set();
    this._lastCheckedSeq = -1;
  }

  /**
   * Set (or clear) the iteration being tracked. Triggers a full rebuild
   * from the current buffer contents.
   * @param {string|null} iterationId
   */
  setActiveIteration(iterationId) {
    const next = iterationId || null;
    if (this.activeIteration === next) return;
    this.activeIteration = next;
    this.resolvedRaids = new Set();
    this._lastCheckedSeq = -1;
    if (next) this._rebuild();
  }

  /**
   * O(1) check: is this rootActivityId part of the active iteration?
   * Returns true when no iteration is active (filter is then a no-op).
   * Returns false for empty/null RAIDs.
   * @param {string|null|undefined} rootActivityId
   */
  matches(rootActivityId) {
    if (!this.activeIteration) return true;
    if (!rootActivityId) return false;
    return this.resolvedRaids.has(rootActivityId);
  }

  /**
   * Call after a batch of logs has been added to the buffer. Cheap:
   * scans only seqs added since the last check, then re-converges
   * the chase only if new RAIDs were captured.
   */
  onNewLogs() {
    if (!this.activeIteration) return;
    const newest = this.state.logBuffer.newestSeq;
    if (newest <= this._lastCheckedSeq) return;

    const before = this.resolvedRaids.size;
    this._scanRange(this._lastCheckedSeq + 1, newest);
    this._lastCheckedSeq = newest;

    if (this.resolvedRaids.size > before) {
      // New RAIDs captured — chase may unlock chained scopes elsewhere.
      this._converge();
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  _rebuild() {
    if (!this.activeIteration) return;
    const buf = this.state.logBuffer;
    if (!buf || buf.length === 0) return;
    this._scanRange(buf.oldestSeq, buf.newestSeq);
    this._converge();
    this._lastCheckedSeq = buf.newestSeq;
  }

  /**
   * Process every log in [startSeq, endSeq] and apply seed + chase + routes
   * once. Idempotent.
   */
  _scanRange(startSeq, endSeq) {
    if (startSeq > endSeq) return;
    const buf = this.state.logBuffer;
    const iterId = this.activeIteration;
    if (!iterId) return;

    // Build the per-iteration patterns once per scan.
    const iterLower = iterId.toLowerCase();
    const routeRe = this._buildRouteRegex(iterId);

    for (let seq = startSeq; seq <= endSeq; seq++) {
      const entry = buf.getBySeq(seq);
      if (!entry) continue;
      this._applyRules(entry, iterLower, routeRe);
    }
  }

  /**
   * Loop the chase pass until the resolved set stops growing. The chase
   * needs multiple passes because transitively-chained scopes (bg-RAID
   * → mid-RAID → leaf-RAID) only resolve once the intermediate is in
   * the set. In practice this converges in 2-3 passes.
   */
  _converge() {
    const buf = this.state.logBuffer;
    if (!buf || buf.length === 0) return;
    const iterLower = this.activeIteration ? this.activeIteration.toLowerCase() : '';
    const routeRe = this.activeIteration ? this._buildRouteRegex(this.activeIteration) : null;

    let before = -1;
    let passes = 0;
    const MAX_PASSES = 6; // safety — should converge in ≤3
    while (this.resolvedRaids.size !== before && passes < MAX_PASSES) {
      before = this.resolvedRaids.size;
      passes++;
      buf.forEach((entry) => {
        if (entry) this._applyRules(entry, iterLower, routeRe);
      });
    }
  }

  /**
   * Apply the three capture rules to one entry. Mutates resolvedRaids.
   */
  _applyRules(entry, iterLower, routeRe) {
    const msg = entry.message || '';
    const raid = entry.rootActivityId || '';

    // Rule 1 — Seed: explicit iteration mention.
    // Two-layer test: cheap pre-filter (does msg even contain the iter id?)
    // then strict regex requiring the literal "Iteration" keyword AND verify
    // the matched id equals our active iteration (no GUID-substring collisions).
    if (raid && msg.toLowerCase().indexOf(iterLower) !== -1) {
      const m = IterationCorrelator._ITER_RE.exec(msg);
      if (m && m[1] && m[1].toLowerCase() === iterLower) {
        this.resolvedRaids.add(raid);
      }
    }

    // Rule 2 — Chase: "overriding Monitored Scope is created" emitted by
    // a scope already in our set introduces a new RAID.
    if (raid && this.resolvedRaids.has(raid)) {
      const m = IterationCorrelator._OVERRIDE_RE.exec(msg);
      if (m && m[1]) {
        this.resolvedRaids.add(m[1]);
      }
    }

    // Rule 3 — Routes: per-iteration incoming request mentions.
    if (raid && routeRe && routeRe.test(msg)) {
      this.resolvedRaids.add(raid);
    }
  }

  _buildRouteRegex(iterId) {
    // Escape for safety even though iterId is GUID-shaped.
    // Word-boundary before the route name so we match both
    //   "/liveTableSchedule/getDAGExecStatus/{id}" (real-world WCL form)
    // and looser shapes like
    //   "Incoming Request: getDAGExecStatus/{id}".
    const escaped = String(iterId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b(?:runDAG|getDAGExecStatus|cancelDAG)/' + escaped, 'i');
  }
}

// Class-level patterns (compiled once).
// Iteration mention forms we accept:
//   "Iteration: <guid>", "Iteration <guid>",
//   "IterationId=<guid>", "IterationId: <guid>",
//   "[IterationId <guid>", "Iteration <guid>]"
// The separator class is `[:=\s]+` (one or more of colon/equals/whitespace)
// so all the above shapes resolve to the same capture group.
IterationCorrelator._ITER_RE =
  /\b(?:Iteration(?:Id)?|IterId)[:=\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// Overriding monitored scope capture:
//   "An overriding Monitored Scope is created with RootActivityId: <guid>, ..."
IterationCorrelator._OVERRIDE_RE =
  /overriding Monitored Scope is created with RootActivityId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Node export (for tests). Browser global is established via the build pipeline.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IterationCorrelator };
}
