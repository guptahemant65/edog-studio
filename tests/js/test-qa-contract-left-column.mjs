import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

var src = readFileSync('src/frontend/js/qa-curation.js', 'utf-8');

test('qa-curation has three-column workbench shell', function () {
  assert.match(src, /qa-workbench-three-col/);
  assert.match(src, /qa-workbench-left/);
  assert.match(src, /qa-workbench-middle/);
  assert.match(src, /qa-workbench-right/);
});

test('left column has scenario list and search', function () {
  assert.match(src, /qa-workbench-scenario-list/);
  assert.match(src, /qa-workbench-search/);
});

test('left column renders quarantine chip', function () {
  assert.match(src, /qa-workbench-quarantine-chip/);
  assert.match(src, /PRE-CONTRACT/);
});
