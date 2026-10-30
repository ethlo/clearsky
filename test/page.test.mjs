// The page itself, in a real browser: every view renders without errors, with Slack off (the
// case that once broke the inbox). Skipped when Playwright isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
const pr = (o) => ({
  number: 1, title: 'SSP-5: Fix capture', url: 'https://github.com/acme/api/pull/1', state: 'OPEN', isDraft: false, createdAt: ago(48), updatedAt: ago(1),
  reviewDecision: null, mergeable: 'MERGEABLE', headRefName: 'feature/SSP-5', additions: 3, deletions: 1, changedFiles: 1,
  repository: { nameWithOwner: 'acme/api' }, author: { login: 'me' }, reviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { committedDate: ago(2), statusCheckRollup: { state: 'SUCCESS' } } }] }, closingIssuesReferences: { nodes: [] }, timelineItems: { nodes: [] }, ...o,
});

test('every view renders without page errors', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  const gh = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const q = body ? JSON.parse(body).query : '';
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (q.includes('assignableUsers')) return send({ data: { viewer: { login: 'me' }, repository: { assignableUsers: { nodes: [{ login: 'anna', name: 'Anna' }, { login: 'bob', name: null }] },
      pullRequest: { author: { login: 'me' }, suggestedReviewers: [{ reviewer: { login: 'anna', name: 'Anna' } }], reviewRequests: { nodes: [] }, reviews: { nodes: [] } } } } });
    if (q.includes('viewer { login }') && !q.includes('search')) return send({ data: { viewer: { login: 'me' } } });
    if (q.includes('reviewRequested: search')) return send({ data: {
      reviewRequested: { nodes: [pr({ number: 7, title: 'OPS-77: Their change', url: 'https://github.com/acme/api/pull/7', author: { login: 'anna' },
        reviews: { nodes: [{ author: { login: 'bob', __typename: 'User' }, state: 'APPROVED', submittedAt: ago(3) }] } })] },
      myPrs: { nodes: [pr({ headRefName: 'feature/ops-1-certs' })] }, mentions: { nodes: [] }, assigned: { nodes: [] } } });
    send({ data: {} });
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const port = 7900 + Math.floor(Math.random() * 80);
  const server = spawn(process.execPath, [fileURLToPath(new URL('../bin/clearsky.mjs', import.meta.url)), 'serve', '--port', String(port)], {
    stdio: 'ignore', env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'clearsky-page-')), CLEARSKY_POLL_MINUTES: '0',
      GITHUB_TOKEN: 'x', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`, GITHUB_ORGS: 'acme',
      ACLI_BIN: fileURLToPath(new URL('./fake-acli.mjs', import.meta.url)), COPILOT_BIN: fileURLToPath(new URL('./fake-copilot.mjs', import.meta.url)) },
  });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.kill(); gh.close(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#list li.r', { timeout: 10_000 });
  assert.ok(await page.locator('#list li.r').count() >= 2, 'the inbox lists the PRs');
  assert.match(await page.locator("#list").innerText(), /no reviewer yet/i);

  // Your PR and the ticket in its branch link to each other, and the link opens the other here.
  assert.match(await page.locator('#list li.r', { hasText: 'SSP-5' }).first().locator('.xref').innerText(), /OPS-1/);
  const ticketLink = page.locator('#list li.r', { hasText: 'Rotate certs' }).locator('.xref');
  assert.match(await ticketLink.innerText(), /api #1 · no reviewer yet/i);
  await ticketLink.click();
  await page.waitForSelector('#v-item:not([hidden]) h2:text("SSP-5: Fix capture")');
  assert.match(await page.locator('#item .xrefs').innerText(), /OPS-1/);
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // The next step: your PR without reviewers asks for one, in the row and on its page, and the
  // button opens the reviewer picker there.
  assert.match(await page.locator('#list li.r', { hasText: 'SSP-5' }).first().locator('.next').innerText(), /Request review/);
  await page.locator('#list li.r', { hasText: 'SSP-5' }).first().locator('.next').click();
  await page.waitForSelector('#v-item:not([hidden]) .next-row');
  assert.match(await page.locator('#item .next-row').innerText(), /Request review/);
  await page.waitForSelector('.rv-pick li[data-q]');
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/item.png` });
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // A PR page shows who reviews it and where each stands.
  await page.locator('#list li.r', { hasText: 'Their change' }).first().locator('.t > a').first().click();
  await page.waitForSelector('#v-item:not([hidden]) .rv-who');
  assert.match(await page.locator('#item .rv-who').innerText(), /bob · approved/);
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // A ticket that isn't in your lists still gets a link, which opens it here.
  const other = page.locator('#list li.r', { hasText: 'Their change' }).first().locator('.xref');
  assert.equal(await other.innerText(), 'OPS-77');
  await other.click();
  await page.waitForSelector('#v-item:not([hidden]) h2:text("OPS-77")');
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // Your PRs and Tickets as tables, with the branch.
  await page.goto(`${base}/#prs`);
  await page.waitForSelector('#list .wt-head');
  assert.match(await page.locator('#list li.r.tbl', { hasText: 'SSP-5' }).innerText(), /feature\/ops-1-certs[\s\S]*no reviewer yet/i);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/prs.png` });
  await page.goto(`${base}/#tickets`);
  await page.waitForSelector('#list li.r.tbl');
  assert.match(await page.locator('#list li.r.tbl', { hasText: 'Rotate certs' }).innerText(), /api #1[\s\S]*feature\/ops-1-certs/);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/tickets.png` });
  await page.locator('.wt-bar summary').click();
  await page.uncheck('[data-wcol="b"]');
  assert.ok(await page.locator('#list li.r.tbl .c-b').first().isHidden(), 'Branch column hides');
  await page.reload();
  await page.waitForSelector('#list li.r.tbl');
  assert.ok(await page.locator('#list li.r.tbl .c-b').first().isHidden(), 'and stays hidden');
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // An item page, and the review picker on it.
  await page.locator('#list li.r', { hasText: 'SSP-5' }).first().click();
  await page.waitForSelector('#v-item:not([hidden]) [data-rv-open]');
  await page.click('[data-rv-open]');
  await page.waitForSelector('.rv-pick li[data-q]');
  assert.equal(await page.locator('.rv-pick li[data-q]').count(), 2);

  for (const view of ['calendar', 'standup', 'notifications', 'reviews', 'prs', 'tickets']) {
    await page.goto(`${base}/#${view}`);
    await page.waitForTimeout(400);
  }

  // Settings → Copilot: defaults for new chats, with Copilot's own choices; a saved default is used by a new chat.
  await page.goto(`${base}/settings`);
  await page.waitForSelector('#COPILOT_PERMISSION option[value="full"]', { state: 'attached' });
  await page.selectOption('#COPILOT_PERMISSION', 'read');
  await page.click('button.save[data-keys^="COPILOT_"]');
  await page.waitForFunction(() => /saved/i.test(document.querySelector('button.save[data-keys^="COPILOT_"]').nextElementSibling.textContent), null, { timeout: 5000 });
  await page.goto(`${base}/#copilot`);
  await page.waitForFunction(() => document.querySelector('#cp-perm').value === 'read', null, { timeout: 5000 });

  // A Copilot chat; afterwards the menu lists it.
  await page.goto(`${base}/#copilot`);
  await page.selectOption('#cp-perm', 'full');
  await page.fill('#chat-text', 'hello');
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/chat.png` });
  await page.press('#chat-text', 'Enter');
  await page.waitForFunction(() => document.querySelector('#chat-send').dataset.state === 'send', null, { timeout: 10_000 });
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#side-cp .ni', { timeout: 15_000 });

  for (const w of [390, 360]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(base);
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scrolling at ${w}px`);
  }
  assert.deepEqual(errors, []);
});
