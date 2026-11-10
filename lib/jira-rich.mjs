// A Jira description as HTML, with its formatting: headings, lists, code, links, tables, quotes
// and panels. Jira Cloud sends Atlassian Document Format (ADF, JSON); older sites and some acli
// output send wiki markup. Every tag here is one this file writes, all text is escaped, and
// links are only http(s), so the result is safe to put in the page as it is.

import { toAdf, plainAdfText, hasLiteralMarkup } from './to-adf.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null);
const a = (url, text) => {
  const u = safeUrl(url);
  return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${text}</a>` : text;
};

// ---- ADF

function marks(text, list = []) {
  let h = esc(text);
  for (const m of list) {
    if (m.type === 'strong') h = `<b>${h}</b>`;
    else if (m.type === 'em') h = `<i>${h}</i>`;
    else if (m.type === 'code') h = `<code>${h}</code>`;
    else if (m.type === 'strike') h = `<s>${h}</s>`;
    else if (m.type === 'underline') h = `<u>${h}</u>`;
    else if (m.type === 'subsup') h = m.attrs?.type === 'sub' ? `<sub>${h}</sub>` : `<sup>${h}</sup>`;
    else if (m.type === 'link') h = a(m.attrs?.href, h);
  }
  return h;
}

export function adfToHtml(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(adfToHtml).join('');
  if (typeof node !== 'object') return '';
  const inner = () => adfToHtml(node.content);
  const at = node.attrs || {};
  switch (node.type) {
    case 'doc': return inner();
    case 'paragraph': return `<p>${inner()}</p>`;
    case 'text': return marks(node.text, node.marks);
    case 'hardBreak': return '<br>';
    case 'heading': { const l = Math.min(6, Math.max(1, Number(at.level) || 3)) + 2; return `<h${Math.min(6, l)}>${inner()}</h${Math.min(6, l)}>`; }
    case 'bulletList': return `<ul>${inner()}</ul>`;
    case 'orderedList': return `<ol${Number(at.order) > 1 ? ` start="${Number(at.order)}"` : ''}>${inner()}</ol>`;
    case 'listItem': return `<li>${inner()}</li>`;
    case 'taskList': return `<ul class="tasks">${inner()}</ul>`;
    case 'taskItem': return `<li>${at.state === 'DONE' ? '☑' : '☐'} ${inner()}</li>`;
    case 'decisionList': return `<ul class="tasks">${inner()}</ul>`;
    case 'decisionItem': return `<li>◆ ${inner()}</li>`;
    case 'codeBlock': return `<pre><code>${esc((node.content || []).map((t) => t.text || '').join(''))}</code></pre>`;
    case 'blockquote': return `<blockquote>${inner()}</blockquote>`;
    case 'rule': return '<hr>';
    case 'panel': return `<div class="panel p-${esc(at.panelType || 'info')}">${inner()}</div>`;
    case 'expand': case 'nestedExpand': return `<details open><summary>${esc(at.title || 'Details')}</summary>${inner()}</details>`;
    case 'table': return `<div class="tbl"><table>${inner()}</table></div>`;
    case 'tableRow': return `<tr>${inner()}</tr>`;
    case 'tableHeader': return `<th>${inner()}</th>`;
    case 'tableCell': return `<td>${inner()}</td>`;
    case 'mention': return `<span class="mention">${esc(at.text || '@someone')}</span>`;
    case 'emoji': return esc(at.text || at.shortName || '');
    case 'status': return `<span class="jstatus">${esc(at.text || '')}</span>`;
    case 'date': return esc(at.timestamp ? new Date(Number(at.timestamp)).toISOString().slice(0, 10) : '');
    case 'inlineCard': case 'blockCard': case 'embedCard': return at.url ? a(at.url, esc(at.url)) : '';
    case 'mediaSingle': case 'mediaGroup': case 'media': case 'mediaInline': return node.type === 'media' || node.type === 'mediaInline' ? '<span class="muted">[attachment]</span>' : inner();
    default: return inner();
  }
}

// ---- Wiki markup

function wikiInline(s) {
  // Pull out {{mono}} and links first, so their insides aren't formatted.
  const keep = [];
  const hold = (h) => `\u0000${keep.push(h) - 1}\u0000`;
  let t = s.replace(/\{\{(.+?)\}\}/g, (m, c) => hold(`<code>${esc(c)}</code>`));
  t = t.replace(/\[([^\]|]+)\|([^\]]+)\]/g, (m, text, url) => hold(a(url, esc(text))));
  t = t.replace(/\[~(?:accountid:)?[^\]]+\]/g, () => hold('<span class="mention">@someone</span>'));
  t = t.replace(/\[(https?:\/\/[^\]\s]+)\]/g, (m, url) => hold(a(url, esc(url))));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+)/g, (m, pre, url) => pre + hold(a(url, esc(url))));
  let h = esc(t);
  h = h.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|\s)-(?!\s)([^-\n]+?)-(?=\s|$)/g, '$1<s>$2</s>')
    .replace(/(^|[^\w])\+(?!\s)([^+\n]+?)\+(?!\w)/g, '$1<u>$2</u>');
  return h.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[i]);
}

export function wikiToHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = []; // open list tags, like ['ul', 'ol']
  let para = [];
  let table = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(wikiInline).join('<br>')}</p>`); para = []; } };
  const closeLists = (depth = 0) => { while (list.length > depth) out.push(`</li></${list.pop()}>`); };
  const flushTable = () => { if (table) { out.push(`<div class="tbl"><table>${table.join('')}</table></div>`); table = null; } };
  const flush = () => { flushPara(); closeLists(); flushTable(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = line.match(/^\s*\{(code|noformat|quote|panel)(?::[^}]*)?\}(.*)$/);
    if (block) {
      flush();
      const tag = block[1], body = [];
      let rest = block[2];
      const end = new RegExp(`\\{${tag}\\}`);
      while (!end.test(rest) && i + 1 < lines.length) { body.push(rest); rest = lines[++i]; }
      body.push(rest.replace(end, '').replace(/\s+$/, '') === '' ? '' : rest.split(end)[0]);
      const content = body.join('\n').replace(/^\n+|\n+$/g, '');
      if (tag === 'code' || tag === 'noformat') out.push(`<pre><code>${esc(content)}</code></pre>`);
      else if (tag === 'quote') out.push(`<blockquote>${wikiToHtml(content)}</blockquote>`);
      else out.push(`<div class="panel p-info">${wikiToHtml(content)}</div>`);
      continue;
    }
    const h = line.match(/^\s*h([1-6])\.\s+(.*)$/);
    if (h) { flush(); const l = Math.min(6, Number(h[1]) + 2); out.push(`<h${l}>${wikiInline(h[2])}</h${l}>`); continue; }
    if (/^\s*-{4,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    const bq = line.match(/^\s*bq\.\s+(.*)$/);
    if (bq) { flush(); out.push(`<blockquote><p>${wikiInline(bq[1])}</p></blockquote>`); continue; }
    const li = line.match(/^\s*([*#-]+)\s+(.*)$/);
    if (li && !(li[1] === '-' && /^\s*-\S/.test(line))) {
      flushPara(); flushTable();
      const kinds = [...li[1]].map((c) => (c === '#' ? 'ol' : 'ul'));
      const depth = kinds.length;
      // Levels that change kind (* to #) close and open again.
      let same = 0;
      while (same < Math.min(list.length, depth) && list[same] === kinds[same]) same++;
      closeLists(same);
      if (list.length === depth) out.push('</li><li>'); // a sibling
      while (list.length < depth) { out.push(`<${kinds[list.length]}><li>`); list.push(kinds[list.length]); }
      out.push(wikiInline(li[2]));
      continue;
    }
    const row = line.match(/^\s*(\|\|?)(.*?)\|*\s*$/);
    if (row && line.trim().startsWith('|')) {
      flushPara(); closeLists();
      table ||= [];
      const cells = line.trim().replace(/\|+\s*$/, '').split(/(\|\|?)/).filter((x) => x !== '');
      let cell = '<tr>', tag = 'td';
      for (const c of cells) {
        if (c === '||') tag = 'th'; else if (c === '|') tag = 'td'; else cell += `<${tag}>${wikiInline(c.trim())}</${tag}>`;
      }
      table.push(`${cell}</tr>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    closeLists(); flushTable();
    para.push(line);
  }
  flush();
  return out.join('');
}

// Either form, as HTML; empty when there's no description.
export function jiraHtml(body) {
  if (!body) return '';
  if (typeof body === 'string') {
    const t = body.trim();
    if (t.startsWith('{') && t.includes('"type"')) { try { return adfToHtml(JSON.parse(t)); } catch { /* wiki after all */ } }
    return wikiToHtml(body);
  }
  // Wiki markup or Markdown that reached Jira as plain text ("h3. Goal" as a line of its own):
  // shown with the formatting it was written with.
  const plain = plainAdfText(body);
  if (plain && hasLiteralMarkup(plain)) return adfToHtml(toAdf(plain));
  return adfToHtml(body);
}
