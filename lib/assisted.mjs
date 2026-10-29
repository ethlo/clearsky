// Assisted mode's judge for shell commands: anything in your folders runs, except steps that
// are risky or reach outside: pushes and history rewrites, deletes, installs, deploys and
// publishes, Jira and GitHub changes, sudo/ssh and the like, and paths outside your folders
// (and /tmp). It reads the command the way a shell would well enough to see every command in
// it, including those inside $(…), loops and `if`s; anything it can't read asks.

import { resolve } from 'node:path';

// ---------------------------------------------------------------- reading the command

// { cmds: [{ words, redirs }], subs: [inner command text] }, or { error } when it can't tell.
export function parseShell(src) {
  const cmds = [], subs = [], heredocs = [];
  const fail = (error) => ({ error });
  let words = [], redirs = [], tok = '', has = false, redirNext = false;
  const endTok = () => {
    if (has) { if (redirNext) { redirs.push(tok); redirNext = false; } else words.push(tok); }
    tok = ''; has = false;
  };
  const endCmd = () => { endTok(); if (redirNext) throw new Error('dangling redirection'); if (words.length || redirs.length) cmds.push({ words, redirs }); words = []; redirs = []; };
  // The text of a $( … ) starting at i (just after the "("), and where it ends.
  const balanced = (i) => {
    let depth = 1, q = null;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"') j++; continue; }
      if (ch === "'" || ch === '"') q = ch;
      else if (ch === '\\') j++;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return [src.slice(i, j), j];
    }
    throw new Error('unbalanced');
  };
  const backtick = (i) => { const j = src.indexOf('`', i); if (j < 0) throw new Error('unbalanced'); return [src.slice(i, j), j]; };
  try {
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return fail('unclosed quote'); tok += src.slice(i + 1, j); has = true; i = j; continue; }
      if (ch === '"') {
        let j = i + 1;
        for (; j < src.length && src[j] !== '"'; j++) {
          if (src[j] === '\\') { tok += src[++j] ?? ''; continue; }
          if (src[j] === '$' && src[j + 1] === '(') { const [inner, end] = balanced(j + 2); subs.push(inner); tok += '$SUB'; j = end; continue; }
          if (src[j] === '`') { const [inner, end] = backtick(j + 1); subs.push(inner); tok += '$SUB'; j = end; continue; }
          tok += src[j];
        }
        if (j >= src.length) return fail('unclosed quote');
        has = true; i = j; continue;
      }
      if (ch === '\\') { if (src[i + 1] === '\n') { i++; continue; } tok += src[++i] ?? ''; has = true; continue; }
      if (ch === '$' && src[i + 1] === '(') { const [inner, end] = balanced(i + 2); subs.push(inner); tok += '$SUB'; has = true; i = end; continue; }
      if (ch === '`') { const [inner, end] = backtick(i + 1); subs.push(inner); tok += '$SUB'; has = true; i = end; continue; }
      if ((ch === '<' || ch === '>') && src[i + 1] === '(') { const [inner, end] = balanced(i + 2); subs.push(inner); tok += '$SUB'; has = true; i = end; continue; }
      if (ch === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; i--; continue; }
      if (ch === ';' || ch === '\n') {
        if (src[i + 1] === ';') i++;
        endCmd();
        // The body of a here-document starts on the next line: it's text for the command, up to its end word.
        if (ch === '\n' && heredocs.length) {
          for (const { word, tabs } of heredocs) {
            let k = i + 1, found = false;
            while (k <= src.length) {
              const e = src.indexOf('\n', k) < 0 ? src.length : src.indexOf('\n', k);
              const line = src.slice(k, e);
              if ((tabs ? line.replace(/^\t+/, '') : line) === word) { i = e; found = true; break; }
              k = e + 1;
            }
            if (!found) return fail('unfinished here-document');
          }
          heredocs.length = 0;
        }
        continue;
      }
      if (ch === '|') { if (src[i + 1] === '|') i++; else if (src[i + 1] === '&') i++; endCmd(); continue; }
      if (ch === '&') {
        if (src[i + 1] === '&') { i++; endCmd(); continue; }
        if (src[i + 1] === '>') { endTok(); i++; if (src[i + 1] === '>') i++; redirNext = true; continue; } // &> file
        return fail('runs in the background');
      }
      if (ch === '(' || ch === ')') { endCmd(); continue; }
      if (ch === '<' || ch === '>') {
        // A redirection; a lone file-descriptor number before it belongs to it.
        if (has && /^\d$/.test(tok)) { tok = ''; has = false; } else endTok();
        if (ch === '<' && src[i + 1] === '<') {
          if (src[i + 2] === '<') { i += 2; continue; } // <<< here-string: the next word is just text
          // <<WORD, <<'WORD', <<-WORD: a here-document, read when its line ends.
          let j = i + 2;
          const tabs = src[j] === '-';
          if (tabs) j++;
          while (src[j] === ' ') j++;
          const m = src.slice(j).match(/^(?:'([^']*)'|"([^"]*)"|\\?([\w.-]+))/);
          if (!m) return fail('here-document');
          heredocs.push({ word: m[1] ?? m[2] ?? m[3], tabs });
          i = j + m[0].length - 1;
          continue;
        }
        if (src[i + 1] === '&') { i++; while (/\d|-/.test(src[i + 1] || '')) i++; continue; } // >&2, 2>&1
        if (src[i + 1] === '>' || src[i + 1] === '|') i++;
        redirNext = true;
        continue;
      }
      if (ch === ' ' || ch === '\t') { endTok(); continue; }
      tok += ch; has = true;
    }
    endCmd();
    if (heredocs.length) return fail('unfinished here-document');
  } catch (e) { return fail(e.message === 'unbalanced' ? 'unbalanced $( or `' : e.message); }
  return { cmds, subs };
}

// ---------------------------------------------------------------- what asks

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', '!', '{', '}', 'time', 'break', 'continue', 'function']);
// Run another command: look at that one instead.
const WRAPPERS = { xargs: /^-[a-zA-Z]*[IdLnPs]$/, timeout: /^-/, nice: /^-n$/, env: /^-/, nohup: null, stdbuf: /^-/, command: null };
const ALWAYS_ASK = new Set(['sudo', 'su', 'doas', 'ssh', 'scp', 'sftp', 'rsync', 'rm', 'rmdir', 'shred', 'unlink', 'chmod', 'chown', 'chgrp', 'kill', 'pkill',
  'killall', 'dd', 'mkfs', 'mount', 'umount', 'shutdown', 'reboot', 'systemctl', 'crontab', 'eval', 'exec', 'source', '.', 'sh', 'bash', 'zsh', 'fish',
  'wget', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'az', 'apt', 'apt-get', 'dnf', 'yum', 'snap', 'brew', 'pip', 'pip3', 'pipx', 'gem',
  'npx', 'pnpx', 'bunx', 'open', 'xdg-open', 'git-filter-repo']);
const GIT_ASK = /^(push|reset|clean|rebase|filter-branch|gc|prune|update-ref|restore|merge|am|apply|revert|rm|mv|replace|notes|submodule|lfs)$/;
const PUBLISH = /^(deploy|publish|release(:[\w-]+)?|install:install-file|deploy:deploy-file)$/;

function commandAsks(name, args) {
  // Deleting scratch files under /tmp is routine; deleting anything else asks.
  if ((name === 'rm' || name === 'rmdir') && args.some((a) => !a.startsWith('-')) && args.filter((a) => !a.startsWith('-')).every((a) => /^\/tmp\/[^.]/.test(a) && !a.includes('/../'))) return null;
  if (ALWAYS_ASK.has(name)) return `${name}`;
  if (name === 'git') {
    let a = args;
    while (a[0] === '-C' || a[0] === '-c' || a[0] === '--no-pager') a = a.slice(a[0] === '--no-pager' ? 1 : 2);
    const sub = a[0];
    if (GIT_ASK.test(sub || '')) return `git ${sub}`;
    if (a.some((x) => /^(--force|--force-with-lease|-f|--hard|--delete|-D|-d|-M|-m)$/.test(x)) && /^(branch|tag|checkout|switch|worktree|stash|remote)$/.test(sub)) return `git ${sub} ${a.find((x) => x.startsWith('-'))}`;
    if (sub === 'checkout' && a.includes('--')) return 'git checkout --';
    if (sub === 'stash' && /^(drop|clear)$/.test(a[1] || '')) return 'git stash drop';
    if (sub === 'remote' && /^(add|remove|rm|set-url|rename)$/.test(a[1] || '')) return 'git remote change';
    if (sub === 'worktree' && /^(remove|prune|move)$/.test(a[1] || '')) return 'git worktree remove';
    if (sub === 'config' && !a.some((x) => /^(--get|--list|-l|--get-all|--show-origin)$/.test(x))) return 'git config';
    return null;
  }
  if (name === 'gh') {
    const [sub, verb] = args;
    if (sub === 'api') {
      const method = args[args.findIndex((x) => x === '-X' || x === '--method') + 1];
      const writes = args.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x) || /^--(field|raw-field|input)=/.test(x));
      return (method && args.some((x) => x === '-X' || x === '--method') && method.toUpperCase() !== 'GET') || writes ? 'gh api write' : null;
    }
    if (/^(pr|issue|run|repo|release|workflow|search|status|auth|browse)$/.test(sub || '') && /^(view|list|diff|checks|status|watch|download)?$/.test(verb || '') && !(sub === 'auth' && verb !== 'status')) return null;
    return `gh ${sub} ${verb || ''}`.trim();
  }
  if (name === 'acli') {
    const s = args.join(' ');
    return /\b(view|search|list|status)\b/.test(s) && !/\b(create|edit|transition|comment|link|assign|delete|update|archive|clone)\b/.test(s) ? null : 'acli write';
  }
  if (name === 'docker' || name === 'podman') {
    const sub = args.find((x) => !x.startsWith('-'));
    return /^(ps|logs|inspect|images|version|info|stats|top|port|compose)$/.test(sub || '') && !/\b(up|down|rm|run|exec|push|pull|build|kill|stop|restart|prune)\b/.test(args.join(' ')) ? null : `${name} ${sub || ''}`;
  }
  if (name === 'curl') return args.some((x) => /^(-X|--request|-d|--data.*|-F|--form|-T|--upload-file|-o|--output|-O)$/.test(x.split('=')[0])) ? 'curl write' : null;
  if (/^(npm|pnpm|yarn|bun)$/.test(name) && /^(install|i|add|remove|rm|uninstall|publish|update|upgrade|link|unlink|exec|dlx)$/.test(args[0] || '')) return `${name} ${args[0]}`;
  if (/^(cargo|go)$/.test(name) && /^(install|publish|get)$/.test(args[0] || '')) return `${name} ${args[0]}`;
  if (args.some((x) => PUBLISH.test(x))) return `${name} ${args.find((x) => PUBLISH.test(x))}`;
  if (name === 'find' && args.some((x) => /^-(delete|exec|execdir|ok|okdir)$/.test(x))) return 'find -delete/-exec';
  if (name === 'sed' && args.some((x) => /^(-i|--in-place)/.test(x))) return null; // editing files in place, inside your folders: like an edit
  return null;
}

const inside = (p, roots) => roots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`));
const SAFE_PATHS = ['/tmp', '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'];
// Build tools' caches, which commands often read (a dependency's sources or pom); not for writing to.
const READ_TOO = ['.m2', '.gradle', '.npm', '.cache'];

// Why Assisted would ask about this command (a short reason, no command text), or null if it may run.
// `ask`: extra command starts that should always ask (Settings → Copilot), like "mvn deploy".
export function assistedReason(cmd, { cwd, folders = [], home = '~', ask = [] } = {}, depth = 0) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'empty';
  if (cmd.length > 8000 || depth > 4) return 'too long';
  if (!cwd) return 'no folder';
  const parsed = parseShell(cmd);
  if (parsed.error) return `can't read it: ${parsed.error}`;
  const expand = (t) => t.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home);
  const roots = [cwd, ...folders.map(expand)].map((r) => resolve(r));
  let here = cwd;
  const readToo = READ_TOO.map((d) => resolve(home, d));
  const outside = (t, reading) => {
    if (!t || t.includes('$SUB')) return false;
    if (/^[a-z][\w+.-]*:\/\//i.test(t)) return false; // a URL
    const e = expand(t);
    if (!(e.startsWith('/') || e === '..' || e.startsWith('../') || e.includes('/../'))) return false;
    if (/^\$/.test(e)) return false;
    const p = resolve(here, e);
    return !(inside(p, roots) || SAFE_PATHS.some((s) => p === s || p.startsWith(`${s}/`)) || (reading && inside(p, readToo)));
  };
  const extra = ask.map((a) => a.trim().split(/\s+/)).filter((a) => a[0]);
  for (const sub of parsed.subs) { const r = assistedReason(sub, { cwd: here, folders, home, ask }, depth + 1); if (r) return r; }
  for (const { words, redirs } of parsed.cmds) {
    if (redirs.some(outside)) return 'writes outside your folders';
    let w = [...words];
    for (;;) {
      while (w.length && KEYWORDS.has(w[0])) w = w.slice(1);
      if (w[0] === 'for' || w[0] === 'select' || w[0] === 'in') { w = []; break; } // `for x in a b`: just a list
      while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { if (outside(w[0].split('=').slice(1).join('='))) return 'path outside your folders'; w = w.slice(1); }
      const wrap = w[0] && Object.hasOwn(WRAPPERS, w[0]) ? WRAPPERS[w[0]] : undefined;
      if (wrap === undefined) break;
      w = w.slice(1);
      while (w.length && (/^-/.test(w[0]) || (w[0] && /^\d+[smhd]?$/.test(w[0])) || (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])))) w = w.slice(1);
    }
    if (!w.length) continue;
    const [name, ...args] = w;
    if (extra.some((p) => p.every((x, i) => w[i] === x))) return 'on your always-ask list';
    // A script run by its path could do anything; the Maven and Gradle wrappers are just builds.
    if (name.includes('/') && !/(^|\/)(mvnw|gradlew)$/.test(name)) return 'runs a script';
    const why = commandAsks(name, args);
    if (why) return why;
    // A grep pattern isn't a path, even with slashes.
    const pathArgs = /^(grep|egrep|fgrep|rg|sed|awk|jq)$/.test(name) ? args.filter((a, i) => i !== args.findIndex((x) => !x.startsWith('-'))) : args;
    if (pathArgs.some((a) => outside(a.includes('=') && a.startsWith('-') ? a.split('=').slice(1).join('=') : a, !/^(cp|mv|tee|touch|mkdir|ln|install|sed)$/.test(name)))) return 'path outside your folders';
    if (name === 'cd') {
      const to = expand(args[0] || home);
      if (!to.includes('$SUB')) here = resolve(here, to);
      if (!inside(here, roots) && !SAFE_PATHS.some((s) => here === s || here.startsWith(`${s}/`))) return 'outside your folders';
    }
  }
  return null;
}
