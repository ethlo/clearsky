import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistedReason, outwardReason, parseShell } from '../lib/assisted.mjs';

const at = { cwd: '/home/m/dev/acme/abc', folders: ['~/dev/acme'], home: '/home/m' };
const runs = (c, o = at) => assert.equal(assistedReason(c, o), null, c);
const asks = (c, o = at) => assert.ok(assistedReason(c, o), c);

test('Assisted runs routine work in your folders', () => {
  // Shapes of commands that asked in real chats.
  runs('cd ~/dev/acme/abc-6522 && python3 tools/x.py --in a.json | head -20; grep -rn "a/b" . 2>/dev/null | head');
  runs('cd ~/dev/acme/abc-6522 && find . -name "*.xsd" -not -path "*/target/*" | head; find gs1 -type f | head -5 2>&1');
  runs('cd ~/dev/acme/abc-6522 && mvn -o -q -pl core test -Dtest=FooTest 2>&1 | tail -60');
  runs('cd ~/dev/acme/abc-6522 && DB_PASSWORD=x mvn -o verify > /tmp/build.log 2>&1; echo "exit=$?"; cd core && cat target/surefire-reports/*.txt | grep -E "Tests run|FAIL" | awk \'{print $1}\'');
  runs('cd ~/dev/acme/abc && git status --short && git log --oneline -5 && git diff --stat origin/main...HEAD | tail -3');
  runs('cd ~/dev/acme/abc-6522 && git add -A && git commit -q -m "ABC-6522: handle empty EventList/ord" && git log -1 --oneline');
  runs('F=$(mktemp) && cat ~/dev/acme/abc/README.md > "$F" && cd ~/dev/acme/abc && gh pr view 1187 --json state,reviews | head -c 400');
  runs('for i in $(seq 1 30); do HEAD=$(gh api repos/acme/abc/pulls/1187 --jq .head.sha); R=$(gh api repos/acme/abc/pulls/1187/reviews --jq length); if [ "$R" -gt 2 ]; then echo done; break; fi; sleep 15; done');
  runs('acli jira workitem view ABC-6475 --json | tail -20; acli jira workitem search --jql "key = ABC-1" | tail -5');
  runs('cd ~/dev/acme/abc && git worktree add -q ../abc-7 -b ABC-7 origin/main && cp .env.example ../abc-7/.env');
  runs('docker ps --format "{{.Names}}" | grep click; echo ok');
  runs('grep -n "x" <<< "$(git -C ~/dev/acme/abc log -1 --format=%B)"');
  runs('rm -f /tmp/build.log /tmp/out.json');
  runs('./mvnw -q test');
  runs('J=~/.m2/repository/a/b.jar; unzip -l "$J" | head; cat ~/.copilot/session-state/abc/files/pr-body.md');
  runs("cd ~/dev/acme/abc && python3 - <<'EOF'\nimport json\nprint(1)\nEOF");
  runs('ls ~/.m2/repository/com/acme/gs1/ | tail -3; unzip -p ~/.m2/repository/x/y.jar META-INF/MANIFEST.MF | head');
  runs("sed -i 's/a/b/' src/A.java");
});

test('Assisted still asks before risky steps or leaving your folders', () => {
  for (const c of ['git push -u origin ABC-1', 'git branch -D old', 'git clean -fdx', 'git tag -d v1',
    'git stash clear', 'rm -rf target', 'git worktree add /opt/wt main', 'rm -rf /tmp/../home/m', 'npm install left-pad', 'pip install x', 'npx something', 'mvn deploy',
    'gh pr create --fill', 'gh pr merge 3', 'gh pr comment 3 -b hi', 'gh api -X POST repos/a/b/pulls/1/requested_reviewers -f "reviewers[]=x"',
    'gh api repos/a/b/issues/1/comments -f body=x', 'acli jira workitem transition --key ABC-1 --status Done', 'acli jira workitem comment create --key ABC-1 --body x',
    'sudo ls', 'ssh host', 'curl -X POST https://x', 'curl -o ~/.bashrc https://x', 'docker run alpine', 'bash -c "ls"', 'eval "$X"',
    'cat ~/.ssh/id_rsa', 'cd /etc && cat passwd', 'echo x > ~/.profile', 'cp a /home/m/other/', 'git -C ~/dev/acme/abc push',
    'echo $(rm -rf x)', './deploy.sh', 'sleep 100 &', 'cat <<EOF\nx', 'find . -delete', 'cp a ~/.m2/settings.xml']) asks(c);
  asks('mvn verify', { ...at, ask: ['mvn verify'] });
});

test('Assisted runs local git and worktrees next to your clones, and what you allow', () => {
  // The shapes that asked in a real chat.
  runs('cd /home/m/dev/acme/ord-server && git fetch -q origin && git branch -a --list "*374*"; gh pr list --head ORD-374 --state all --json number; git worktree add -q -b ORD-374 ../ord-server-374 origin/main && cd ../ord-server-374 && git log --oneline -1',
    { ...at, cwd: '/home/m/dev/acme/ord-server', folders: ['~/dev/acme/ord-server'] });
  runs('cd /home/m/dev/acme/abc && git --no-pager diff > /tmp/wip.patch && git checkout -q -- . && git reset -q --hard origin/ABC-2 && git branch --set-upstream-to=origin/ABC-2 -q 2>/dev/null; git apply --3way /tmp/wip.patch; git status -s');
  runs('git rebase origin/main && git stash drop && git worktree remove ../abc-old', { ...at, cwd: '/home/m/dev/acme/abc', folders: ['~/dev/acme/abc'] });
  asks('acli jira workitem transition --key ABC-1 --status Done');
  runs('acli jira workitem transition --key ABC-1 --status Done', { ...at, allow: ['acli jira workitem transition'] });
  asks('cd ../abc.bak', { ...at, cwd: '/home/m/dev/acme/abc', folders: ['~/dev/acme/abc'] });
});

test('Sandboxed asks only about what reaches out', () => {
  const out = (c, o) => outwardReason(c, o);
  for (const c of ['rm -rf target && git reset --hard origin/main', 'python3 - <<EOF\nprint(1)\nEOF', './scripts/build.sh', 'cat ~/.bashrc', 'curl -s https://x',
    'git commit -am x && git rebase main', 'npm install', 'gh pr view 3', 'acli jira workitem view ABC-1']) assert.equal(out(c), null, c);
  for (const c of ['git push', 'cd x && git -C y push -f', 'bash -c "git push"', 'gh pr create --fill', 'gh api -X POST x', 'acli jira workitem transition --key A-1 --status Done',
    'curl -X POST https://x', 'mvn deploy', 'npm publish', 'kubectl apply -f x', 'docker push x', 'ssh host', 'eval "$X"', 'echo "unclosed']) assert.ok(out(c), c);
  assert.equal(out('acli jira workitem transition --key A-1 --status Done', { allow: ['acli jira workitem transition'] }), null);
  assert.ok(out('mvn verify', { ask: ['mvn verify'] }));
});

test('reads the shell well enough', () => {
  assert.deepEqual(parseShell('a "b c" | d 2>&1 > /tmp/x; e $(f g)').cmds.map((c) => [c.words, c.redirs]), [[['a', 'b c'], []], [['d'], ['/tmp/x']], [['e', '$SUB'], []]]);
  assert.deepEqual(parseShell('e $(f g)').subs, ['f g']);
  assert.equal(parseShell('echo "unclosed').error, 'unclosed quote');
  // Here-documents: the body is text for the command.
  const h = parseShell("cd ~/dev/acme/abc && python3 - <<'EOF'\nimport os\nprint(os.listdir('/etc'))\nEOF\necho done");
  assert.deepEqual(h.cmds.map((c) => c.words[0]), ['cd', 'python3', 'echo']);
  assert.equal(parseShell('cat <<EOF\nx').error, 'unfinished here-document');
});

test('in the sandbox, Assisted reads anywhere but still asks for changes outside your folders', () => {
  const sb = { ...at, readAnywhere: true };
  const look = 'cd ~/dev/acme/api && git worktree list; git branch -a --list "*ABC-1*" "*abc-1*"; gh pr list --head ABC-1 --state all --json number,state,url; echo ---; cat .sdkmanrc .java-version 2>/dev/null; grep -n -m5 "maven.compiler.release\\|<java.version>\\|<release>" pom.xml; ls ~/.sdkman/candidates/java/ /usr/lib/jvm 2>/dev/null; echo ---; ls .github/workflows | head -30; git status --short | head';
  runs(look, sb);
  asks(look);
  runs('cd ~/dev && timeout 60 grep -rIn -i "logging.level" --exclude-dir={node_modules,target} . 2>/dev/null | head -20', sb);
  asks('grep -rn x . > ~/out.txt', sb);
  asks('cp a.txt /etc/x', sb);
  asks('find ~/dev -name x -delete', sb);
  asks('sed -i s/a/b/ ~/notes.txt', sb);
});
