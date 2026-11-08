import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToHtml, wikiToHtml, jiraHtml } from '../lib/jira-rich.mjs';

const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...content) => ({ type: 'paragraph', content });

test('ADF: headings, lists, code, links, tables and panels keep their shape', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Goal')] },
    p(t('Refunds '), t('must', [{ type: 'strong' }]), t(' use '), t('RefundSplitter', [{ type: 'code' }]), t(', see '), t('docs', [{ type: 'link', attrs: { href: 'https://example.com/d' } }])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }, { type: 'listItem', content: [p(t('two'))] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('first'))] }] },
    { type: 'codeBlock', attrs: { language: 'java' }, content: [t('if (a < b) {}')] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Case'))] }, { type: 'tableCell', content: [p(t('Result'))] }] }] },
    { type: 'panel', attrs: { panelType: 'warning' }, content: [p(t('Careful'))] },
    p({ type: 'mention', attrs: { id: 'x', text: '@Alex' } }, { type: 'hardBreak' }, t('bye')),
  ] };
  const h = adfToHtml(doc);
  assert.match(h, /<h4>Goal<\/h4>/);
  assert.match(h, /<b>must<\/b> use <code>RefundSplitter<\/code>, see <a href="https:\/\/example.com\/d" target="_blank" rel="noopener">docs<\/a>/);
  assert.match(h, /<ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul><ol><li><p>first<\/p><\/li><\/ol>/);
  assert.match(h, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
  assert.match(h, /<table><tr><th><p>Case<\/p><\/th><td><p>Result<\/p><\/td><\/tr><\/table>/);
  assert.match(h, /<div class="panel p-warning"><p>Careful<\/p><\/div>/);
  assert.match(h, /<span class="mention">@Alex<\/span><br>bye/);
});

test('nothing from the ticket becomes markup or a script link', () => {
  assert.equal(adfToHtml(p(t('<img src=x onerror=alert(1)>'))), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(adfToHtml(p(t('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))), '<p>x</p>');
  assert.equal(wikiToHtml('[x|javascript:alert(1)] <b>'), '<p>x &lt;b&gt;</p>');
  assert.match(adfToHtml({ type: 'panel', attrs: { panelType: '"><script>' }, content: [] }), /p-&quot;&gt;&lt;script&gt;/);
});

test('wiki markup: headings, lists, code, tables, links and quotes', () => {
  const h = wikiToHtml([
    'h2. Goal', 'Refunds *must* use {{RefundSplitter}}, see [docs|https://example.com/d].', '',
    '* one', '** nested', '* two', '# first', '',
    '{code:java}', 'if (a < b) {}', '{code}',
    '||Case||Result||', '|split|ok|',
    '{quote}said _so_{quote}', '----',
  ].join('\n'));
  assert.match(h, /<h4>Goal<\/h4>/);
  assert.match(h, /<p>Refunds <b>must<\/b> use <code>RefundSplitter<\/code>, see <a href="https:\/\/example.com\/d"[^>]*>docs<\/a>\.<\/p>/);
  assert.match(h, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul><ol><li>first<\/li><\/ol>/);
  assert.match(h, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
  assert.match(h, /<table><tr><th>Case<\/th><th>Result<\/th><\/tr><tr><td>split<\/td><td>ok<\/td><\/tr><\/table>/);
  assert.match(h, /<blockquote><p>said <i>so<\/i><\/p><\/blockquote><hr>/);
});

test('either form, by what it looks like', () => {
  assert.equal(jiraHtml(''), '');
  assert.equal(jiraHtml(JSON.stringify({ type: 'doc', content: [p(t('a'))] })), '<p>a</p>');
  assert.equal(jiraHtml('plain *text*'), '<p>plain <b>text</b></p>');
  assert.equal(jiraHtml({ type: 'doc', content: [p(t('b'))] }), '<p>b</p>');
});
