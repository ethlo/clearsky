import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnly } from '../lib/readonly.mjs';

const at = { cwd: '/home/m/dev/kezzler/ssp', folders: ['~/dev/kezzler'], home: '/home/m' };
const ok = (c) => assert.ok(isReadOnly(c, at), c);
const no = (c) => assert.ok(!isReadOnly(c, at), c);

test('reading commands in your folders run without asking', () => {
  ok('git status');
  ok('cd ~/dev/kezzler; grep -rl --include=*.java "class Epcis1DocumentXmlRepresentationConverter\\|class EpcisDocumentService\\b" . 2>/dev/null | grep -v /target/ | head; grep -rn "gs1.epcis\\|epcis" ssp-6522/pom.xml | head');
  ok('cd ~/dev/kezzler/ssp-6522/gs1/src/main/java/com/kezzler/gs1/epcis; cat Epcis1DocumentXmlRepresentationConverter.java; ls; grep -n "getEventList\\|EventList()" -r . | head -30');
  ok('cd ~/dev/kezzler/ssp-6522; sed -n 60,100p gs1/src/A.java; sed -n 60,130p rest-api/B.java; cat gs1/C.java | head -40; grep -rn "EventList.*minOccurs" --include=*.xsd . | grep -v target | head');
  ok('git -C ~/dev/kezzler/ssp log --oneline -5 && git diff main...HEAD --stat');
  ok('git branch --show-current');
  ok('find . -name "*.xml" -not -path "*/target/*" | head');
  ok('ls -la 2>&1');
});

test('anything that writes, runs code or leaves your folders asks', () => {
  no('mvn test');
  no('cat ~/.ssh/id_rsa');
  no('cd /etc; cat passwd');
  no('cd ..; cd ..; cat x'); // ends up in ~/dev
  no('grep -r foo ../../../..');
  no('echo hi > out.txt');
  no('sed -i s/a/b/ f.java');
  no('sed -n 1e\\ rm f');
  no('find . -delete');
  no('find . -exec rm {} ;');
  no('cat $(echo f)');
  no('cat `f`');
  no('git push');
  no('git branch -D old');
  no('git -c core.pager=sh log');
  no('rm -rf target');
  no('sleep 100 &');
  no('X=1 cat f');
  no('sort -o f f');
  no('cat < f');
});

test('Assisted also runs builds, tests and local git steps in your folders', async () => {
  const { ASSISTED_COMMANDS } = await import('../lib/readonly.mjs');
  const as = { ...at, allow: ASSISTED_COMMANDS };
  for (const c of ['cd ~/dev/kezzler/ssp-6522 && mvn -o -q -pl compass test -Dtest=Foo 2>&1 | tail -40', './mvnw verify', 'npm test',
    'git add -A && git commit -m "SSP-1: fix a/b"', 'git fetch -q origin && git worktree add -q ../ssp-7 SSP-7']) assert.ok(isReadOnly(c, as), c);
  for (const c of ['git push -u origin SSP-1', 'git reset --hard', 'git add -f secret', 'rm -rf target', 'mvn deploy > out.log', 'cd /tmp && mvn test',
    'curl https://x', 'npm install left-pad', 'acli jira workitem transition --key SSP-1 --status Done']) assert.ok(!isReadOnly(c, as), c);
  assert.ok(!isReadOnly('mvn test', at), 'not in Ask');
});
