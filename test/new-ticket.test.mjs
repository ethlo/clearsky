import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isCreate, createSummary, openVersions, ticketFields, pickedTicket, ticketArgv } from '../lib/new-ticket.mjs';
import { needs, serveBroker } from '../lib/broker.mjs';
import { newTicketFields } from '../lib/app/chat-gate.mjs';

const create = (...a) => ['jira', 'workitem', 'create', ...a];

test('a new ticket is one `acli jira workitem create`, and it always asks', () => {
  assert.ok(isCreate(create('--project', 'PAY', '--summary', 'S')));
  assert.ok(!isCreate(create('--generate-json')), 'only prints acli\'s template');
  assert.ok(!isCreate(['jira', 'workitem', 'create-bulk', '--from-csv', 'x.csv']));
  assert.ok(!isCreate(['jira', 'workitem', 'comment', 'create', '--key', 'PAY-1']));
  assert.equal(needs('acli', create('--project', 'PAY'), ['acli jira workitem create']), 'ask', 'never-ask list or not');
  assert.deepEqual(createSummary(create('-p', 'PAY', '-s', 'Fix it', '--type=Bug')), { project: 'PAY', summary: 'Fix it', type: 'Bug', fromJson: null });
});

test('the card offers the named project first, then the chat\'s and starred ones, each with its open versions', async () => {
  const versions = { PAY: [{ name: '2.13', released: true }, { name: '2.14', releaseDate: '2026-12-02T00:00:00Z' }, { name: '2.15' }] };
  const fields = await newTicketFields('PAY', ['PAY', 'WEB'], { starred: ['OPS', 'PAY'], versionsOf: async (k) => { if (k === 'OPS') throw new Error('no'); return versions[k] || []; } });
  const [project, version] = fields;
  assert.deepEqual(project.options.map((o) => o.value), ['PAY', 'WEB', 'OPS']);
  assert.equal(project.value, 'PAY');
  assert.equal(version.value, null, 'you pick one: nothing is picked for you');
  assert.deepEqual(version.choices.PAY.map((o) => o.label), ['2.14 (2026-12-02)', '2.15', 'No fix version']);
  assert.deepEqual(version.choices.WEB.map((o) => o.value), ['']);
  assert.ok(version.notes.OPS && !version.notes.WEB, 'a project whose versions couldn\'t be read says so');
  // only what the card offered
  assert.deepEqual(pickedTicket(fields, { project: 'PAY', version: '2.14' }), { project: 'PAY', version: '2.14' });
  assert.deepEqual(pickedTicket(fields, { project: 'WEB', version: '' }), { project: 'WEB', version: null });
  assert.equal(pickedTicket(fields, { project: 'PAY', version: '2.13' }), null, 'released: not offered');
  assert.equal(pickedTicket(fields, { project: 'EVIL', version: '' }), null);
  assert.equal(pickedTicket(fields, { project: 'PAY' }), null, 'no version picked');
  assert.deepEqual(openVersions([{ name: '1', released: true }]).map((v) => v.name), ['1'], 'all released: offered anyway');
  assert.deepEqual(ticketFields({ project: null }).at(0).options, []);
});

test('the picked project and fix version go into the command acli runs', () => {
  const files = {};
  const io = { writeFile: (n, t) => { files[n] = t; return `/tmp/x/${n}`; }, readFile: (f) => { throw new Error(`no ${f}`); }, cwd: '/w' };
  // no version: the same command, in the project you picked
  assert.deepEqual(ticketArgv(create('--project', 'PAY', '--summary', 'S'), { project: 'WEB', version: null }, io), create('--project', 'WEB', '--summary', 'S'));
  assert.deepEqual(ticketArgv(create('--summary', 'S'), { project: 'WEB', version: null }, io), create('--summary', 'S', '--project', 'WEB'));
  // a version: a definition with it, the description as ADF
  const a = ticketArgv(create('-p', 'PAY', '-s', 'Ledger CSV rounding', '-t', 'Bug', '-l', 'csv, ledger', '--parent', 'PAY-1', '-d', '## Why\n- it loses cents', '--json'), { project: 'PAY', version: '2.14' }, io);
  assert.deepEqual(a, create('--from-json', '/tmp/x/workitem.json', '--json'));
  const def = JSON.parse(files['workitem.json']);
  assert.deepEqual({ ...def, description: def.description.type }, { summary: 'Ledger CSV rounding', type: 'Bug', labels: ['csv', 'ledger'], parentIssueId: 'PAY-1', description: 'doc', projectKey: 'PAY',
    additionalAttributes: { fixVersions: [{ name: '2.14' }] } });
  // its own --from-json: read from the chat's folder, project and version set
  const own = { ...io, readFile: (f) => (f === '/w/w.json' ? JSON.stringify({ summary: 'From file', projectKey: 'OLD', type: 'Story', additionalAttributes: { labels: ['x'] } }) : null) };
  ticketArgv(create('--from-json', 'w.json'), { project: 'PAY', version: null }, own);
  assert.deepEqual(JSON.parse(files['workitem.json']), { summary: 'From file', projectKey: 'PAY', type: 'Story', additionalAttributes: { labels: ['x'] } });
  ticketArgv(create('--from-json', 'w.json'), { project: 'PAY', version: '2.15' }, own);
  assert.deepEqual(JSON.parse(files['workitem.json']).additionalAttributes, { labels: ['x'], fixVersions: [{ name: '2.15' }] });
  assert.throws(() => ticketArgv(create('-p', 'PAY'), { project: 'PAY', version: '2.14' }, io), /no summary/);
  assert.throws(() => ticketArgv(create('-e'), { project: 'PAY', version: '2.14' }, io), /--editor/);
});

test('through the door: the card\'s answer decides the project and version, Deny creates nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  writeFileSync(join(work, 'desc.md'), '# Goal\n- one\n- two\n');
  const seen = [];
  let answer = { ticket: { project: 'PAY', version: '2.14' } };
  const run = (bin, argv, opts, cb) => {
    const i = argv.indexOf('--from-json');
    seen.push({ argv, def: i >= 0 ? JSON.parse(readFileSync(argv[i + 1], 'utf8')) : null });
    cb(null, '{"key":"PAY-450"}\n', '');
  };
  const server = serveBroker({ path, run, where: (key) => (key === 'k1' ? [work] : null), ask: async () => answer });
  await new Promise((r) => server.once('listening', r));
  const bin = fileURLToPath(new URL('../scripts/sandbox-bin/acli', import.meta.url));
  const go = (args) => new Promise((r) => execFile(process.execPath, [bin, ...args],
    { cwd: work, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1' } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    assert.equal((await go(create('--project', 'WEB', '--summary', 'Rounding', '--description-file', 'desc.md'))).code, 0);
    const { def } = seen.at(-1);
    assert.equal(def.projectKey, 'PAY');
    assert.deepEqual(def.additionalAttributes.fixVersions, [{ name: '2.14' }]);
    assert.equal(def.description.type, 'doc', 'Markdown from the chat\'s file, as ADF');
    answer = { ticket: { project: 'WEB', version: null } };
    await go(create('--project', 'PAY', '--summary', 'Plain'));
    assert.deepEqual(seen.at(-1).argv, create('--project', 'WEB', '--summary', 'Plain'));
    answer = false;
    const before = seen.length;
    const no = await go(create('--project', 'PAY', '--summary', 'No'));
    assert.equal(no.code, 1); assert.match(no.err, /declined/);
    assert.equal(seen.length, before);
  } finally { server.close(); }
});
