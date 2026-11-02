// Links: your own favourites, in groups, each group on the Work or the Personal side. They live
// only in ~/.config/clearsky/links.json (0600) on this machine, and are edited in Clearsky.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const LIMITS = { groups: 50, links: 1000, title: 120, group: 60, url: 2048 };
const AREAS = new Set(['work', 'personal']);

// Only http(s) links: no javascript:, file: or data: that could do something when clicked.
export function cleanUrl(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return null;
  const s = x.href;
  return s.length <= LIMITS.url ? s : null;
}

const text = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '');

// A links document as saved: { groups: [{ name, area, links: [{ title, url }] }] }. Anything
// that isn't a usable link is dropped; a group without a name is "Links".
export function normalize(doc) {
  const groups = [];
  let total = 0;
  for (const g of Array.isArray(doc?.groups) ? doc.groups : []) {
    if (groups.length >= LIMITS.groups) break;
    const links = [];
    for (const l of Array.isArray(g?.links) ? g.links : []) {
      const url = cleanUrl(l?.url);
      if (!url || total >= LIMITS.links) continue;
      links.push({ title: text(l.title, LIMITS.title) || hostOf(url), url });
      total++;
    }
    groups.push({ name: text(g?.name, LIMITS.group) || 'Links', area: AREAS.has(g?.area) ? g.area : 'work', links });
  }
  return { groups };
}

export function readLinks(file) {
  try { return normalize(JSON.parse(readFileSync(file, 'utf8'))); } catch { return { groups: [] }; }
}

export function saveLinks(file, doc) {
  const clean = normalize(doc);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return clean;
}

// Bookmarks exported from a browser (Chrome, Edge, Firefox, Safari: "Export bookmarks" gives
// this HTML file). Each folder becomes a group named after its path; links outside any
// folder go to "Bookmarks". Nothing in the file is run or loaded, only read as text.
export function parseBookmarks(html, { area = 'work' } = {}) {
  const groups = new Map();
  const path = [];
  let pending = null; // a folder name waiting for its <DL>
  const ent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const tokens = String(html).matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>|<a\s([^>]*)>([\s\S]*?)<\/a>|<dl[^>]*>|<\/dl>/gi);
  for (const t of tokens) {
    const tag = t[0].slice(0, 3).toLowerCase();
    if (t[1] != null) pending = ent(t[1].replace(/<[^>]+>/g, ''));
    else if (tag === '<dl') { path.push(pending); pending = null; }
    else if (tag === '</d') path.pop();
    else if (t[2] != null) {
      const href = t[2].match(/href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i);
      const url = cleanUrl(href && ent(href[1] ?? href[2]));
      if (!url) continue;
      // The browser's own top folders ("Bookmarks bar", "Bookmarks Toolbar"…) aren't worth a name.
      const names = path.filter(Boolean).filter((n, i) => !(i === 0 && /^(bookmarks( bar| toolbar| menu)?|favorites( bar)?|other bookmarks)$/i.test(n)));
      const name = text(names.join(' / '), LIMITS.group) || 'Bookmarks';
      if (!groups.has(name)) groups.set(name, { name, area, links: [] });
      groups.get(name).links.push({ title: ent(t[3].replace(/<[^>]+>/g, '')), url });
    }
  }
  return normalize({ groups: [...groups.values()] });
}

// Imported groups added to what you have: a group with the same name and side gets the links
// it doesn't already have; new groups go at the end.
export function mergeLinks(doc, extra) {
  const out = normalize(doc);
  for (const g of normalize(extra).groups) {
    const same = out.groups.find((x) => x.name === g.name && x.area === g.area);
    if (!same) { out.groups.push(g); continue; }
    const have = new Set(same.links.map((l) => l.url));
    same.links.push(...g.links.filter((l) => !have.has(l.url)));
  }
  return normalize(out);
}
