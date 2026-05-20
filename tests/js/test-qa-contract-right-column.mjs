import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

var src = readFileSync('src/frontend/js/qa-curation.js', 'utf-8');

test('right column has matcher composer', function () {
  assert.match(src, /qa-workbench-matcher-composer/);
  assert.match(src, /qa-workbench-assertion-select/);
});

test('right column renders typed value inputs', function () {
  assert.match(src, /qa-workbench-scalar-input/);
  assert.match(src, /qa-workbench-range-min/);
  assert.match(src, /qa-workbench-array-input/);
  assert.match(src, /qa-workbench-exists-input/);
  assert.match(src, /qa-workbench-length-min/);
});

test('right column has issues and last-run strips', function () {
  assert.match(src, /qa-workbench-issues-strip/);
  assert.match(src, /qa-workbench-last-run-strip/);
});

test('no JSON text escape hatch in workbench', function () {
  // The workbench should not have a raw JSON editing textarea
  assert.doesNotMatch(src, /qa-workbench.*textarea.*JSON/i);
});
