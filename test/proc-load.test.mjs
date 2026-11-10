import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStat, label, TreeLoad } from '../lib/proc-load.mjs';
import { lowPriority } from '../lib/sandbox.mjs';

const stat = (pid, name, ppid, ticks, pages = 256) => `${pid} (${name}) S ${ppid} ${Array(9).fill(0).join(' ')} ${ticks} 0 ${Array(8).fill(0).join(' ')} ${pages} 0`;

test('a /proc stat line, also with spaces and parentheses in the name', () => {
  assert.deepEqual(parseStat(stat(7, 'java', 1, 250)), { pid: 7, name: 'java', ppid: 1, ticks: 250, rssKb: 1024 });
  assert.equal(parseStat(stat(8, 'Web Content (x)', 7, 3)).name, 'Web Content (x)');
  assert.equal(parseStat('nonsense'), null);
});

test('Java processes are named by what they run', () => {
  assert.equal(label('java', 'java -classpath /m/boot/plexus-classworlds-2.8.jar org.codehaus.plexus.classworlds.launcher.Launcher verify'), 'java (Maven)');
  assert.equal(label('java', 'java -jar target/surefire/surefirebooter123.jar'), 'java (tests)');
  assert.equal(label('bwrap', 'whatever'), 'bwrap');
});

test('a chat\'s sandbox load is the CPU and memory of its whole process tree', () => {
  let t = 0, procs = [];
  const load = new TreeLoad({ read: () => new Map(procs.map((l) => { const p = parseStat(l); return [p.pid, p]; })), cmdline: () => 'plexus-classworlds', now: () => t });
  procs = [stat(10, 'nice', 1, 0), stat(11, 'node', 10, 100), stat(12, 'java', 11, 1000), stat(99, 'java', 1, 0)];
  const first = load.sample(new Map([['chat', 10], ['gone', 50]]));
  assert.equal(first.get('chat').cpuPct, null, 'nothing to compare with yet');
  assert.equal(first.get('chat').procs, 3, 'not the java outside the tree');
  assert.ok(!first.has('gone'));
  t = 2000;
  procs = [stat(10, 'nice', 1, 0), stat(11, 'node', 10, 120), stat(12, 'java', 11, 1960)];
  const s = load.sample(new Map([['chat', 10]])).get('chat');
  assert.equal(s.cpuPct, 490, '4.8 cores of java plus 0.1 of node');
  assert.deepEqual(s.top, { pid: 12, name: 'java (Maven)', cpuPct: 480 });
  assert.equal(s.memMb, 3);
});

test('the sandbox runs at low priority where nice exists', () => {
  assert.deepEqual(lowPriority(['bwrap', '--x', 'node'], { platform: 'linux', exists: (b) => b === '/usr/bin/nice' }), { bin: '/usr/bin/nice', args: ['-n', '10', 'bwrap', '--x', 'node'] });
  assert.deepEqual(lowPriority(['bwrap', 'node'], { platform: 'linux', exists: () => false }), { bin: 'bwrap', args: ['node'] });
  assert.deepEqual(lowPriority(['bwrap', 'node'], { nice: 0, platform: 'linux', exists: () => true }), { bin: 'bwrap', args: ['node'] });
});
