// Whether a shell command Copilot wants to run only looks at things, so Clearsky can let it
// run without asking (Settings → Copilot). Deliberately narrow: a known reading command in
// every part of a pipeline or list, no writing redirections or command substitution, and
// every path inside the chat's folder or the folders Copilot may use. Anything else asks.

import { resolve } from 'node:path';

const PLAIN = new Set(['cd', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'nl',
  'file', 'stat', 'du', 'tree', 'which', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink', 'test', 'true', 'diff', 'jq', 'column']);
const GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'blame', 'describe', 'shortlog', 'merge-base',
  'cat-file', 'reflog', 'whatchanged', 'name-rev', 'rev-list']);
const FIND_BAD = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

// Split into simple commands on ; && || | and newlines, keeping quoted text whole.
// Returns null for anything this doesn't understand.
export function splitCommands(cmd) {
  const parts = [];
  let cur = [], tok = '', q = null, has = false;
  const endTok = () => { if (has) cur.push(tok); tok = ''; has = false; };
  const endCmd = () => { endTok(); if (cur.length) parts.push(cur); cur = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) tok += cmd[++i];
      else { if (q === '"' && (ch === '`' || (ch === '$' && cmd[i + 1] === '('))) return null; tok += ch; }
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { tok += cmd[++i]; has = true; continue; }
    if (ch === '`' || (ch === '$' && cmd[i + 1] === '(') || ((ch === '<' || ch === '>') && cmd[i + 1] === '(')) return null;
    if (ch === '&') { if (cmd[i + 1] !== '&') return null; i++; endCmd(); continue; } // a lone & runs it in the background
    if (ch === '|') { if (cmd[i + 1] === '|') i++; endCmd(); continue; }
    if (ch === ';' || ch === '\n') { endCmd(); continue; }
    if (ch === ' ' || ch === '\t') { endTok(); continue; }
    if (ch === '>' || ch === '<') {
      // Only throwing output away: 2>/dev/null, >/dev/null, 2>&1.
      const rest = cmd.slice(i);
      const m = rest.match(/^>&[12]\b|^>\s*\/dev\/null\b/);
      if (ch === '>' && m && (!has || /^[12]$/.test(tok))) { tok = ''; has = false; i += m[0].length - 1; continue; }
      return null;
    }
    tok += ch; has = true;
  }
  if (q) return null;
  endCmd();
  return parts;
}

// Whether every file an edit touches is in the chat's folder or your folders.
export function editInside(toolCall = {}, { cwd, folders = [], home } = {}) {
  const input = toolCall.rawInput || {};
  const paths = [...(toolCall.locations || []).map((l) => l?.path), input.path, input.file_path, input.filePath].filter((p) => typeof p === 'string' && p);
  if (!paths.length || !cwd) return false;
  const roots = [cwd, ...folders].map((f) => resolve(f.replace(/^~(?=\/|$)/, home || '~')));
  return paths.every((p) => inside(resolve(cwd, p.replace(/^~(?=\/|$)/, home || '~')), roots));
}

const inside = (p, roots) => roots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`));

const startsWith = (words, prefix) => prefix.every((w, i) => words[i] === w);

// isReadOnly(cmd, …) with `allow`: also let these command prefixes through (Assisted mode).
// `timeout 60 grep …`, `nice grep …`, `nohup …`: judge the command they run.
function unwrap(words) {
  for (;;) {
    if (words[0] === 'timeout') {
      let i = 1;
      while (/^-/.test(words[i] || '')) i += /^(-s|-k|--signal|--kill-after)$/.test(words[i]) ? 2 : 1;
      words = words.slice(i + 1);
    } else if (words[0] === 'nice') words = words.slice(words[1] === '-n' ? 3 : /^-\d+$/.test(words[1] || '') ? 2 : 1);
    else if (words[0] === 'nohup') words = words.slice(1);
    else return words;
  }
}

export function isReadOnly(cmd, { cwd, folders = [], home, allow = [], readable = null } = {}) {
  const prefixes = allow.map((a) => a.trim().split(/\s+/)).filter((a) => a[0]);
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 4000 || !cwd) return false;
  const parts = splitCommands(cmd);
  if (!parts?.length) return false;
  const roots = [cwd, ...folders].map((f) => resolve(f.replace(/^~(?=\/|$)/, home || '~')));
  let here = cwd;
  const pathOk = (t) => {
    if (t === '/dev/null' || t === '-') return true;
    if (!(t.startsWith('/') || t.startsWith('~') || t.includes('/') || t === '..')) return true;
    if (t.startsWith('~') && !/^~(\/|$)/.test(t)) return false;
    const p = resolve(here, t.replace(/^~(?=\/|$)/, home || '~'));
    return inside(p, roots) || !!readable?.(p);
  };
  for (let words of parts) {
    words = unwrap(words);
    let [name, ...args] = words;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return false; // VAR=x cmd
    const pre = prefixes.find((p) => startsWith(words, p));
    if (pre) {
      args = words.slice(pre.length);
      if (args.some((a) => /^(--force|--force-with-lease|-f)$/.test(a)) && name === 'git') return false;
      // Publishing never runs unasked, whatever the tool.
      if (args.some((a) => /^(deploy|publish|release(:[\w-]+)?)$/.test(a))) return false;
    } else if (name === 'git') {
      while (args[0] === '-C' || args[0] === '--no-pager' || args[0] === '-c') {
        if (args[0] === '-c') return false;
        if (args[0] === '-C') { if (!pathOk(args[1] || '')) return false; args = args.slice(2); } else args = args.slice(1);
      }
      const sub = args[0];
      const listOnly = (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'stash' || sub === 'worktree') &&
        args.slice(1).every((a) => /^(-a|-r|-v|-vv|--all|--list|-l|--show-current|--contains|--merged|--no-merged|list|show)$/.test(a) || (!a.startsWith('-') && sub === 'branch' && args.includes('--contains')));
      if (!GIT.has(sub) && !listOnly) return false;
      if (args.some((a) => /^--(output|ext-diff)/.test(a))) return false;
    } else if (name === 'sed') {
      // Printing only: sed -n with line-number or /pattern/ p scripts.
      if (!args.includes('-n') || args.some((a) => /^(-i|--in-place|-e|-f|--expression|--file)/.test(a))) return false;
      const scripts = args.filter((a) => !a.startsWith('-'));
      if (!scripts.length || !/^(\s*([0-9]+|\$|\/[^/]*\/)(,([0-9]+|\$|\/[^/]*\/))?p\s*;?)+$/.test(scripts[0])) return false;
      args = scripts.slice(1);
    } else if (name === 'find') {
      if (args.some((a) => FIND_BAD.test(a))) return false;
    } else if (name === 'sort' || name === 'tree') {
      if (args.some((a) => /^(-o|--output)/.test(a))) return false;
    } else if (/^(grep|egrep|fgrep|rg)$/.test(name)) {
      // The pattern isn't a path, even with slashes in it.
      if (args.some((a) => /^(-f|--file|--pre)/.test(a))) return false;
      const e = args.findIndex((a) => a === '-e' || a === '--regexp');
      if (e >= 0) args = [...args.slice(0, e), ...args.slice(e + 2)];
      else { const p = args.findIndex((a) => !a.startsWith('-')); if (p >= 0) args = [...args.slice(0, p), ...args.slice(p + 1)]; }
    } else if (!PLAIN.has(name)) return false;
    if (!args.every(pathOk)) return false;
    if (name === 'cd') {
      const to = args[0] || home || '~';
      here = resolve(here, to.replace(/^~(?=\/|$)/, home || '~'));
    }
  }
  return true;
}
