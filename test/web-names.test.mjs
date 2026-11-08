import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page's scripts are joined into one, so two top-level functions with the same name don't
// fail: the later one quietly replaces the other (that once stopped the chat list's live dots).
// Two top-level const/let with the same name are worse: the whole script stops loading.
test('web/js: no two top-level names are declared twice', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js');
  const seen = new Map(), dupes = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^(?:(?:async\s+)?function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))/gm)) {
      const n = m[1] || m[2];
      if (seen.has(n)) dupes.push(`${n} in ${seen.get(n)} and ${f}`); else seen.set(n, f);
    }
  }
  assert.deepEqual(dupes, []);
});
