/**
 * Inert intelligence response builder (architecture §7 endpoint 11, §4, C06 §5.5).
 *
 * Parses every flag's Description into dependency edges, resolves prerequisites
 * against the FLT registry (in-store flags), and classifies each flag:
 *   INERT          — an actionable prerequisite is resolved and OFF in prod
 *                    (the flag looks enabled but its dependency is dead).
 *   INFORMATIONAL  — edges exist but are unresolved/external, negated, or low
 *                    confidence; never asserted as INERT (§4.5 posture).
 *   OK             — all actionable prerequisites are satisfied in prod.
 *
 * External (non-FLT) prerequisites are not fetched here (the builder is pure over
 * the warm store), so they resolve as `unresolved` and stay INFORMATIONAL.
 */
import { currentStates } from '../engine/current-state.ts';
import {
  parseDescription,
  isActionable,
  type DependencyEdge,
  type ParserDiagnostics,
  type PotentialMiss,
} from '../engine/dependency-parser.ts';
import { responseMeta, type ResponseMeta } from './meta.ts';
import type { CellState } from '../types/model.ts';
import type { WarmStore } from '../engine/warm-store.ts';

export type Resolution = 'resolved-flt' | 'unresolved';
export type InertStatus = 'INERT' | 'INFORMATIONAL' | 'OK';

export interface ResolvedEdge {
  prerequisiteId: string;
  tier: DependencyEdge['tier'];
  confidence: DependencyEdge['confidence'];
  negated: boolean;
  resolution: Resolution;
  /** prerequisite's prod state when resolved-flt, else null. */
  prereqProdState: CellState | null;
  /** actionable + resolved-flt + prerequisite off in prod. */
  isBlocker: boolean;
  sourceExcerpt: string;
}

export interface InertFinding {
  flagId: string;
  status: InertStatus;
  edges: ResolvedEdge[];
}

export interface InertIntelligencePayload {
  findings: InertFinding[];
  inertCount: number;
  informationalCount: number;
  parserMeta: ParserDiagnostics;
  meta: ResponseMeta;
}

export function buildInertResponse(store: WarmStore, now: number = Date.now()): InertIntelligencePayload {
  const snapshot = store.current();
  const vintages = snapshot ? [...snapshot.flags.values()] : [];
  const knownIds = new Set(vintages.map((v) => v.flagId));

  // prod state per in-store flag, for prerequisite resolution.
  const prodStateById = new Map<string, CellState>();
  for (const v of vintages) prodStateById.set(v.flagId, currentStates(v.events).prod);

  const findings: InertFinding[] = [];
  const potentialMisses: PotentialMiss[] = [];
  const negationsDetected: ParserDiagnostics['negationsDetected'] = [];
  let edgesExtracted = 0;
  let inertCount = 0;
  let informationalCount = 0;

  for (const v of vintages) {
    const edges = parseDescription(v.flagId, v.description, knownIds);
    edgesExtracted += edges.length;

    const hasRegexEdge = edges.some((e) => e.tier !== 'T4');
    const mentioned = edges.filter((e) => e.tier === 'T4').map((e) => e.prerequisiteId);
    if (!hasRegexEdge && mentioned.length > 0) {
      potentialMisses.push({ flagId: v.flagId, mentionedIds: mentioned, excerpt: v.description });
    }

    const resolved: ResolvedEdge[] = edges.map((e) => {
      const resolution: Resolution = prodStateById.has(e.prerequisiteId) ? 'resolved-flt' : 'unresolved';
      const prereqProdState = resolution === 'resolved-flt' ? prodStateById.get(e.prerequisiteId)! : null;
      const isBlocker = isActionable(e) && resolution === 'resolved-flt' && prereqProdState === 'off';
      if (e.negated) negationsDetected.push({ flagId: v.flagId, prereqId: e.prerequisiteId, sentence: e.sourceExcerpt });
      return {
        prerequisiteId: e.prerequisiteId,
        tier: e.tier,
        confidence: e.confidence,
        negated: e.negated,
        resolution,
        prereqProdState,
        isBlocker,
        sourceExcerpt: e.sourceExcerpt,
      };
    });

    if (resolved.length === 0) continue; // no dependency info — not surfaced

    let status: InertStatus;
    if (resolved.some((e) => e.isBlocker)) status = 'INERT';
    else if (resolved.some((e) => isActionableResolvedSatisfied(e))) status = 'OK';
    else status = 'INFORMATIONAL';

    if (status === 'INERT') inertCount += 1;
    else if (status === 'INFORMATIONAL') informationalCount += 1;

    findings.push({ flagId: v.flagId, status, edges: resolved });
  }

  findings.sort((a, b) => statusRank(b.status) - statusRank(a.status) || a.flagId.localeCompare(b.flagId));

  return {
    findings,
    inertCount,
    informationalCount,
    parserMeta: { flagsAnalyzed: vintages.length, edgesExtracted, potentialMisses, negationsDetected },
    meta: responseMeta(store, now),
  };
}

/** An actionable, resolved prerequisite that is non-off in prod (dependency satisfied). */
function isActionableResolvedSatisfied(e: ResolvedEdge): boolean {
  return (
    e.resolution === 'resolved-flt' &&
    !e.negated &&
    (e.confidence === 'high' || e.confidence === 'medium') &&
    e.prereqProdState !== null &&
    e.prereqProdState !== 'off'
  );
}

function statusRank(s: InertStatus): number {
  return s === 'INERT' ? 2 : s === 'INFORMATIONAL' ? 1 : 0;
}
