import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

var analysisSrc = readFileSync('src/frontend/js/qa-analysis.js', 'utf-8');

test('qa-analysis renders catalog-health strip markers', function () {
  assert.match(analysisSrc, /qa-analysis-catalog-strip/);
  assert.match(analysisSrc, /provider-status/);
});

test('qa-analysis fetches catalog from proxy', function () {
  assert.match(analysisSrc, /\/api\/contract\/catalog\//);
});
