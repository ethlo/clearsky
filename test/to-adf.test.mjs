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
