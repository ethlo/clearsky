#!/usr/bin/env node
// Renders docs/*.md to docs/*.html (checked in, so the design docs read well without GitHub).
// Just the Markdown the docs use: headings, paragraphs, lists (nested by indent), tables,
// fenced code, images, and inline code, bold, italics and links. No dependencies.
//
//   node scripts/render-docs.mjs          write the HTML
//   node scripts/render-docs.mjs --check  exit 1 if any HTML is out of date

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(text) {
  const codes = [];
  let h = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  h = h.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href.replace(/\.md(#|$)/, '.html$1')}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`); // already escaped
}

export function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [], toc = [];
  let title = '', para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !lines[i].startsWith('```')) body.push(lines[i]);
      out.push(`<pre${fence[1] ? ` class="lang-${fence[1]}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4}) (.+)$/);
    if (h) {
      flush();
      const level = h[1].length, html = inline(h[2]);
      if (level === 1 && !title) { title = h[2]; out.push(`<h1>${html}</h1>`); continue; }
      const id = slug(h[2]);
      if (level === 2) toc.push({ id, html });
      out.push(`<h${level} id="${id}">${html}</h${level}>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(line)) {
      flush();
      // A list, nested by indent: collect its lines, then build the tree.
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.) /.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.) (.*)$/);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        else items.at(-1).text += ` ${lines[i].trim()}`;
        i++;
      }
      i--;
      const build = (from, indent) => {
        let html = `<${items[from].ordered ? 'ol' : 'ul'}>`, j = from;
        while (j < items.length && items[j].indent >= indent) {
          if (items[j].indent > indent) { const [sub, next] = build(j, items[j].indent); html = html.replace(/<\/li>$/, `${sub}</li>`); j = next; continue; }
          html += `<li>${inline(items[j].text)}</li>`;
          j++;
        }
        return [`${html}</${items[from].ordered ? 'ol' : 'ul'}>`, j];
      };
      out.push(build(0, items[0].indent)[0]);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return { title, toc, body: out.join('\n') };
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f7f8fa; --surface: #fff; --text: #111827; --text-2: #4b5563; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; --code: #f2f4f7; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0e12; --surface: #14171c; --text: #f2f4f7; --text-2: #c5cad3; --muted: #8a93a3; --line: #252a33; --accent: #6b9bff; --code: #1b1f26; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  .crumb { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  a { color: var(--accent); }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 12px; letter-spacing: -.01em; }
  h2 { font-size: 20px; margin: 36px 0 10px; padding-top: 12px; border-top: 1px solid var(--line); }
  h3 { font-size: 16px; margin: 24px 0 8px; }
  p, li { color: var(--text-2); }
  strong { color: var(--text); }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; }
  .table { overflow-x: auto; margin: 12px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; background: var(--surface); }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border: 1px solid var(--line); }
  th { color: var(--text); font-weight: 600; }
  td { color: var(--text-2); }
  img { max-width: 100%; height: auto; display: block; margin: 16px auto; }
  nav.toc { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; margin: 20px 0; font-size: 14px; }
  nav.toc ol { margin: 4px 0; padding-left: 20px; }
  @media (max-width: 560px) { .wrap { padding: 20px 16px 48px; } h1 { font-size: 23px; } }
`;

function page({ title, toc, body }, name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<!-- Generated from ${name}.md by scripts/render-docs.mjs. Edit the Markdown, then run npm run docs. -->
<style>${STYLE}</style>
</head>
<body><div class="wrap">
${name === 'index' ? '' : '<div class="crumb"><a href="index.html">Clearsky design docs</a></div>\n'}${body.replace(/(<\/h1>)/, toc.length > 2 ? `$1\n<nav class="toc"><b>Contents</b><ol>${toc.map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join('')}</ol></nav>` : '$1')}
</div></body>
</html>
`;
}

export function renderAll(dir = docs) {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const name = f.replace(/\.md$/, '');
    return { file: join(dir, `${name}.html`), html: page(render(readFileSync(join(dir, f), 'utf8')), name) };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { file, html } of renderAll()) {
    if (check) { if (!existsSync(file) || readFileSync(file, 'utf8') !== html) { console.error(`out of date: ${file}`); stale++; } }
    else writeFileSync(file, html);
  }
  if (stale) { console.error('Run: npm run docs'); process.exit(1); }
}
