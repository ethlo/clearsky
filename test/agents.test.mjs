import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentName, AGENTS, CLAUDE_MODES, claudeModel, findBin } from '../lib/agents.mjs';
import { AcpAgent } from '../lib/acp.mjs';
import { srtSettings } from '../lib/sandbox.mjs';
import { checks } from '../lib/doctor.mjs';
import { validate } from '../lib/settings.mjs';
import { parsePack } from '../lib/team.mjs';

test('the agent: as set, else Copilot when installed, else Claude Code', () => {
  const only = (...names) => (n) => names.includes(n);
  assert.equal(agentName({ CLEARSKY_AGENT: 'Claude' }, { has: only('copilot') }), 'claude');
  assert.equal(agentName({}, { has: only('copilot', 'claude') }), 'copilot', 'nothing changes for people with Copilot');
  assert.equal(agentName({}, { has: only('claude') }), 'claude');
  assert.equal(agentName({}, { has: only() }), 'copilot');
  assert.equal(agentName({ CLEARSKY_AGENT: 'codex' }, { has: only('claude') }), 'claude', 'an unknown value counts as unset');
});

test('Copilot keeps its flags; Claude Code gets a session mode and a model in its environment', () => {
  const cp = AGENTS.copilot, cc = AGENTS.claude;
  assert.deepEqual(cp.acp(['--model', 'x']), ['--model', 'x', '--acp']);
  assert.ok(cp.args({ permission: 'read', model: 'gpt-5' }).includes('--model'));
  assert.equal(cp.sessionMode('ask'), null);
  assert.deepEqual(cc.args({ permission: 'full', model: 'opus', folders: ['/tmp'] }), []);
  assert.deepEqual(cc.acp([]), []);
  assert.equal(cc.sessionMode('ask'), 'default');
  assert.equal(cc.sessionMode('sandboxed'), 'bypassPermissions', 'the sandbox is the fence, as with Copilot');
  assert.equal(cc.sessionMode('read'), 'plan');
  assert.equal(cc.sessionMode('nope'), 'default');
  assert.equal(Object.keys(CLAUDE_MODES).length, 5);
  assert.deepEqual(cc.env({ model: 'sonnet' }), { ANTHROPIC_MODEL: 'sonnet' });
  assert.deepEqual(cc.env({ model: 'claude-opus-4-1' }), { ANTHROPIC_MODEL: 'claude-opus-4-1' });
  assert.deepEqual(cc.env({ model: 'gpt-5' }), {}, 'a Copilot model left in Settings is not passed on');
  assert.deepEqual(cc.env({ model: 'default' }), {});
  assert.equal(claudeModel('haiku'), true);
  assert.deepEqual(cc.sandboxEnv('/home/me'), { CLAUDE_CONFIG_DIR: '/home/me/.claude' });
});

test('skills folders per agent', () => {
  assert.deepEqual(AGENTS.copilot.skillsDirs('/w', '/h'), ['/w/.github/skills', '/h/.copilot/skills']);
  assert.deepEqual(AGENTS.claude.skillsDirs('/w', '/h'), ['/w/.claude/skills', '/w/.github/skills', '/h/.claude/skills']);
  assert.equal(AGENTS.claude.personalSkills('/h'), '/h/.claude/skills');
});

test('the sandbox lets the agent write its own state, and reach its own service', () => {
  const base = { cwd: '/home/me/dev/acme', home: '/home/me', platform: 'darwin', exists: () => true, wsl: null };
  const cp = srtSettings(base);
  assert.ok(cp.filesystem.allowWrite.includes('/home/me/.copilot'));
  const cc = srtSettings({ ...base, state: AGENTS.claude.state });
  assert.ok(cc.filesystem.allowWrite.includes('/home/me/.claude'));
  assert.ok(cc.filesystem.allowRead.includes('/home/me/.claude'));
  assert.ok(!cc.filesystem.allowWrite.includes('/home/me/.copilot'));
  assert.ok(!cc.filesystem.allowRead.includes('/home/me/.copilot'));
  assert.ok(AGENTS.claude.hosts.includes('api.anthropic.com'));
});

test('findBin: as set, on PATH, else under nvm', () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-agent-'));
  assert.equal(findBin('nope-not-here', null, home), null);
  const bin = join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude-agent-acp'), '');
  assert.equal(findBin('claude-agent-acp', null, home), join(bin, 'claude-agent-acp'));
  assert.equal(findBin('x', 'claude-agent-acp', home), 'claude-agent-acp', 'a bare name is left to PATH');
  assert.equal(findBin('x', '/no/such/bin', home), null);
});

test('settings, doctor and team packs know the agent', async () => {
  assert.deepEqual(validate({ CLEARSKY_AGENT: 'Claude' }), { CLEARSKY_AGENT: 'claude' });
  assert.throws(() => validate({ CLEARSKY_AGENT: 'codex' }), /copilot or claude/);
  assert.deepEqual(parsePack(JSON.stringify({ name: 'T', settings: { CLEARSKY_AGENT: 'claude' } })).settings, { CLEARSKY_AGENT: 'claude' });
  const base = { platform: 'linux', env: {}, srt: async () => true, run: async () => ({ ok: false, missing: true, out: '' }) };
  const cc = (await checks({ ...base, has: () => false, agent: AGENTS.claude })).find((c) => c.id === 'copilot');
  assert.match(cc.label, /Claude Code/);
  assert.equal(cc.ok, false);
  assert.match(cc.fix.command, /claude-agent-acp/);
  const cp = (await checks({ ...base, has: () => true })).find((c) => c.id === 'copilot');
  assert.match(cp.label, /Copilot/);
});

// A stand-in ACP agent: answers initialize and session/new, and writes down what it was asked.
function fakeAgent(caps) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-acp-'));
  const log = join(dir, 'log.jsonl');
  const bin = join(dir, 'agent.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
  const result = m.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: ${JSON.stringify(caps)} }
    : m.method === 'session/new' ? { sessionId: 's-1' } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) };
}

test('a chat with Claude Code sets its mode and passes its folders', async () => {
  const f = fakeAgent({ loadSession: true, sessionCapabilities: { additionalDirectories: {} } });
  const a = new AcpAgent(process.execPath, [f.bin], { acp: false, label: 'Claude Code', mode: 'plan', dirs: ['/tmp'] });
  try {
    assert.equal(await a.start('/tmp'), 's-1');
    const calls = f.calls();
    assert.deepEqual(calls.find((c) => c.method === 'session/new').params.additionalDirectories, ['/tmp']);
    assert.deepEqual(calls.find((c) => c.method === 'session/set_mode').params, { sessionId: 's-1', modeId: 'plan' });
  } finally { a.close(); }
});

test('a chat with Copilot sends no mode, and no folders it does not take', async () => {
  const f = fakeAgent({ loadSession: true });
  const a = new AcpAgent(process.execPath, [f.bin], { acp: false, dirs: ['/tmp'] });
  try {
    await a.start('/tmp');
    const calls = f.calls();
    assert.equal(calls.find((c) => c.method === 'session/new').params.additionalDirectories, undefined);
    assert.ok(!calls.some((c) => c.method === 'session/set_mode'));
  } finally { a.close(); }
});
