// The other two roles of Clearsky's image (docker-compose.yml): Copilot's runner and its proxy.
import { serveRunner } from '../lib/runner.mjs';
import { serveEgress } from '../lib/egress.mjs';
import { parseDomains } from '../lib/sandbox.mjs';

const role = process.argv[2];
if (role === 'runner') {
  serveRunner({ token: process.env.CLEARSKY_RUNNER_TOKEN, bin: process.env.COPILOT_REAL_BIN || 'copilot', log: console.error });
  console.error('clearsky: Copilot runner on :7790');
} else if (role === 'egress') {
  const list = parseDomains(process.env.CLEARSKY_EGRESS_ALLOW);
  serveEgress({ list, log: console.error });
  console.error(`clearsky: proxy on :3128 for ${list.length} hosts`);
} else {
  console.error('usage: container-roles.mjs runner|egress');
  process.exit(2);
}
