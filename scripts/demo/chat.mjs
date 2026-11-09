// The demo's Copilot sessions (scripts/demo/copilot.mjs), and the one that is replayed in full.
import { join } from 'node:path';
import { HOME } from './home.mjs';

const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
export const CHAT = { id: 'demo-pay412-refunds', cwd: join(HOME, 'dev', 'acme', 'payments-api') };
export const SESSIONS = [
  { sessionId: CHAT.id, cwd: CHAT.cwd, title: 'PAY-412: Partial refunds for split payments', branch: 'PAY-412-partial-refunds', updatedAt: ago(0.2) },
  { sessionId: 'demo-review-482', cwd: CHAT.cwd, title: 'Review acme/payments-api#482', branch: 'PAY-415-webhook-retries', updatedAt: ago(3) },
  { sessionId: 'demo-standup', cwd: join(HOME, 'dev'), title: 'Stand-up notes', updatedAt: ago(23) },
  { sessionId: 'demo-flaky-it', cwd: CHAT.cwd, title: 'Flaky RefundServiceIT', branch: 'main', updatedAt: ago(30) },
];
let n = 0;
const tool = (title, kind, extra = {}) => { const id = `t${++n}`; return [
  { sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'pending', ...extra },
  { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' },
]; };
const say = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const me = (text) => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
CHAT.updates = [
  me('Address Dev\'s review comments on PAY-412 and get the PR ready for another look.'),
  ...tool('gh pr view 479 --comments', 'execute'),
  say('Dev left two open threads on #479:\n\n1. `RefundSplitter` rounds each part on its own, so three refunds of 33.33 can leave a cent behind.\n2. The new endpoint has no test for a refund larger than what is left on the payment.\n\nI\'ll fix both.'),
  ...tool('Read src/main/java/com/acme/pay/refund/RefundSplitter.java', 'read'),
  ...tool('Edit src/main/java/com/acme/pay/refund/RefundSplitter.java', 'edit'),
  ...tool('Edit src/test/java/com/acme/pay/refund/RefundSplitterTest.java', 'edit'),
  ...tool('./mvnw -q test -pl refunds', 'execute'),
  say('The splitter now gives the last part whatever is left after the others, so the parts always add up. Unit tests pass (214, 0 failures).'),
  ...tool('bg vm ./mvnw verify -pl refunds', 'execute'),
  say('The integration tests need Docker, so they run in the VM as background job j4c1e9 (about 7 minutes). I\'m waiting for its result; Clearsky wakes me here when it ends.'),
  me('[Clearsky] Background job j4c1e9 (`./mvnw verify -pl refunds`, in the VM) finished: exit 0, after 7m 12s.\nThe last lines of its output:\n```\n[INFO] Tests run: 31, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 48.2 s -- in com.acme.pay.refund.RefundServiceIT\n[INFO] Results:\n[INFO] Tests run: 245, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n[INFO] Total time:  07:09 min\n```\nAll of it: ~/.cache/clearsky/tmp/jobs/j4c1e9.log. Go on with the task from here.'),
  say('Integration tests pass too (245, 0 failures), including `RefundServiceIT` against Postgres and Kafka.'),
  ...tool('review --ticket PAY-412', 'execute'),
  say('The self-review found one more thing: the over-refund check compared amounts in different currencies. Fixed, with a test.\n\n**VERDICT: ready** on the second round.'),
  ...tool('git push', 'execute'),
  ...tool('gh pr comment 479 (replies to both threads)', 'execute'),
  say('Pushed to `PAY-412-partial-refunds` and answered Dev\'s two threads. CI is green. My reply on the rounding thread:\n\n> Good catch. The last part now gets whatever is left after the others, so the parts always add up. `RefundSplitterTest` covers 3 × 33.33 and 7 × 14.29.\n>\n> Fixed in a1b2c3d.\n\nI\'ve also moved PAY-412 to **In Review**.\n\nOne thing for you: the CSV ledger export (PAY-420) has the same rounding pattern. Want me to open a ticket for it?'),
];
