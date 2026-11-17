import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contentSecurityPolicy, pageHeaders, crossSite, webUrl } from '../lib/page-security.mjs';
import { buildPage } from '../bin/clearsky.mjs';

test('a page runs only its own scripts, loads nothing from elsewhere and can\'t be framed', () => {
  const html = '<html><script>one()</script><p onclick="x()">hi</p><script type="module">\ntwo()\n</script></html>';
  const csp = contentSecurityPolicy(html);
  for (const body of ['one()', '\ntwo()\n']) assert.ok(csp.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`));
  assert.doesNotMatch(csp.match(/script-src [^;]+/)[0], /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.equal(pageHeaders(html)['X-Frame-Options'], 'DENY');
  assert.match(contentSecurityPolicy('<p>no scripts</p>'), /script-src 'none'/);
});

test('Clearsky\'s own page gets a hash for each of its scripts', () => {
  const page = buildPage('token');
  const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  assert.equal((contentSecurityPolicy(page).match(/'sha256-/g) || []).length, new Set(scripts.map((m) => m[1])).size);
  assert.doesNotMatch(page, /<script[^>]*\ssrc=|\son[a-z]+="/i, 'no outside scripts and no on… attributes, which the policy would stop');
});

test('the API refuses a request another site makes from your browser', () => {
  const req = (site) => ({ headers: site ? { 'sec-fetch-site': site } : {} });
  assert.equal(crossSite(req('cross-site'), '/api/standup/say'), true);
  assert.equal(crossSite(req('same-site'), '/api/work'), true, 'another port on this machine is another site');
  assert.equal(crossSite(req('same-origin'), '/api/work'), false);
  assert.equal(crossSite(req('none'), '/api/work'), false, 'typed into the address bar');
  assert.equal(crossSite(req(null), '/api/restart'), false, 'a command line, or Clearsky itself');
  assert.equal(crossSite(req('cross-site'), '/'), false, 'a link to the page itself still opens');
});

test('links from outside are web links or nothing', () => {
  assert.equal(webUrl('https://meet.example.com/abc'), 'https://meet.example.com/abc');
  assert.equal(webUrl('javascript:alert(1)'), null);
  assert.equal(webUrl('data:text/html,<script>1</script>'), null);
  assert.equal(webUrl('https://x.example/"onmouseover="1'), null);
  assert.equal(webUrl(null), null);
});
