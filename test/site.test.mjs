import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build-site.mjs';

test('the website builds, and every link and image on it is there', () => {
  const out = build(mkdtempSync(join(tmpdir(), 'clearsky-site-')));
  try {
    const pages = ['index.html', 'getting-started.html', 'guide.html', 'docs/architecture.html', 'docs/plugins.html', 'docs/team-pack.html'];
    for (const p of pages) assert.ok(existsSync(join(out, p)), `${p} is missing`);
    assert.equal(readFileSync(join(out, 'CNAME'), 'utf8').trim().split('\n').length, 1);
    const html = (p) => readFileSync(join(out, p), 'utf8');
    for (const p of pages) {
      const page = html(p);
      assert.match(page, /<title>[^<]+<\/title>/);
      for (const [, url] of page.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) {
        if (/^[a-z]+:/i.test(url)) continue;
        const [path, hash] = url.split('#');
        const target = path ? posix.normalize(posix.join(posix.dirname(p), path)) : p;
        assert.ok(existsSync(join(out, target)), `${p} links to ${url}, which isn't there`);
        if (hash) assert.ok(html(target).includes(`id="${hash}"`), `${p} links to #${hash}, which ${target} doesn't have`);
      }
    }
    assert.deepEqual(readdirSync(join(out, 'img')).filter((f) => !html('index.html').includes(`img/${f}`)), [], 'every image is used');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
