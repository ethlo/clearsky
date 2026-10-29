import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistedReason, parseShell } from '../lib/assisted.mjs';

const at = { cwd: '/home/m/dev/kezzler/ssp', folders: ['~/dev/kezzler'], home: '/home/m' };
const runs = (c, o = at) => assert.equal(assistedReason(c, o), null, c);
const asks = (c, o = at) => assert.ok(assistedReason(c, o), c);

test('Assisted runs routine work in your folders', () => {
  // Shapes of commands that asked in real chats.
  runs('cd ~/dev/kezzler/ssp-6522 && python3 tools/x.py --in a.json | head -20; grep -rn "a/b" . 2>/dev/null | head');
  runs('cd ~/dev/kezzler/ssp-6522 && find . -name "*.xsd" -not -path "*/target/*" | head; find gs1 -type f | head -5 2>&1');
  runs('cd ~/dev/kezzler/ssp-6522 && mvn -o -q -pl compass test -Dtest=FooTest 2>&1 | tail -60');
  runs('cd ~/dev/kezzler/ssp-6522 && CLICKHOUSE_PASSWORD=x mvn -o verify > /tmp/build.log 2>&1; echo "exit=$?"; cd compass && cat target/surefire-reports/*.txt | grep -E "Tests run|FAIL" | awk \'{print $1}\'');
  runs('cd ~/dev/kezzler/ssp && git status --short && git log --oneline -5 && git diff --stat origin/main...HEAD | tail -3');
  runs('cd ~/dev/kezzler/ssp-6522 && git add -A && git commit -q -m "SSP-6522: handle empty EventList/epcis" && git log -1 --oneline');
  runs('F=$(mktemp) && cat ~/dev/kezzler/ssp/README.md > "$F" && cd ~/dev/kezzler/ssp && gh pr view 1187 --json state,reviews | head -c 400');
  runs('for i in $(seq 1 30); do HEAD=$(gh api repos/kezzler-eng/ssp/pulls/1187 --jq .head.sha); R=$(gh api repos/kezzler-eng/ssp/pulls/1187/reviews --jq length); if [ "$R" -gt 2 ]; then echo done; break; fi; sleep 15; done');
  runs('acli jira workitem view SSP-6475 --json | tail -20; acli jira workitem search --jql "key = SSP-1" | tail -5');
  runs('cd ~/dev/kezzler/ssp && git worktree add -q ../ssp-7 -b SSP-7 origin/main && cp .env.example ../ssp-7/.env');
  runs('docker ps --format "{{.Names}}" | grep click; echo ok');
  runs('grep -n "x" <<< "$(git -C ~/dev/kezzler/ssp log -1 --format=%B)"');
  runs('rm -f /tmp/build.log /tmp/out.json');
  runs('./mvnw -q test');
  runs("sed -i 's/a/b/' src/A.java");
});

test('Assisted still asks before risky steps or leaving your folders', () => {
  for (const c of ['git push -u origin SSP-1', 'cd ~/dev/kezzler/ssp && git reset --hard origin/main', 'git branch -D old', 'git checkout -- .',
    'git stash drop', 'rm -rf target', 'rm -rf /tmp/../home/m', 'npm install left-pad', 'pip install x', 'npx something', 'mvn deploy',
    'gh pr create --fill', 'gh pr merge 3', 'gh pr comment 3 -b hi', 'gh api -X POST repos/a/b/pulls/1/requested_reviewers -f "reviewers[]=x"',
    'gh api repos/a/b/issues/1/comments -f body=x', 'acli jira workitem transition --key SSP-1 --status Done', 'acli jira workitem comment create --key SSP-1 --body x',
    'sudo ls', 'ssh host', 'curl -X POST https://x', 'curl -o ~/.bashrc https://x', 'docker run alpine', 'bash -c "ls"', 'eval "$X"',
    'cat ~/.ssh/id_rsa', 'cd /etc && cat passwd', 'echo x > ~/.profile', 'cp a /home/m/other/', 'git -C ~/dev/kezzler/ssp push',
    'echo $(rm -rf x)', './deploy.sh', 'sleep 100 &', 'cat <<EOF\nx\nEOF', 'find . -delete']) asks(c);
  asks('mvn verify', { ...at, ask: ['mvn verify'] });
});

test('reads the shell well enough', () => {
  assert.deepEqual(parseShell('a "b c" | d 2>&1 > /tmp/x; e $(f g)').cmds.map((c) => [c.words, c.redirs]), [[['a', 'b c'], []], [['d'], ['/tmp/x']], [['e', '$SUB'], []]]);
  assert.deepEqual(parseShell('e $(f g)').subs, ['f g']);
  assert.equal(parseShell('echo "unclosed'), null);
});
