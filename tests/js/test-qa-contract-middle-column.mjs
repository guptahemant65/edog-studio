import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

var src = readFileSync('src/frontend/js/qa-curation.js', 'utf-8');

test('middle column has slot picker', function () {
  assert.match(src, /qa-workbench-slot-picker/);
  assert.match(src, /qa-workbench-slot-select/);
});

test('middle column has kind selector', function () {
  assert.match(src, /qa-workbench-kind-selector/);
  assert.match(src, /qa-workbench-kind-btn/);
});

test('middle column renders typed parameter forms', function () {
  assert.match(src, /qa-workbench-params/);
  assert.match(src, /qa-workbench-param-input/);
});
