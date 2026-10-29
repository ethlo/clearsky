import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, renderAll } from '../scripts/render-docs.mjs';

test('the rendered design docs match their Markdown', () => {
  for (const { file, html } of renderAll()) assert.equal(readFileSync(file, 'utf8'), html, `${file} is out of date: run npm run docs`);
});

test('renders the Markdown the docs use', () => {
  const { title, body } = render('# T\n\n## A <b>\n\nSee [x](b.md) and `a<b>`, **bold**.\n\n1. one\n   - nested\n2. two\n\n| k | v |\n|---|---|\n| a | `b` |\n\n```sh\nx < y\n```\n');
  assert.equal(title, 'T');
  assert.match(body, /<h2 id="a-b">A &lt;b&gt;<\/h2>/);
  assert.match(body, /<a href="b.html">x<\/a> and <code>a&lt;b&gt;<\/code>, <strong>bold<\/strong>/);
  assert.match(body, /<ol><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ol>/);
  assert.match(body, /<td>a<\/td><td><code>b<\/code><\/td>/);
  assert.match(body, /<pre class="lang-sh"><code>x &lt; y<\/code><\/pre>/);
});
