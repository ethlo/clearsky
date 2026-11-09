#!/usr/bin/env node
// Look for things that shouldn't be in a public repo before you publish it:
//
//   node scripts/leak-check.mjs [--history] [<folder>]
//
// It checks every file git tracks (with --history, every version of every file and every
// commit message too) for:
//   - your own words: company names, hosts, people, folders. They're read from
//     ~/.config/clearsky/private-words.txt (one per line, # for comments) or CLEARSKY_PRIVATE_WORDS
//     (comma-separated), so the list itself never goes in the repo;
//   - tokens that look real (GitHub, Slack, Grafana, Atlassian, private keys);
//   - email addresses that aren't example ones, and home folders other than placeholders.
// It prints file:line and what matched, and exits 1 if it found anything.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const history = args.includes('--history');
const repo = resolve(args.find((a) => !a.startsWith('--')) || '.');

const listFile = join(homedir(), '.config', 'clearsky', 'private-words.txt');
const words = [
  ...(existsSync(listFile) ? readFileSync(listFile, 'utf8').split(/\r?\n/) : []),
  ...String(process.env.CLEARSKY_PRIVATE_WORDS || '').split(','),
].map((w) => w.replace(/#.*/, '').trim()).filter((w) => w.length > 1);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CHECKS = [
  ...words.map((w) => ({ what: 'your word', re: new RegExp(esc(w), 'i') })),
  { what: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/, skip: /abcdefghij/ },
  { what: 'Slack token', re: /\bxox[abprs]-\d{6,}-[A-Za-z0-9-]{10,}/ },
  { what: 'Grafana token', re: /\bglsa_[A-Za-z0-9]{20,}/ },
  { what: 'Atlassian token', re: /\bATATT[A-Za-z0-9_-]{30,}/ },
  // A real key is a file of its own; one inside a string with \n in it is a test's stand-in.
  { what: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, skip: /\\n/ },
  // Not a link's user:password@host, and not a made-up domain.
  { what: 'email address', re: /(?<![:\w.%+-])[A-Za-z0-9._%+-]+@(?!(?:[\w-]+\.)*(?:example(?:\.(?:com|org|net))?|test|company\.com|users\.noreply\.github\.com|anthropic\.com)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}\b/,
    skip: /@(types|anthropic-ai|actions)\/|git@github\.com|noreply@/ },
  { what: 'home folder', re: /(?:\/home\/|\/Users\/|C:\\Users\\)(?!(?:me|you|u|user|alex|runner|<[^>]*>)\b)[A-Za-z][\w.-]+/ },
];

function scan(text, where, found) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const c of CHECKS) {
      const m = line.match(c.re);
      if (m && !(c.skip && c.skip.test(line))) found.push(`${where}:${i + 1}: ${c.what}: ${m[0].slice(0, 60)}`);
    }
  });
}

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 30 }).toString();
const binary = (buf) => buf.subarray(0, 8000).includes(0);
const found = [];
if (!history) {
  for (const f of git('ls-files', '-z').split('\0').filter(Boolean)) {
    let buf;
    try { buf = readFileSync(join(repo, f)); } catch { continue; }
    if (!binary(buf)) scan(buf.toString('utf8'), f, found);
  }
} else {
  // Every blob any commit ever had, once each, then every commit message.
  const seen = new Set();
  for (const line of git('rev-list', '--all', '--objects').split('\n')) {
    const [sha, ...path] = line.split(' ');
    if (!path.length || seen.has(sha)) continue;
    seen.add(sha);
    if (git('cat-file', '-t', sha).trim() !== 'blob') continue;
    const buf = execFileSync('git', ['-C', repo, 'cat-file', 'blob', sha], { maxBuffer: 1 << 30 });
    if (!binary(buf)) scan(buf.toString('utf8'), `${path.join(' ')}@${sha.slice(0, 8)}`, found);
  }
  for (const c of git('log', '--all', '--format=%H%x00%an <%ae>%x00%B%x01').split('\x01')) {
    const [sha, who, msg] = c.replace(/^\n/, '').split('\0');
    if (sha) scan(`${who}\n${msg || ''}`, `commit ${sha.slice(0, 8)}`, found);
  }
}
const uniq = [...new Set(found)];
for (const f of uniq) console.log(f);
if (!words.length) console.log(`(No words of your own to look for: put them in ${listFile}, one per line.)`);
console.log(uniq.length ? `\n${uniq.length} to look at.` : 'Nothing found.');
process.exitCode = uniq.length ? 1 : 0;
