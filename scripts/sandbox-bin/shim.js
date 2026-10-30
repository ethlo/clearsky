// Shared by the commands here: hand one to Clearsky (lib/broker.mjs) and pass its answer on,
// or run the real one, in the sandbox, when it only reads.
const { connect } = require('node:net');
const { spawnSync } = require('node:child_process');
const { statSync } = require('node:fs');
const { join, delimiter } = require('node:path');

function real(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || dir === __dirname) continue;
    try { if (statSync(join(dir, name)).isFile()) return join(dir, name); } catch {}
  }
  return null;
}

function runHere(name, argv) {
  const bin = real(name);
  if (!bin) { process.stderr.write(`${name}: not found\n`); process.exit(127); }
  const r = spawnSync(bin, argv, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function viaClearsky(tool, argv) {
  const path = process.env.CLEARSKY_BROKER_SOCKET;
  if (!path) { process.stderr.write(`${tool}: Clearsky isn't there to run this (CLEARSKY_BROKER_SOCKET is not set)\n`); process.exit(127); }
  const sock = connect(path, () => sock.write(`${JSON.stringify({ tool, argv, cwd: process.cwd(), key: process.env.CLEARSKY_BROKER_KEY })}\n`));
  let buf = '';
  sock.on('data', (d) => { buf += d; });
  sock.on('end', () => {
    let r;
    try { r = JSON.parse(buf); } catch { r = { code: 1, stderr: `${tool}: no answer from Clearsky\n` }; }
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exitCode = r.code;
  });
  sock.on('error', (e) => { process.stderr.write(`${tool}: Clearsky can't be reached (${e.message})\n`); process.exitCode = 127; });
}

module.exports = { runHere, viaClearsky };
