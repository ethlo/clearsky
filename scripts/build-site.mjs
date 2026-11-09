#!/usr/bin/env node
// Builds the Clearsky website into _site/ (or the folder given): the hand-written pages in site/,
// the README as the guide, and the design docs, all with one header and side menu. No dependencies;
// the Markdown goes through scripts/render-docs.mjs. GitHub Pages runs this (.github/workflows/pages.yml).
//
//   node scripts/build-site.mjs [out]      build
//   npx serve _site  /  python3 -m http.server -d _site    look at it

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './render-docs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'https://github.com/ethlo/clearsky';
const SITE = `https://${readFileSync(join(root, 'site', 'CNAME'), 'utf8').trim()}`;

// Markdown that becomes a page: source (from the repo root) → page (in the site).
const PAGES = [
  { src: 'README.md', out: 'guide.html', title: 'Guide', lead: 'Everything Clearsky does, and how to set each part up.' },
  { src: 'docs/architecture.md', out: 'docs/architecture.html' },
  { src: 'docs/plugins.md', out: 'docs/plugins.html' },
  { src: 'docs/team-pack.md', out: 'docs/team-pack.html' },
  { src: 'docs/windows.md', out: 'docs/windows.html' },
];
const FILES = ['docs/architecture.svg']; // copied as they are, for the pages above

const MENU = [
  ['Start', [['Getting started', 'getting-started.html'], ['On Windows', 'docs/windows.html'], ['Guide', 'guide.html']]],
  ['Design docs', [['How Clearsky works', 'docs/architecture.html'], ['Plugins', 'docs/plugins.html'], ['Team packs', 'docs/team-pack.html']]],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rel = (from, to) => posix.relative(posix.dirname(from), to) || posix.basename(to);

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M10 21.5h12.2a4.3 4.3 0 0 0 .5-8.6 6 6 0 0 0-11.4 1.6A3.6 3.6 0 0 0 10 21.5z" fill="#fff"/></svg>`;
const GH = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

function head(title, page, description) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/img/work.webp">
<meta name="theme-color" content="#2563eb">
<link rel="icon" href="${rel(page, 'favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${rel(page, 'style.css')}">
</head>
<body>`;
}

function header(page) {
  const link = (label, to) => `<a href="${rel(page, to)}"${page === to || (to === 'guide.html' && page.startsWith('docs/')) ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="top"><div class="in">
<a class="brand" href="${rel(page, 'index.html')}">${LOGO}Clearsky</a>
<nav>${link('Get started', 'getting-started.html')}${link('Docs', 'guide.html')}<a class="gh" href="${REPO}">${GH}<span>GitHub</span></a></nav>
</div></header>`;
}

function footer(page) {
  return `<footer class="footer"><div class="in">
<span>Clearsky · MIT licence · runs on your machine, keeps nothing anywhere else</span>
<span><a href="${rel(page, 'getting-started.html')}">Get started</a><a href="${rel(page, 'guide.html')}">Guide</a><a href="${REPO}">GitHub</a></span>
</div></footer>
</body>
</html>
`;
}

function side(page, toc = []) {
  const groups = MENU.map(([name, items]) => `<h4>${name}</h4><ul>${items.map(([label, to]) =>
    `<li><a href="${rel(page, to)}"${to === page ? ' aria-current="page"' : ''}>${label}</a>${to === page && toc.length
      ? `<ul class="toc">${toc.map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`).join('');
  return `<aside class="side"><details><summary>Menu</summary>${groups}</details></aside>\n<script>if (matchMedia('(min-width: 901px)').matches) document.querySelector('.side details').open = true;</script>`;
}

// A page with the side menu: the hand-written getting started, and every Markdown page.
export function docPage({ page, title, description, body, toc, source }) {
  return `${head(`${title} · Clearsky`, page, description)}
${header(page)}
<div class="docs">
${side(page, toc)}
<article>
${body}
${source ? `<p class="edit">This page is <a href="${REPO}/blob/main/${source}">${source}</a> in the repo.</p>` : ''}
</article>
</div>
${footer(page)}`;
}

// Links in the Markdown point at repo files. Ones that are pages here go to the page; the rest to GitHub.
function relink(html, src, out) {
  const pages = new Map(PAGES.map((p) => [p.src, p.out]));
  return html.replace(/(href|src)="([^"]+)"/g, (m, attr, url) => {
    if (/^([a-z]+:|#|\/\/)/i.test(url)) return m;
    const [path, hash = ''] = url.split(/(?=#)/);
    const target = posix.normalize(posix.join(posix.dirname(src), path.replace(/\.html$/, '.md')));
    if (pages.has(target)) return `${attr}="${rel(out, pages.get(target))}${hash}"`;
    if (FILES.includes(posix.normalize(posix.join(posix.dirname(src), path)))) return m;
    let file = posix.normalize(posix.join(posix.dirname(src), path));
    if (file.endsWith('.html') && existsSync(join(root, target))) file = target; // render-docs made .md links .html
    const kind = existsSync(join(root, file)) && statSync(join(root, file)).isDirectory() ? 'tree' : 'blob';
    return `${attr}="${REPO}/${kind}/main/${file.replace(/\/$/, '')}${hash}"`;
  });
}

function markdownPage({ src, out, title, lead }) {
  const md = render(readFileSync(join(root, src), 'utf8'));
  let body = relink(md.body, src, out)
    .replace(/<(h[23]) id="([^"]+)">(.*?)<\/\1>/g, '<$1 id="$2">$3<a class="anchor" href="#$2" aria-label="Link to this section">#</a></$1>');
  if (title) body = body.replace(/<h1>.*?<\/h1>\n?<p>/, `<h1>${esc(title)}</h1>\n<p class="lead">${esc(lead)}</p>\n<p>`);
  const text = (md.body.match(/<p>(.*?)<\/p>/) || [, ''])[1].replace(/<[^>]+>/g, '');
  return docPage({ page: out, title: title || md.title, description: text.slice(0, 200), body, toc: md.toc, source: src });
}

// Hand-written pages in site/: <!--header-->, <!--footer--> and <!--side--> are filled in here.
function sitePage(file) {
  const page = file;
  const html = readFileSync(join(root, 'site', file), 'utf8');
  const [, title = 'Clearsky', description = ''] = html.match(/^<!--\s*title:\s*(.*?)\s*\|\s*(.*?)\s*-->/) || [];
  const body = html.replace(/^<!--.*?-->\n?/, '');
  if (body.includes('<!--side-->')) {
    const toc = [...body.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, h]) => ({ id, html: h }));
    return docPage({ page, title, description, body: body.replace('<!--side-->', ''), toc });
  }
  return `${head(title, page, description)}\n${header(page)}\n${body}\n${footer(page)}`;
}

export function build(out = join(root, '_site')) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'docs'), { recursive: true });
  for (const f of readdirSync(join(root, 'site'))) {
    if (f.endsWith('.html')) writeFileSync(join(out, f), sitePage(f));
    else cpSync(join(root, 'site', f), join(out, f), { recursive: true });
  }
  for (const p of PAGES) writeFileSync(join(out, p.out), markdownPage(p));
  for (const f of FILES) cpSync(join(root, f), join(out, f));
  writeFileSync(join(out, '.nojekyll'), '');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = build(process.argv[2] ? join(process.cwd(), process.argv[2]) : undefined);
  console.log(`site built in ${out}`);
}
