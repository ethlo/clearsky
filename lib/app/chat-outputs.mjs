// A chat's Outputs: the files it wrote or you attached, read back for the side panel, a file's
// diff, and the pull requests of the chat's branch.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { logWrite, readWrites } from '../agent-log.mjs';
import { buildMap } from '../map.mjs';
import { SAFE_GIT, SAFE_DIFF, localPrograms } from '../safe-git.mjs';
import { agentLogFile, agentFilesFile, config } from './config.mjs';
import { execFileP, ghCliToken, jiraModule } from './services.mjs';
import { copilotTmp, copilotHome } from './chat-env.mjs';
import { sandboxRun } from './chat-builds.mjs';

export const safeName = (n) => String(n).split(/[\\/]/).pop().replace(/[^\w.@+-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
const stagingDir = () => join(copilotTmp(), 'attachments');
export function isStaged(pth) {
  try { const real = realpathSync(pth); return real.startsWith(`${realpathSync(stagingDir())}/`) && statSync(real).isFile(); } catch { return false; }
}
const sessionDir = (id) => join(copilotHome(), 'session-state', id);
// An attachment is copied into the chat's own Copilot folder (files/), which outlives the scratch folder.
export function keepAttachment(id, pth) {
  if (!id || !/^[\w-]{8,64}$/.test(id)) return;
  try {
    const dir = join(sessionDir(id), 'files');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let dest = join(dir, basename(pth));
    for (let i = 2; existsSync(dest) && i < 100; i++) dest = join(dir, basename(pth).replace(/(\.[^.]*)?$/, `-${i}$1`));
    writeFileSync(dest, readFileSync(pth), { mode: 0o600 });
    logWrite(agentFilesFile, { where: 'file', what: dest, kind: 'attached', from: pth, chats: [{ id }], decided: 'done' });
  } catch { /* the message still names the staged file */ }
}
function listDir(dir, max = 200) {
  const out = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}
const TEXT_EXT = /(\.(txt|log|md|markdown|json|ya?ml|xml|csv|tsv|java|kt|kts|groovy|gradle|scala|js|mjs|cjs|jsx|ts|tsx|py|go|rs|rb|php|c|h|cpp|hpp|cs|swift|sql|sh|bash|zsh|ps1|properties|toml|ini|conf|cfg|env|diff|patch|html?|css|scss|vue|svelte|graphql|proto|tf|hcl)|\/(Dockerfile|Makefile|Jenkinsfile|\.gitignore))$/i;
const fileType = (p) => (/\.pdf$/i.test(p) ? 'application/pdf' : /\.png$/i.test(p) ? 'image/png' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : TEXT_EXT.test(p) ? 'text/plain' : 'application/octet-stream');
// The files that count as this chat's: its own Copilot folders, and what it wrote or you attached.
function chatFilePaths(id) {
  const own = ['files', 'research'].flatMap((d) => listDir(join(sessionDir(id), d)).map((p) => ({ path: p, kind: d === 'research' ? 'research' : 'file' })));
  const logged = readWrites(agentFilesFile, { chat: id, limit: 2000 }).reverse();
  const by = new Map(own.map((f) => [f.path, f]));
  for (const e of logged) {
    if (e.kind === 'deleted') { by.delete(e.what); continue; }
    by.set(e.what, { path: e.what, kind: e.kind, at: e.at });
  }
  return [...by.values()];
}
export function chatFile(id, pth) {
  const f = chatFilePaths(id).find((x) => x.path === pth);
  if (!f) return null;
  try {
    const st = statSync(pth);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) return null;
    return { name: basename(pth), type: fileType(pth), data: readFileSync(pth) };
  } catch { return null; }
}
// What changed in a file on its branch: against where the branch left the default branch
// (origin/HEAD, main or master), uncommitted changes included. Empty outside a git clone.
// The folder is the chat's to write, so git runs in the chat's sandbox while it is up, and
// otherwise never in a repo whose own settings name a program to run (lib/safe-git.mjs).
export async function fileDiff(pth, c = null) {
  const dir = dirname(pth);
  const run = c?.agent?.inSandbox && !c.agent.closed ? sandboxRun(c) : execFileP;
  if (run === execFileP && (await localPrograms(dir)).length) return { diff: '', base: null, unsafe: true };
  const git = (...a) => run('git', ['-C', dir, ...SAFE_GIT, ...a], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => String(r.stdout).trim(), () => '');
  if (!await git('rev-parse', '--is-inside-work-tree')) return { diff: '', base: null };
  let base = '';
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) if ((base = await git('merge-base', 'HEAD', ref))) break;
  const diff = await git('diff', '--no-color', ...SAFE_DIFF, base || 'HEAD', '--', basename(pth));
  const untracked = !diff && await git('ls-files', '--others', '--exclude-standard', '--', basename(pth));
  return { diff: diff.slice(0, 2_000_000), base: base ? base.slice(0, 8) : 'HEAD', new: !!untracked };
}
// The PRs of branches a chat pushed, looked up as you (read only), kept 5 minutes.
const branchPrCache = new Map();
async function branchPrs(repo, branch) {
  const k = `${repo}:${branch}`, hit = branchPrCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 6e4) return hit.prs;
  let prs = [];
  try {
    config.github.token ||= await ghCliToken();
    const r = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`, { headers: { Authorization: `Bearer ${config.github.token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) prs = (await r.json()).map((p) => p.number);
  } catch { /* none known */ }
  branchPrCache.set(k, { at: Date.now(), prs });
  return prs;
}
export async function chatOutputs(id) {
  const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const files = chatFilePaths(id).map((f) => {
    let st = null;
    try { st = statSync(f.path); } catch {}
    return { path: f.path, shown: tilde(f.path), name: basename(f.path), kind: f.kind, at: f.at || (st ? new Date(st.mtimeMs).toISOString() : null), size: st?.size ?? null, exists: !!st, type: st ? fileType(f.path) : null };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
  const [map] = buildMap(readWrites(agentLogFile, { chat: id, limit: 3000 }));
  const jira = (jiraModule.site || '').replace(/\/$/, '');
  const links = [];
  for (const n of map?.nodes || []) {
    const acts = [...new Set(n.acts.map((a) => a.act))];
    const last = n.acts.at(-1)?.at || null;
    if (n.kind === 'repo') {
      const prs = new Set(n.prs);
      for (const b of n.branches) for (const p of await branchPrs(n.key, b)) prs.add(p);
      for (const p of prs) links.push({ kind: 'pr', label: `${n.key}#${p}`, url: `https://github.com/${n.key}/pull/${p}`, pr: `${n.key}#${p}`, acts: n.acts.filter((a) => a.pr === p).map((a) => a.act), at: last });
      for (const b of n.branches) links.push({ kind: 'branch', label: `${n.key} · ${b}`, url: `https://github.com/${n.key}/tree/${encodeURIComponent(b).replace(/%2F/g, '/')}`, acts: acts.filter((a) => /push|branch|tests|build|review/.test(a)), at: last });
      if (n.acts.some((a) => a.act === 'started CI')) links.push({ kind: 'ci', label: `${n.key} · CI runs`, url: `https://github.com/${n.key}/actions`, acts: ['started CI'], at: last });
      if (!prs.size && !n.branches.length) links.push({ kind: 'repo', label: n.key, url: `https://github.com/${n.key}`, acts, at: last });
    } else if (n.kind === 'ticket') links.push({ kind: 'ticket', label: n.key, url: jira ? `${jira}/browse/${n.key}` : null, issue: n.key, acts, at: last });
    else if (n.kind === 'project') links.push({ kind: 'project', label: `Jira ${n.key}`, url: jira ? `${jira}/browse/${n.key}` : null, acts, at: last });
    else if (n.kind === 'env') links.push({ kind: 'env', label: `Grafana ${n.key}`, url: null, acts, at: last });
  }
  return { files, links };
}
