#!/usr/bin/env node
// Turn each plugin folder in plugins/ into a git repo of its own, ready to push:
//
//   node scripts/split-plugins.mjs [--out <folder>] [<name>…]
//
// For each plugin in plugins/catalog.json (or the ones named): copies plugins/<folder> to
// <out>/<folder> (default: next to this checkout), makes it a git repo with one commit, tags it
// v<version> (the tag the catalog pins), and prints the commands that create the repo on GitHub
// and push it. A plugin whose repo is cloned there already gets a new release instead: the
// folder's code as a commit on top, tagged, with the push command. It never pushes or creates anything online itself; it uses your own git name.
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCatalog, bundledDir, readManifest, parseSpec } from '../lib/plugins.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const o = args.indexOf('--out');
const out = resolve(o > -1 ? args[o + 1] : join(here, '..'));
const names = args.filter((a, i) => !a.startsWith('--') && (o < 0 || i !== o + 1));
const catalog = readCatalog().filter((c) => !names.length || names.includes(c.name) || c.aka.some((a) => names.includes(a)) || names.includes(c.folder));
if (!catalog.length) { console.error('No such plugin in plugins/catalog.json.'); process.exit(2); }

const next = [];
for (const c of catalog) {
  const src = bundledDir(c.name);
  if (!src) { console.log(`${c.name}: no folder here any more, skipped`); continue; }
  const m = readManifest(src);
  const spec = parseSpec(c.from);
  const tag = `v${m.version}`;
  if (spec.ref !== tag) console.log(`${c.name}: careful, the catalog pins ${spec.ref} but the folder is version ${m.version}`);
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  if (pkg.version !== m.version) console.log(`${c.name}: careful, package.json says ${pkg.version} and clearsky-plugin.json ${m.version}`);
  const dest = join(out, c.folder || `clearsky-${c.name}`);
  const copy = () => cpSync(src, dest, { recursive: true, filter: (p) => !/(^|[\\/])(node_modules|\.clearsky)$/.test(p) });
  const git = (...a) => execFileSync('git', ['-C', dest, ...a], { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
  // Its repo, cloned here already: a new release of it, the folder's code as one commit and the tag.
  if (existsSync(join(dest, '.git'))) {
    if (git('tag', '-l', tag)) { console.log(`${c.name}: ${dest} already has ${tag}, skipped`); continue; }
    if (git('status', '--porcelain')) { console.log(`${c.name}: ${dest} has changes of its own, skipped`); continue; }
    git('rm', '-rq', '--ignore-unmatch', '.');
    copy();
    git('add', '-A');
    if (git('status', '--porcelain')) git('commit', '-q', '-m', `${m.label} ${m.version}`);
    git('tag', tag);
    console.log(`${c.name}: ${dest} (${tag}, on top of its repo)`);
    next.push(`cd ${dest} && git push origin HEAD ${tag}`);
    continue;
  }
  if (existsSync(dest)) { console.log(`${c.name}: ${dest} is already there and isn't a git repo, skipped`); continue; }
  copy();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', `${m.label} ${m.version}`);
  git('tag', tag);
  const slug = spec.url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  console.log(`${c.name}: ${dest} (${tag})`);
  next.push(`cd ${dest} && gh repo create ${slug} --public --source . --push && git push origin ${tag}`);
}
if (next.length) {
  console.log('\nTo put them on GitHub (check each one first):\n');
  for (const n of next) console.log(`  ${n}`);
  console.log('\nThen `clearsky add <name>` takes each from its repo at the pinned tag. Anyone who added one from');
  console.log('its folder here gets "Move to its repo" in Settings → Plugins. Once nobody needs the folders,');
  console.log('delete plugins/clearsky-* here and keep plugins/catalog.json.');
}
