import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acliAllowed, approvals, serveBroker } from '../lib/acli-broker.mjs';

test('sandboxed acli: reads run, changes only when allowed or approved once', () => {
  let t = 0;
  const ok = approvals(1000, () => t);
  assert.equal(acliAllowed(['jira', 'workitem', 'view', 'ABC-1', '--json'], { approved: ok }), 'read');
  assert.equal(acliAllowed(['jira', 'workitem', 'transition', '--key', 'ABC-1', '--status', 'Done'], { approved: ok }), null);
  assert.equal(acliAllowed(['jira', 'workitem', 'transition', '--key', 'ABC-1'], { allow: ['acli jira workitem transition'] }), 'allowed');
  ok.add('cd /x && acli jira workitem comment create --key ABC-1 --body "Fixed"');
  assert.equal(acliAllowed(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-2', '--body', 'Fixed'], { approved: ok }), null);
  assert.equal(acliAllowed(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1', '--body', 'Fixed'], { approved: ok }), 'approved');
  assert.equal(acliAllowed(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1', '--body', 'Fixed'], { approved: ok }), null);
  ok.add('acli jira workitem edit --key ABC-3'); t = 2000;
  assert.equal(acliAllowed(['jira', 'workitem', 'edit', '--key', 'ABC-3'], { approved: ok }), null);
});

test('the sandbox\'s acli runs the real one through Clearsky', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'broker-')), 's', 'acli.sock');
  const seen = [];
  const run = (bin, argv, opts, cb) => { seen.push(argv); cb(null, `out ${argv.join(' ')}\n`, ''); };
  const server = serveBroker({ path, run, approved: approvals() });
  await new Promise((r) => server.once('listening', r));
  const shim = fileURLToPath(new URL('../scripts/sandbox-bin/acli', import.meta.url));
  const go = (args) => new Promise((r) => execFile(process.execPath, [shim, ...args], { env: { ...process.env, CLEARSKY_ACLI_SOCKET: path } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    assert.deepEqual(await go(['jira', 'workitem', 'view', 'ABC-1']), { code: 0, out: 'out jira workitem view ABC-1\n', err: '' });
    const no = await go(['jira', 'workitem', 'delete', '--key', 'ABC-1']);
    assert.equal(no.code, 1); assert.match(no.err, /wasn't allowed/);
    assert.equal(seen.length, 1);
  } finally { server.close(); }
});
