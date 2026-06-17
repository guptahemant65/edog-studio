import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDescription,
  isActionable,
  extractSentence,
  type DependencyEdge,
} from '../src/engine/dependency-parser.ts';

const known = new Set(['FLTAlpha', 'FLTBeta', 'FLTGamma']);

function ids(edges: DependencyEdge[]): string[] {
  return edges.map((e) => e.prerequisiteId);
}

test('parseDescription: T1 "must be enabled" → high-confidence edge', () => {
  const edges = parseDescription('FLTAlpha', 'FLTBeta must be enabled first.', known);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.prerequisiteId, 'FLTBeta');
  assert.equal(edges[0]!.tier, 'T1');
  assert.equal(edges[0]!.confidence, 'high');
  assert.equal(edges[0]!.negated, false);
  assert.equal(isActionable(edges[0]!), true);
});

test('parseDescription: T2 "Requires X" → high-confidence edge', () => {
  const edges = parseDescription('FLTAlpha', 'Requires FLTBeta to function.', known);
  assert.deepEqual(ids(edges), ['FLTBeta']);
  assert.equal(edges[0]!.tier, 'T2');
  assert.equal(edges[0]!.confidence, 'high');
});

test('parseDescription: T3 "when X is enabled" → medium confidence', () => {
  const edges = parseDescription('FLTAlpha', 'Only works when FLTBeta is enabled.', known);
  assert.deepEqual(ids(edges), ['FLTBeta']);
  assert.equal(edges[0]!.tier, 'T3');
  assert.equal(edges[0]!.confidence, 'medium');
  assert.equal(isActionable(edges[0]!), true);
});

test('parseDescription: higher-confidence tier wins per prerequisite', () => {
  // FLTBeta appears in both a T1 and a T3 phrasing — only the T1 edge survives.
  const edges = parseDescription(
    'FLTAlpha',
    'FLTBeta must be enabled. It only works when FLTBeta is enabled.',
    known,
  );
  const beta = edges.filter((e) => e.prerequisiteId === 'FLTBeta');
  assert.equal(beta.length, 1);
  assert.equal(beta[0]!.tier, 'T1');
});

test('parseDescription: negation in the sentence flags the edge as negated', () => {
  const edges = parseDescription('FLTAlpha', 'Requires FLTBeta, but is actually independent of FLTBeta.', known);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.negated, true);
  assert.equal(isActionable(edges[0]!), false); // negated edges are never actionable
});

test('parseDescription: T4 token-overlap is low confidence + non-actionable', () => {
  const edges = parseDescription('FLTAlpha', 'See also FLTGamma for related behaviour.', known);
  assert.deepEqual(ids(edges), ['FLTGamma']);
  assert.equal(edges[0]!.tier, 'T4');
  assert.equal(edges[0]!.confidence, 'low');
  assert.equal(isActionable(edges[0]!), false);
});

test('parseDescription: ignores self-references and unknown tokens for T4', () => {
  const edges = parseDescription('FLTAlpha', 'FLTAlpha and SomethingExternal are unrelated.', known);
  assert.equal(edges.length, 0);
});

test('parseDescription: empty description → no edges', () => {
  assert.deepEqual(parseDescription('FLTAlpha', '', known), []);
});

test('extractSentence: returns the sentence containing the offset', () => {
  const text = 'First sentence. FLTBeta must be enabled. Third one.';
  const idx = text.indexOf('FLTBeta');
  assert.equal(extractSentence(text, idx), 'FLTBeta must be enabled');
});
