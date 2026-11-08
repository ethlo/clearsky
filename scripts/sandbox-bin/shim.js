// Shared by the commands here: hand one to Clearsky (lib/broker.mjs) and pass its answer on.
const { connect } = require('node:net');

function viaClearsky(tool, argv) {
  const path = process.env.CLEARSKY_BROKER_SOCKET;
  if (!path) { process.stderr.write(`${tool}: Clearsky isn't there to run this (CLEARSKY_BROKER_SOCKET is not set)\n`); process.exit(127); }
  const sock = connect(path, () => sock.write(`${JSON.stringify({ tool, argv, cwd: process.cwd(), key: process.env.CLEARSKY_BROKER_KEY, java: process.env.JAVA_HOME })}\n`));
  // Answers are JSON lines: output as it comes ({o} / {e}), then the result ({code, stdout, stderr}).
  let buf = '', done = false;
  const take = (line) => {
    let r;
    try { r = JSON.parse(line); } catch { return; }
    if (r.o) process.stdout.write(r.o);
    if (r.e) process.stderr.write(r.e);
    if ('code' in r) {
      done = true;
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exitCode = r.code;
    }
  };
  sock.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(take); });
  sock.on('end', () => {
    if (buf) take(buf);
    if (!done) { process.stderr.write(`${tool}: no answer from Clearsky\n`); process.exitCode = 1; }
  });
  sock.on('error', (e) => { process.stderr.write(`${tool}: Clearsky can't be reached (${e.message})\n`); process.exitCode = 127; });
}

module.exports = { viaClearsky };
