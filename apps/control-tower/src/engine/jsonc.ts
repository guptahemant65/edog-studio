/**
 * Tolerant JSONC parsing for FeatureManagement flag files.
 *
 * The real flag configs in the FeatureManagement repo are JSON-with-comments:
 * `//` line comments, `/* *\/` block comments, and occasional trailing commas.
 * Strict `JSON.parse` rejects them, so we sanitise first. Both passes are
 * string-literal aware, so comment markers or commas INSIDE string values
 * (e.g. a `"https://..."` URL) are preserved untouched.
 */

/** Remove `//` line and `/* *\/` block comments, ignoring markers inside strings. */
export function stripJsonComments(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  let inStr = false;
  let quote = '';
  while (i < n) {
    const c = input[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && input[i + 1] === '/') {
      i += 2;
      while (i < n && input[i] !== '\n' && input[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop trailing commas before `}`/`]`, ignoring commas inside strings. */
export function dropTrailingCommas(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  let inStr = false;
  let quote = '';
  while (i < n) {
    const c = input[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(input[j] ?? '')) j++;
      if (j < n && (input[j] === '}' || input[j] === ']')) {
        i++; // skip the trailing comma
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse JSONC (JSON + comments + trailing commas) into a value. */
export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(dropTrailingCommas(stripJsonComments(text))) as T;
}
