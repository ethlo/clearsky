import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUrl, normalize, readLinks, saveLinks, parseBookmarks, mergeLinks } from '../lib/links.mjs';

test('links: only plain http(s) addresses are kept', () => {
  assert.equal(cleanUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(cleanUrl(' http://example.com '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://user:pw@example.com/', 'example.com', '', null]) assert.equal(cleanUrl(bad), null, String(bad));
});

test('links: a saved document is cleaned: bad links dropped, names trimmed, a side for each group', () => {
  const d = normalize({ groups: [
    { name: '  Dev\ntools ', area: 'work', links: [{ title: '', url: 'https://www.example.com/x' }, { title: 'Bad', url: 'javascript:1' }] },
    { area: 'elsewhere', links: [{ title: 'Wiki', url: 'https://wiki.example.org' }] },
    'nonsense',
  ] });
  assert.deepEqual(d, { groups: [
    { name: 'Dev tools', area: 'work', links: [{ title: 'example.com', url: 'https://www.example.com/x' }] },
    { name: 'Links', area: 'work', links: [{ title: 'Wiki', url: 'https://wiki.example.org/' }] },
    { name: 'Links', area: 'work', links: [] },
  ] });
  assert.deepEqual(normalize(null), { groups: [] });
});

test('links: saved only for you (0600), and read back; a missing or broken file is no links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-')), file = join(dir, 'conf', 'links.json');
  assert.deepEqual(readLinks(file), { groups: [] });
  saveLinks(file, { groups: [{ name: 'School', area: 'personal', links: [{ title: 'Portal', url: 'https://school.example.com' }] }] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readLinks(file).groups[0].links[0].title, 'Portal');
  assert.match(readFileSync(file, 'utf8'), /"area": "personal"/);
});

test('links: bookmarks from a browser export become groups by folder', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://ci.example.com/" ADD_DATE="1">CI &amp; builds</A>
    <DT><H3>Ops</H3>
    <DL><p>
      <DT><A HREF="https://grafana.example.com/d/1">Dashboards</A>
      <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    </DL><p>
  </DL><p>
  <DT><A HREF="https://news.example.org">News</A>
</DL>`;
  assert.deepEqual(parseBookmarks(html, { area: 'work' }), { groups: [
    { name: 'Bookmarks', area: 'work', links: [{ title: 'CI & builds', url: 'https://ci.example.com/' }, { title: 'News', url: 'https://news.example.org/' }] },
    { name: 'Ops', area: 'work', links: [{ title: 'Dashboards', url: 'https://grafana.example.com/d/1' }] },
  ] });
});

test('links: an import adds to what you have, without doubles', () => {
  const have = { groups: [{ name: 'Ops', area: 'work', links: [{ title: 'Dash', url: 'https://grafana.example.com/' }] }] };
  const extra = { groups: [{ name: 'Ops', area: 'work', links: [{ title: 'Dash again', url: 'https://grafana.example.com/' }, { title: 'Logs', url: 'https://logs.example.com/' }] },
    { name: 'Ops', area: 'personal', links: [{ title: 'Home', url: 'https://home.example.com/' }] }] };
  const out = mergeLinks(have, extra);
  assert.deepEqual(out.groups.map((g) => [g.name, g.area, g.links.map((l) => l.title)]), [['Ops', 'work', ['Dash', 'Logs']], ['Ops', 'personal', ['Home']]]);
});
