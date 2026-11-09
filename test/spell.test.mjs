// The chat box's auto-fix (web/js/52-spell.js): which words it fixes and what it leaves alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Only the plain functions, before the part that hooks into the page.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js', '52-spell.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(`${src.slice(0, src.indexOf('const AUTOFIX_KEY'))}; this.spellFix = spellFix; this.spellFixAt = spellFixAt; this.spellInCode = spellInCode; this.SPELL_FIXES = SPELL_FIXES;`, ctx);
const { spellFix, spellFixAt, spellInCode, SPELL_FIXES } = ctx;
const atEnd = (t) => spellFixAt(t, t.length)?.to ?? null;

test('fixes common typos in the word\'s own case', () => {
  assert.equal(spellFix('teh'), 'the');
  assert.equal(spellFix('Teh'), 'The');
  assert.equal(spellFix('dont'), "don't");
  assert.equal(spellFix('im'), "I'm");
  assert.equal(spellFix('i'), 'I');
  assert.equal(spellFix('the'), null);
  assert.equal(spellFix('TEH'), null);
  assert.equal(spellFix('tehThing'), null);
});

test('the list holds no real words', () => {
  for (const w of ['lets', 'cant', 'wont', 'its', 'were', 'well', 'ill', 'id', 'shell', 'form', 'then', 'than']) assert.equal(SPELL_FIXES[w], undefined, w);
});

test('finds the word before the cursor, without its punctuation', () => {
  assert.deepEqual({ ...spellFixAt('fix teh', 7) }, { start: 4, end: 7, from: 'teh', to: 'the' });
  assert.equal(atEnd('I recieve,'), 'receive');
  assert.equal(atEnd('("thier"'), 'their');
  assert.equal(atEnd('looks fine'), null);
});

test('leaves code, paths, links, flags, refs and skills alone', () => {
  for (const t of ['run `teh', '```\nteh', 'see ~/dev/teh', 'https://x.io/teh', '--teh', '@teh', '/teh', 'teh.md', 'i.e', 'my_teh', 'teh2', '    teh', '$ grep teh', '> $ teh']) assert.equal(atEnd(t), null, t);
  assert.equal(atEnd('```\ncode\n```\nteh'), 'the');
  assert.equal(atEnd('`code` teh'), 'the');
});

test('knows when the end of the text is code', () => {
  assert.equal(spellInCode('a `b'), true);
  assert.equal(spellInCode('a `b` c'), false);
  assert.equal(spellInCode('```js\nx'), true);
  assert.equal(spellInCode('```js\nx\n```\n'), false);
});
