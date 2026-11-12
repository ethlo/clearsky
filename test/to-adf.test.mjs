import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAdf, adfArgs, isWiki } from '../lib/to-adf.mjs';

const kinds = (doc) => doc.content.map((b) => b.type);

test('wiki markup becomes headings, nested lists, code and links', () => {
  const doc = toAdf('h3. Goal\nMake the {{report}} endpoint return 200.\n\nh3. Today\n* It fails when &#34;Today&#34; is empty.\n** Seen in an *integration* test.\n* See [the docs|https://example.com/docs].\n\n{code:java}\nint a = 1;\n{code}');
  assert.deepEqual(kinds(doc), ['heading', 'paragraph', 'heading', 'bulletList', 'codeBlock']);
  assert.equal(doc.content[0].attrs.level, 3);
  assert.deepEqual(doc.content[1].content[1], { type: 'text', text: 'report', marks: [{ type: 'code' }] });
  const list = doc.content[3];
  assert.equal(list.content.length, 2);
  assert.equal(list.content[0].content[0].content[0].text, 'It fails when "Today" is empty.');
  assert.equal(list.content[0].content[1].type, 'bulletList');
  assert.deepEqual(list.content[0].content[1].content[0].content[0].content[1], { type: 'text', text: 'integration', marks: [{ type: 'strong' }] });
  assert.deepEqual(list.content[1].content[0].content[1].marks, [{ type: 'link', attrs: { href: 'https://example.com/docs' } }]);
  assert.equal(doc.content[4].attrs.language, 'java');
  assert.equal(doc.content[4].content[0].text, 'int a = 1;');
});

test('Markdown works too: headings, ordered lists, bold, code fences and tables', () => {
  const s = '## Change\n1. Treat an empty sum as **0**.\n2. Add a test for `GET /stats`.\n\n```sql\nselect 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  assert.equal(isWiki(s), false);
  const doc = toAdf(s);
  assert.deepEqual(kinds(doc), ['heading', 'orderedList', 'codeBlock', 'table']);
  assert.deepEqual(doc.content[1].content[0].content[0].content[1], { type: 'text', text: '0', marks: [{ type: 'strong' }] });
  assert.equal(doc.content[3].content[0].content[0].type, 'tableHeader');
  assert.equal(doc.content[3].content[1].content[1].type, 'tableCell');
});

test('acli arguments: description and body go as ADF, short plain text stays', () => {
  const a = adfArgs(['jira', 'workitem', 'create', '--summary', 'X', '--description', 'h3. Goal\nFix it'], () => '');
  assert.equal(JSON.parse(a[6]).content[0].type, 'heading');
  assert.deepEqual(adfArgs(['jira', 'workitem', 'comment', 'create', '--body', 'Looks good'], () => ''), ['jira', 'workitem', 'comment', 'create', '--body', 'Looks good']);
  const f = adfArgs(['jira', 'workitem', 'edit', '--description-file', 'd.md'], (p) => { assert.equal(p, '/w/d.md'); return '# Title\n\ntext'; }, '/w');
  assert.equal(f[3], '--description');
  assert.equal(JSON.parse(f[4]).content[0].type, 'heading');
  const adf = JSON.stringify({ type: 'doc', version: 1, content: [] });
  assert.deepEqual(adfArgs(['--body', adf], () => ''), ['--body', adf]);
  assert.deepEqual(adfArgs(['--description-file', '/etc/x'], () => { throw new Error('outside'); }), ['--description-file', '/etc/x']);
});

test('acli arguments: short flags, comment update and --from-json', () => {
  const files = {};
  const write = (name, text) => { files[name] = text; return `/tmp/x/${name}`; };
  // with a place for files, ADF goes in one: acli takes ADF from --description-file
  const d = adfArgs(['jira', 'workitem', 'create', '-d', 'h3. Goal\nFix it'], () => '', null, write);
  assert.deepEqual(d.slice(3), ['--description-file', '/tmp/x/description.json']);
  assert.equal(JSON.parse(files['description.json']).content[0].type, 'heading');
  const b = adfArgs(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1', '-b', '## Done\n- one\n- two'], () => '', null, write);
  assert.deepEqual(b.slice(6), ['--body-file', '/tmp/x/body.json']);
  assert.equal(JSON.parse(files['body.json']).content[1].type, 'bulletList');
  // Markdown in a file, at a relative path: read from the chat's folder, sent as ADF
  const F = adfArgs(['jira', 'workitem', 'edit', '--key', 'ABC-1', '--description-file', 'd.md'], (p) => { assert.equal(p, '/w/d.md'); return '## Goal\n- a'; }, '/w', write);
  assert.deepEqual(F.slice(-2), ['--description-file', '/tmp/x/description.json']);
  assert.equal(JSON.parse(files['description.json']).content[0].type, 'heading');
  // a file Clearsky may not read goes on with its absolute path
  assert.deepEqual(adfArgs(['--body-file', 'c.md'], () => { throw new Error('outside'); }, '/w', write), ['--body-file', '/w/c.md']);
  // comment update too: ADF in --body-file (acli has no --body-adf)
  const u = adfArgs(['jira', 'workitem', 'comment', 'update', '--key', 'ABC-1', '--id', '9', '--body', 'h3. Fixed\nIn abc123'], () => '', null, write);
  assert.deepEqual(u.slice(-2), ['--body-file', '/tmp/x/body.json']);
  assert.equal(JSON.parse(files['body.json']).content[0].type, 'heading');
  assert.deepEqual(adfArgs(['jira', 'workitem', 'comment', 'update', '--body', 'ok'], () => '', null, write), ['jira', 'workitem', 'comment', 'update', '--body', 'ok']);
  // a short plain line stays inline
  assert.deepEqual(adfArgs(['jira', 'workitem', 'comment', 'create', '--body', 'Looks good'], () => '', null, write), ['jira', 'workitem', 'comment', 'create', '--body', 'Looks good']);
  // --from-json: its description becomes ADF in a copy
  const j = adfArgs(['jira', 'workitem', 'create', '--from-json', 'w.json'], () => JSON.stringify({ summary: 'S', projectKey: 'ABC', description: 'h3. Goal\nX' }), '/w', write);
  assert.deepEqual(j.slice(-2), ['--from-json', '/tmp/x/workitem.json']);
  const def = JSON.parse(files['workitem.json']);
  assert.equal(def.summary, 'S');
  assert.equal(def.description.content[0].type, 'heading');
  // without a place for files, --from-json stays as it is, with its path made absolute
  assert.deepEqual(adfArgs(['--from-json', 'w.json'], () => '{}', '/w'), ['--from-json', '/w/w.json']);
});

test('plain ADF holding wiki text is found again', async () => {
  const { plainAdfText, hasLiteralMarkup } = await import('../lib/to-adf.mjs');
  const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h3. Goal' }, { type: 'hardBreak' }, { type: 'text', text: 'Fix {{x}}' }] }] };
  assert.equal(plainAdfText(doc), 'h3. Goal\nFix {{x}}');
  assert.equal(hasLiteralMarkup('h3. Goal\nFix'), true);
  assert.equal(hasLiteralMarkup('Just a sentence. And another - with a dash.'), false);
  assert.equal(plainAdfText(toAdf('## Real\n\ntext')), null);
});
