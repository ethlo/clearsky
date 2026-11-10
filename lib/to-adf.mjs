// Text for a Jira description or comment, turned into Atlassian Document Format (ADF), the one
// format Jira Cloud shows with its formatting. Copilot writes Jira wiki markup (h3., *bold*,
// {{code}}) or Markdown; acli hands plain text to Jira as it is, so the markup shows as text.
// Clearsky's acli door runs this on --description and --body before acli sees them.

const ENTITIES = { '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(?:quot|#34|#39|apos|amp|lt|gt|nbsp);/g, (m) => ENTITIES[m]);

// Wiki markup has signs Markdown never uses; without them it's read as Markdown.
export const isWiki = (s) => /^\s*h[1-6]\.\s|\{\{.+?\}\}|^\s*\{(code|noformat|quote|panel)[:}]|^\s*\|\||^\s*bq\.\s|\[[^\]|\n]+\|https?:\/\/[^\]]+\]/m.test(s);

const text = (t, marks) => (t ? [{ type: 'text', text: t, ...(marks?.length ? { marks } : {}) }] : []);
const withMark = (nodes, mark) => nodes.map((n) => (n.type === 'text' && !(n.marks || []).some((m) => m.type === 'code') ? { ...n, marks: [...(n.marks || []), mark] } : n));
const link = (href) => ({ type: 'link', attrs: { href } });

// Inline formatting, as ADF text nodes with marks.
function inline(s, wiki) {
  const rules = wiki ? [
    [/\{\{(.+?)\}\}/, (m) => text(m[1], [{ type: 'code' }])],
    [/\[([^\]|\n]+)\|(https?:\/\/[^\]\s]+)\]/, (m) => withMark(inline(m[1], wiki), link(m[2]))],
    [/\[(https?:\/\/[^\]\s]+)\]/, (m) => text(m[1], [link(m[1])])],
    [/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/, (m) => withMark(inline(m[1], wiki), { type: 'strong' })],
    [/(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)/, (m) => withMark(inline(m[1], wiki), { type: 'em' })],
    [/(?<![\w-])-(?![\s-])([^-\n]+?)-(?![\w-])/, (m) => withMark(inline(m[1], wiki), { type: 'strike' })],
    [/(?<!\w)\+(?!\s)([^+\n]+?)\+(?!\w)/, (m) => withMark(inline(m[1], wiki), { type: 'underline' })],
    [/https?:\/\/[^\s<>)\]|]+/, (m) => text(m[0], [link(m[0])])],
  ] : [
    [/`([^`\n]+)`/, (m) => text(m[1], [{ type: 'code' }])],
    [/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/, (m) => withMark(inline(m[1], wiki), link(m[2]))],
    [/\*\*(?!\s)(.+?)\*\*/, (m) => withMark(inline(m[1], wiki), { type: 'strong' })],
    [/__(?!\s)(.+?)__/, (m) => withMark(inline(m[1], wiki), { type: 'strong' })],
    [/(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/, (m) => withMark(inline(m[1], wiki), { type: 'em' })],
    [/(?<!\w)_(?![\s_])([^_\n]+?)_(?!\w)/, (m) => withMark(inline(m[1], wiki), { type: 'em' })],
    [/~~(?!\s)(.+?)~~/, (m) => withMark(inline(m[1], wiki), { type: 'strike' })],
    [/<?(https?:\/\/[^\s<>)\]]+)>?/, (m) => text(m[1], [link(m[1])])],
  ];
  const out = [];
  let rest = s;
  while (rest) {
    let best = null;
    for (const [re, make] of rules) {
      const m = rest.match(re);
      if (m && (!best || m.index < best.m.index)) best = { m, make };
    }
    if (!best) { out.push(...text(rest)); break; }
    out.push(...text(rest.slice(0, best.m.index)), ...best.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  // Join neighbouring plain texts, so the document stays tidy.
  return out.reduce((a, n) => {
    const p = a[a.length - 1];
    if (p && p.type === 'text' && !p.marks && n.type === 'text' && !n.marks) p.text += n.text; else a.push({ ...n });
    return a;
  }, []);
}

const para = (lines, wiki) => {
  const content = [];
  lines.forEach((l, i) => {
    if (i) content.push(wiki ? { type: 'hardBreak' } : { type: 'text', text: ' ' });
    content.push(...inline(l.trim(), wiki));
  });
  return { type: 'paragraph', content: content.reduce((a, n) => {
    const p = a[a.length - 1];
    if (p && p.type === 'text' && !p.marks && n.type === 'text' && !n.marks) p.text += n.text; else a.push({ ...n });
    return a;
  }, []) };
};

// Nested lists from [{ depth, ordered, text }] items.
function lists(items, wiki) {
  const build = (start, depth) => {
    const ordered = items[start].ordered;
    const list = { type: ordered ? 'orderedList' : 'bulletList', content: [] };
    let i = start;
    while (i < items.length && items[i].depth >= depth) {
      if (items[i].depth > depth) {
        const [sub, next] = build(i, items[i].depth);
        const last = list.content[list.content.length - 1];
        if (last) last.content.push(sub); else list.content.push({ type: 'listItem', content: [{ type: 'paragraph', content: [] }, sub] });
        i = next;
        continue;
      }
      if (items[i].ordered !== ordered) break;
      list.content.push({ type: 'listItem', content: [para([items[i].text], wiki)] });
      i++;
    }
    return [list, i];
  };
  const out = [];
  let i = 0;
  while (i < items.length) { const [l, next] = build(i, items[i].depth); out.push(l); i = next; }
  return out;
}

function blocks(src, wiki) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paraLines = [], items = [];
  const flush = () => {
    if (paraLines.length) { out.push(para(paraLines, wiki)); paraLines = []; }
    if (items.length) { out.push(...lists(items, wiki)); items = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Code and other blocks that span lines.
    const wb = wiki && line.match(/^\s*\{(code|noformat|quote|panel)(?::([^}]*))?\}(.*)$/);
    const fence = !wiki && line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (wb || fence) {
      flush();
      const body = [];
      if (wb) {
        const end = new RegExp(`\\{${wb[1]}\\}`);
        let rest = wb[3];
        while (!end.test(rest) && i + 1 < lines.length) { body.push(rest); rest = lines[++i]; }
        body.push(rest.split(end)[0]);
        const content = body.join('\n').replace(/^\n+|\n+$/g, '');
        if (wb[1] === 'code' || wb[1] === 'noformat') {
          const lang = wb[1] === 'code' && wb[2] && !wb[2].includes('=') ? wb[2] : null;
          out.push({ type: 'codeBlock', ...(lang ? { attrs: { language: lang } } : {}), content: text(content) });
        } else if (wb[1] === 'quote') out.push({ type: 'blockquote', content: blocks(content, wiki).filter((b) => b.type === 'paragraph' || /List$/.test(b.type)) });
        else out.push({ type: 'panel', attrs: { panelType: 'info' }, content: blocks(content, wiki).filter((b) => b.type === 'paragraph' || /List$|^heading$/.test(b.type)) });
      } else {
        while (i + 1 < lines.length && !lines[i + 1].trim().startsWith(fence[1])) body.push(lines[++i]);
        i++;
        out.push({ type: 'codeBlock', ...(fence[2] ? { attrs: { language: fence[2] } } : {}), content: text(body.join('\n')) });
      }
      continue;
    }
    const h = wiki ? line.match(/^\s*h([1-6])\.\s+(.*)$/) : line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); out.push({ type: 'heading', attrs: { level: wiki ? Number(h[1]) : h[1].length }, content: inline(h[2], wiki) }); continue; }
    if (wiki ? /^\s*-{4,}\s*$/.test(line) : /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ type: 'rule' }); continue; }
    const q = wiki ? line.match(/^\s*bq\.\s+(.*)$/) : line.match(/^\s{0,3}>\s?(.*)$/);
    if (q) {
      flush();
      const ql = [q[1]];
      while (!wiki && i + 1 < lines.length && /^\s{0,3}>/.test(lines[i + 1])) ql.push(lines[++i].replace(/^\s{0,3}>\s?/, ''));
      out.push({ type: 'blockquote', content: blocks(ql.join('\n'), wiki).filter((b) => b.type === 'paragraph' || /List$/.test(b.type)) });
      continue;
    }
    const li = wiki ? line.match(/^\s*([*#]+|-)\s+(.*)$/) : line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (paraLines.length) { out.push(para(paraLines, wiki)); paraLines = []; }
      if (wiki) items.push({ depth: li[1] === '-' ? 1 : li[1].length, ordered: li[1].endsWith('#'), text: li[2] });
      else items.push({ depth: 1 + Math.floor(li[1].replace(/\t/g, '    ').length / 2), ordered: /\d/.test(li[2]), text: li[3] });
      continue;
    }
    // Tables: wiki ||head|| and |cell|, or Markdown | a | b | with a |---| line under the head.
    if (line.trim().startsWith('|')) {
      flush();
      const rows = [];
      i--;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        const l = lines[++i].trim();
        if (!wiki && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(l)) { if (rows.length) rows[rows.length - 1].head = true; continue; }
        const cells = [];
        if (wiki) {
          const parts = l.replace(/\|+\s*$/, '').split(/(\|\|?)/).filter((x) => x !== '');
          let tag = 'tableCell';
          for (const c of parts) { if (c === '||') tag = 'tableHeader'; else if (c === '|') tag = 'tableCell'; else cells.push({ tag, text: c.trim() }); }
        } else for (const c of l.replace(/^\||\|$/g, '').split('|')) cells.push({ tag: 'tableCell', text: c.trim() });
        rows.push({ cells });
      }
      out.push({ type: 'table', content: rows.map((r) => ({ type: 'tableRow', content: r.cells.map((c) => ({ type: r.head ? 'tableHeader' : c.tag, content: [para([c.text], wiki)] })) })) });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (items.length) { out.push(...lists(items, wiki)); items = []; }
    paraLines.push(line);
  }
  flush();
  return out;
}

// The text as an ADF document. Text that's already ADF JSON is left to the caller.
export function toAdf(src) {
  const s = decode(String(src ?? ''));
  return { type: 'doc', version: 1, content: blocks(s, isWiki(s)) };
}

const looksAdf = (s) => /^\s*\{[\s\S]*"type"\s*:\s*"doc"/.test(s);
const hasMarkup = (s) => /\n|&(?:quot|#34|#39|amp|lt|gt);|\{\{|\*\*|`|^\s*(h[1-6]\.|#{1,6}\s|[-*#]\s)|\[[^\]]+\]\(|\[[^\]|]+\|/m.test(s);

// Long and short names of acli's text flags: create/edit take --description(-file), comments
// --body(-file) (-d, -b, -F for short).
const FLAGS = { '-d': '--description', '-b': '--body', '-F': '--body-file' };
const flagOf = (a) => {
  const m = a.match(/^(--(?:description|body)(?:-file)?|-[dbF])(?:=(.*))?$/s);
  if (!m) return null;
  const name = FLAGS[m[1]] || m[1];
  return { field: name.replace(/^--|-file$/g, ''), file: name.endsWith('-file'), value: m[2] };
};
const isCommentUpdate = (argv) => { const i = argv.indexOf('comment'); return i >= 0 && argv[i + 1] === 'update'; };

// Text that's worth turning into ADF: markup, or more than one line.
const wantsAdf = (s) => typeof s === 'string' && !looksAdf(s) && hasMarkup(s);

// acli's arguments with --description/--body text (or --description-file/--body-file, read from
// `cwd`) given to it as ADF, so Jira shows its formatting. A short plain line is left as it is.
// `comment update` only takes ADF from a file (--body-adf), and a --from-json definition is
// rewritten with its description as ADF: both go through `writeFile(name, text)`, which returns
// the path of a file only acli reads. Without it, those are left as they are.
export function adfArgs(argv, readFile, cwd, writeFile) {
  const out = [];
  const read = (f) => readFile(f.startsWith('/') || !cwd ? f : `${cwd}/${f}`);
  const update = isCommentUpdate(argv);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-json' && argv[i + 1] !== undefined && writeFile) {
      const f = argv[++i];
      try {
        const def = JSON.parse(read(f));
        if (def && wantsAdf(def.description)) { def.description = toAdf(def.description); out.push(a, writeFile('workitem.json', JSON.stringify(def))); continue; }
      } catch { /* left to acli */ }
      out.push(a, f);
      continue;
    }
    const flag = flagOf(a);
    if (!flag) { out.push(a); continue; }
    const inline = flag.value !== undefined;
    const val = inline ? flag.value : argv[i + 1];
    if (val === undefined) { out.push(a); continue; }
    if (!inline) i++;
    let textValue = val;
    if (flag.file) {
      try { textValue = read(val); } catch { out.push(a, val); continue; }
    }
    if (looksAdf(textValue) || (!flag.file && !hasMarkup(textValue))) {
      // ADF for a comment update goes in its own flag, from a file.
      if (update && flag.field === 'body' && looksAdf(textValue) && writeFile) { out.push('--body-adf', writeFile('body.json', textValue)); continue; }
      out.push(a, val);
      continue;
    }
    const doc = JSON.stringify(toAdf(textValue));
    if (update && flag.field === 'body') {
      if (writeFile) out.push('--body-adf', writeFile('body.json', doc)); else out.push(a, val);
      continue;
    }
    out.push(`--${flag.field}`, doc);
  }
  return out;
}

// ADF that holds only plain paragraphs: what Jira keeps when it's sent wiki markup or Markdown
// as text. Their text, one paragraph per blank-line-separated block; null for anything richer.
export function plainAdfText(doc) {
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
  const paras = [];
  for (const b of doc.content) {
    if (b.type !== 'paragraph') return null;
    let t = '';
    for (const n of b.content || []) {
      if (n.type === 'hardBreak') t += '\n';
      else if (n.type === 'text' && !(n.marks || []).some((m) => m.type !== 'link')) t += n.text || '';
      else return null;
    }
    paras.push(t);
  }
  return paras.join('\n\n');
}

// Wiki markup or Markdown signs that only show as text when Jira takes them literally.
export const hasLiteralMarkup = (s) => isWiki(s) || /^\s*(#{1,6}\s|```)|\*\*[^*\n]+\*\*|^\s*[-*]\s.+\n\s*[-*]\s/m.test(s);
