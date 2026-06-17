/**
 * Dependency / inert parser (architecture §4, C06 §2).
 *
 * Extracts structured dependency edges from the free-form English `Description`
 * field of FM flags. There is no structured depends_on field, so this is a
 * tiered regex parser tuned to observed phrasings. Design posture (§4.1): err
 * toward silence (no false positives) over coverage. Novel phrasings are missed
 * and surfaced as `potentialMisses` for human review.
 */

export type Tier = 'T1' | 'T2' | 'T3' | 'T4';
export type Confidence = 'high' | 'medium' | 'low';

export interface DependencyEdge {
  sourceId: string;
  prerequisiteId: string;
  tier: Tier;
  confidence: Confidence;
  negated: boolean;
  sourceExcerpt: string;
  matchPattern: string;
}

interface PatternTier {
  tier: Tier;
  confidence: Confidence;
  pattern: RegExp;
}

// Patterns are recreated per call (regex with /g carries lastIndex state).
function patternTiers(): PatternTier[] {
  return [
    { tier: 'T1', confidence: 'high', pattern: /(\b[A-Z][A-Za-z0-9_]+)\s+must\s+be\s+enabled/g },
    {
      tier: 'T2',
      confidence: 'high',
      pattern: /(?:requires|depends\s+on|prerequisite[:\s]+)\s*(\b[A-Z][A-Za-z0-9_]+)/gi,
    },
    {
      tier: 'T3',
      confidence: 'medium',
      pattern: /(?:when|if|only\s+works?\s+with)\s+(\b[A-Z][A-Za-z0-9_]+)\s+(?:is\s+)?(?:enabled|on|true)/gi,
    },
  ];
}

const NEGATION_PATTERNS: RegExp[] = [
  /without\s+requiring/i,
  /does\s+not\s+depend\s+on/i,
  /independent\s+of/i,
  /no\s+dependency\s+on/i,
];

/** The sentence containing character offset `index` (split on . ! ? newlines). */
export function extractSentence(text: string, index: number): string {
  const boundary = /[.!?\n]/;
  let start = 0;
  for (let i = index; i >= 0; i--) {
    if (boundary.test(text[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    if (boundary.test(text[i] ?? '')) {
      end = i;
      break;
    }
  }
  return text.slice(start, end).trim();
}

function tokenize(text: string): string[] {
  return text.match(/\b[A-Za-z][A-Za-z0-9_]+\b/g) ?? [];
}

/**
 * Parse one flag's Description into dependency edges.
 * @param allKnownFlagIds set of every known flag id (for T4 token-overlap matching).
 */
export function parseDescription(
  flagId: string,
  description: string,
  allKnownFlagIds: ReadonlySet<string>,
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>(); // prerequisiteId already captured by a higher tier
  if (!description) return edges;

  // 1. T1–T3 regex patterns (ordered; higher confidence wins per prereq).
  for (const { tier, confidence, pattern } of patternTiers()) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(description)) !== null) {
      const prereqId = match[1];
      if (!prereqId || prereqId === flagId) continue;
      if (seen.has(prereqId)) continue;
      const sentence = extractSentence(description, match.index);
      const negated = NEGATION_PATTERNS.some((p) => p.test(sentence));
      edges.push({
        sourceId: flagId,
        prerequisiteId: prereqId,
        tier,
        confidence,
        negated,
        sourceExcerpt: sentence,
        matchPattern: pattern.source,
      });
      seen.add(prereqId);
    }
  }

  // 2. T4: token overlap with known flag ids (informational only).
  for (const token of tokenize(description)) {
    if (token === flagId || seen.has(token) || !allKnownFlagIds.has(token)) continue;
    edges.push({
      sourceId: flagId,
      prerequisiteId: token,
      tier: 'T4',
      confidence: 'low',
      negated: false,
      sourceExcerpt: extractSentence(description, description.indexOf(token)),
      matchPattern: 'token-overlap',
    });
    seen.add(token);
  }

  return edges;
}

export interface PotentialMiss {
  flagId: string;
  mentionedIds: string[];
  excerpt: string;
}

export interface ParserDiagnostics {
  flagsAnalyzed: number;
  edgesExtracted: number;
  potentialMisses: PotentialMiss[];
  negationsDetected: Array<{ flagId: string; prereqId: string; sentence: string }>;
}

const confidenceRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** medium-or-higher confidence test, used by chain walking + inert classification. */
export function isActionable(edge: DependencyEdge): boolean {
  return confidenceRank[edge.confidence] >= confidenceRank.medium && !edge.negated;
}
