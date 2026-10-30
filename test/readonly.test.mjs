import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnly } from '../lib/readonly.mjs';

const at = { cwd: '/home/m/dev/acme/abc', folders: ['~/dev/acme'], home: '/home/m' };
const ok = (c) => assert.ok(isReadOnly(c, at), c);
const no = (c) => assert.ok(!isReadOnly(c, at), c);

test('reading commands in your folders run without asking', () => {
  ok('git status');
  ok('cd ~/dev/acme; grep -rl --include=*.java "class Ord1DocumentXmlRepresentationConverter\\|class OrdDocumentService\\b" . 2>/dev/null | grep -v /target/ | head; grep -rn "gs1.ord\\|ord" abc-6522/pom.xml | head');
  ok('cd ~/dev/acme/abc-6522/gs1/src/main/java/com/acme/gs1/ord; cat Ord1DocumentXmlRepresentationConverter.java; ls; grep -n "getEventList\\|EventList()" -r . | head -30');
  ok('cd ~/dev/acme/abc-6522; sed -n 60,100p gs1/src/A.java; sed -n 60,130p rest-api/B.java; cat gs1/C.java | head -40; grep -rn "EventList.*minOccurs" --include=*.xsd . | grep -v target | head');
  ok('git -C ~/dev/acme/abc log --oneline -5 && git diff main...HEAD --stat');
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

