// Every file a module names is there. `import … from './x.mjs'` fails when Clearsky starts, but
// `await import('./x.mjs')` only when that line runs, in a command nobody tried after the file
// moved. Both are looked up from the file they are written in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []));

test('every module a file imports exists, also the ones imported when a command runs', () => {
  const missing = [];
  let seen = 0;
  for (const file of [...files(join(root, 'bin')), ...files(join(root, 'lib'))]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'(\.{1,2}\/[^']+)'/g)) {
      seen++;
      if (!existsSync(resolve(dirname(file), m[1]))) missing.push(`${relative(root, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(seen > 100, 'the imports were found');
});
