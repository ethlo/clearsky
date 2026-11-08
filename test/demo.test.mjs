// `clearsky try`: the demo starts on its own port with made-up data, says so on its pages,
// and Leave demo stops it and removes its throw-away home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUp } from '../lib/demo.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'clearsky.mjs');

test('clearsky try runs the demo, marks it, and Leave demo tidies up', async () => {
  const port = 17790 + Math.floor(Math.random() * 200);
  const env = { ...process.env };
  delete env.CLEARSKY_DEMO_HOME;
  const child = spawn(process.execPath, [bin, 'try', '--no-open', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    assert.ok(await waitUp(port, 20_000), 'demo is up');
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /<meta name="demo" content="1">/);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/settings`)).text(), /<meta name="demo" content="1">/);
    const home = out.match(/made-up data in (\S+);/)?.[1];
    assert.ok(home && existsSync(home), 'the demo has its own home folder');
    const csrf = page.match(/name="csrf" content="(\w+)"/)[1];
    const r = await fetch(`http://127.0.0.1:${port}/api/demo/stop`, { method: 'POST', headers: { 'x-clearsky-token': csrf, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);
    await new Promise((res) => child.once('exit', res));
    assert.ok(!existsSync(home), 'its home folder is gone');
  } finally { child.kill(); }
});
