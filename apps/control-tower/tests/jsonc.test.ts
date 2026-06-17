/**
 * JSONC parsing tests — FeatureManagement flag files carry `//` comments and
 * trailing commas; the sanitiser must strip those WITHOUT corrupting comment
 * markers or commas that live inside string values (e.g. URLs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonComments, dropTrailingCommas, parseJsonc } from '../src/engine/jsonc.ts';

test('stripJsonComments: removes line and block comments', () => {
  const src = '{\n  // a comment\n  "a": 1, /* inline */ "b": 2\n}';
  const obj = JSON.parse(stripJsonComments(src));
  assert.deepEqual(obj, { a: 1, b: 2 });
});

test('stripJsonComments: preserves // and /* inside string values', () => {
  const src = '{ "url": "https://dev.azure.com/x", "glob": "/* not a comment */" }';
  const obj = JSON.parse(stripJsonComments(src));
  assert.equal(obj.url, 'https://dev.azure.com/x');
  assert.equal(obj.glob, '/* not a comment */');
});

test('dropTrailingCommas: removes trailing commas, keeps in-string commas', () => {
  const src = '{ "list": [1, 2, 3,], "s": "a,}", }';
  const obj = JSON.parse(dropTrailingCommas(src));
  assert.deepEqual(obj.list, [1, 2, 3]);
  assert.equal(obj.s, 'a,}');
});

test('parseJsonc: realistic flag file with comments + trailing comma', () => {
  const raw = `{
    // FabricFM flag
    "Id": "FLTSample",
    "Description": "A sample flag", // owner: someone
    "Environments": {
      "PROD": { "Enabled": true, }, //FabricFM
    },
  }`;
  const obj = parseJsonc<{ Id: string; Environments: Record<string, unknown> }>(raw);
  assert.equal(obj.Id, 'FLTSample');
  assert.deepEqual(obj.Environments.PROD, { Enabled: true });
});

test('parseJsonc: plain JSON still parses', () => {
  assert.deepEqual(parseJsonc('{"a":1}'), { a: 1 });
});
