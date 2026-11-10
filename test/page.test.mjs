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
  number: 1, title: 'ABC-5: Fix capture', url: 'https://github.com/acme/api/pull/1', state: 'OPEN', isDraft: false, createdAt: ago(48), updatedAt: ago(1),
  reviewDecision: null, mergeable: 'MERGEABLE', headRefName: 'feature/ABC-5', additions: 3, deletions: 1, changedFiles: 1,
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
  // Talking: a stand-in for the browser's speech recognition that hears one sentence.
  await page.addInitScript(() => { window.SpeechRecognition = class { start() { this.t = setTimeout(() => this.onresult?.({ results: [[{ transcript: 'only the backend part' }]] }), 50); } stop() { clearTimeout(this.t); setTimeout(() => this.onend?.(), 10); } }; });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#list li.r', { timeout: 10_000 });
  assert.ok(await page.locator('#list li.r').count() >= 2, 'the inbox lists the PRs');
  assert.match(await page.locator("#list").innerText(), /ready for a reviewer/i);

  // Your PR and the ticket in its branch link to each other, and the link opens the other here.
  assert.match(await page.locator('#list li.r', { hasText: 'ABC-5' }).first().locator('.xref').innerText(), /OPS-1/);
  const ticketLink = page.locator('#list li.r', { hasText: 'Rotate certs' }).locator('.xref');
  assert.match(await ticketLink.innerText(), /api #1 · ready for a reviewer/i);
  await ticketLink.click();
  await page.waitForSelector('#v-item:not([hidden]) h2:text("ABC-5: Fix capture")');
  assert.match(await page.locator('#item .stands').innerText(), /OPS-1/);
  // Where it stands: the ticket's status, the PR's, and that nobody reviews it yet.
  assert.match(await page.locator('#item .stands').innerText(), /TICKET\s+OPS-1\s+In Progress[\s\S]*PR\s+api #1\s+Ready for a reviewer/i);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/stands.png` });
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // The next step: your PR without reviewers asks for one, in the row and on its page, and the
  // button opens the reviewer picker there.
  assert.match(await page.locator('#list li.r', { hasText: 'ABC-5' }).first().locator('.next').innerText(), /Request review/);
  await page.locator('#list li.r', { hasText: 'ABC-5' }).first().locator('.next').click();
  await page.waitForSelector('#v-item:not([hidden]) .next-row');
  assert.match(await page.locator('#item .next-row').innerText(), /Request review/);
  await page.waitForSelector('.rv-pick li[data-q]');
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/item.png` });
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // A PR page shows who reviews it and where each stands.
  await page.locator('#list li.r', { hasText: 'Their change' }).first().locator('.t > a').first().click();
  await page.waitForSelector('#v-item:not([hidden]) h2:text("OPS-77: Their change")');
  assert.match(await page.locator('#item .stands').innerText(), /bob · approved/);
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // A ticket that isn't in your lists still gets a link, which opens it here.
  const other = page.locator('#list li.r', { hasText: 'Their change' }).first().locator('.xref');
  assert.equal(await other.innerText(), 'OPS-77');
  await other.click();
  await page.waitForSelector('#v-item:not([hidden]) h2:text("OPS-77")');
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');

  // The quick filter narrows the list as you type, and Esc clears it.
  await page.keyboard.press('/');
  await page.keyboard.type('their');
  assert.equal(await page.locator('#list li.r').count(), 1);
  assert.match(await page.locator('#list li.r').innerText(), /Their change/);
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#list li.r').count() >= 2);

  // Your PRs and Tickets as tables, with the branch.
  await page.goto(`${base}/#prs`);
  await page.waitForSelector('#list .wt-head');
  assert.match(await page.locator('#list li.r.tbl', { hasText: 'ABC-5' }).innerText(), /feature\/ops-1-certs[\s\S]*ready for a reviewer/i);
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
  await page.locator('#list li.r', { hasText: 'ABC-5' }).first().click();
  await page.waitForSelector('#v-item:not([hidden]) [data-rv-open]');
  await page.click('[data-rv-open]');
  await page.waitForSelector('.rv-pick li[data-q]');
  assert.equal(await page.locator('.rv-pick li[data-q]').count(), 2);

  // The chat panel names the ticket and the PR once each, opening here with ↗ to Jira or
  // GitHub, and offers no next step while the chat is working.
  const ctx = await page.evaluate(() => {
    Object.assign(chat, { items: ['issue:OPS-1', 'pr:acme/api#1'], title: 'OPS-1 · Rotate certs', turns: 2, stop: true });
    drawCtx();
    const el = document.querySelector('#chat-ctx');
    return { text: el.innerText, next: !!el.querySelector('.next'), here: el.querySelectorAll('[data-open-key]').length, ext: el.querySelectorAll('a.ext').length };
  });
  assert.equal(ctx.text.match(/OPS-1/g).length, 1, ctx.text);
  assert.match(ctx.text, /acme\/api#1/);
  assert.match(ctx.text, /chat working/);
  assert.deepEqual([ctx.next, ctx.here, ctx.ext], [false, 2, 2]);
  await page.evaluate(() => { Object.assign(chat, { items: [], title: null, turns: 0, stop: null }); drawCtx(); });

  // Stand-up: "Say this" asks Copilot (the fake one echoes the prompt) and shows its text.
  await page.goto(`${base}/#standup`);
  await page.waitForSelector('[data-say="go"]', { timeout: 15_000 });
  await page.click('[data-say="go"]');
  await page.waitForSelector('#su-say p', { timeout: 15_000 });
  assert.match(await page.locator('#su-say').innerText(), /stand-up/i);
  assert.ok(await page.locator('[data-say="copy"]').isVisible());
  // Only real ticket keys become Jira links: not standards, not branch names.
  const refs = await page.evaluate(() => [...new DOMParser().parseFromString(linkify('ABC-1 RFC-9457 ABC-2-fix x/ABC-3 OPS-4 acme/api#5', 'https://j', { projects: ['ABC'], shortRepo: true }), 'text/html').querySelectorAll('a')].map((a) => a.textContent));
  assert.deepEqual(refs, ['ABC-1', 'api#5']);
  assert.ok(await page.locator('#su-body details.su-more').count() <= 1);

  // School week: Monday to Friday, each class labelled and in its own colour; › moves a week.
  const wk = await page.evaluate(() => {
    const mon = mondayOf(new Date()), at = (d, h) => new Date(+mon + d * 864e5 + h * 36e5).toISOString();
    const evs = [
      { who: '3. trinn', what: 'Gym', start: at(1, 9), end: at(1, 10), allDay: false, kind: 'activity', read: { src: 'flyt', key: 'm1' } },
      { who: 'SFO', what: 'Tur', start: at(1, 0), end: at(2, 0), allDay: true, read: { src: 'flyt', key: 'm2' } },
      { who: '7. trinn', what: 'Prøve', start: at(3, 8), end: at(3, 9), allDay: false, read: { src: 'flyt', key: 'm3' } },
    ];
    document.body.insertAdjacentHTML('beforeend', '<div id="wk-t"></div>');
    weekAt.t = +mon;
    drawWeek('t', evs);
    const el = document.getElementById('wk-t');
    const r = { days: el.querySelectorAll('.wk-day').length, evs: el.querySelectorAll('.wk-ev').length, legend: [...el.querySelectorAll('.wk-leg')].map((x) => x.textContent),
      colors: new Set([...el.querySelectorAll('.wk-ev')].map((x) => x.style.getPropertyValue('--c'))).size, tue: el.querySelectorAll('.wk-day')[1].innerText };
    r.isoWeeks = ['2026-10-26', '2025-12-29', '2027-01-01'].map((d) => weekNo(new Date(`${d}T12:00`)));
    el.querySelector('[data-step="1"]').click();
    r.next = el.querySelectorAll('.wk-ev').length;
    el.remove();
    return r;
  });
  assert.deepEqual([wk.days, wk.evs, wk.colors, wk.next], [5, 3, 3, 0]);
  assert.deepEqual(wk.legend, ['3. trinn', '7. trinn', 'SFO']);
  assert.deepEqual(wk.isoWeeks, [44, 1, 53]);
  assert.match(wk.tue, /SFO[\s\S]*Tur[\s\S]*3\. trinn[\s\S]*09:00/);

  for (const view of ['calendar', 'standup', 'notifications', 'reviews', 'prs', 'tickets']) {
    await page.goto(`${base}/#${view}`);
    await page.waitForTimeout(400);
  }

  // Settings → Plugins: one list with Clearsky's own and the plugins alike, a page for each; old addresses still land there.
  await page.goto(`${base}/settings#plugins`);
  await page.waitForSelector('#plugs a.pl[href="#plugins/github"]');
  assert.ok(await page.locator('#plugs a.pl[href="#plugins/slack-mcp"]').count(), 'Slack is in the same list as GitHub');
  await page.click('#plugs a.pl[href="#plugins/github"]');
  await page.waitForSelector('.pp[data-plugin="github"]:not([hidden]) #GITHUB_ORGS + .ed');
  assert.equal(await page.locator('#plug-list').isHidden(), true);
  // A list is edited as a list: a row per item, saved as the settings file keeps it.
  const orgs = page.locator('#GITHUB_ORGS + .ed');
  await orgs.locator('.ed-add').click();
  await page.keyboard.type('acme-labs');
  await page.keyboard.press('Enter');
  await page.keyboard.type('acme-web');
  assert.equal(await page.locator('#GITHUB_ORGS').inputValue(), 'acme, acme-labs, acme-web');
  await orgs.locator('.ed-row').first().locator('.ed-x').click();
  assert.equal(await page.locator('#GITHUB_ORGS').inputValue(), 'acme-labs, acme-web');
  await page.goto(`${base}/settings#extra`);
  await page.waitForFunction(() => location.hash === '#plugins' && !document.querySelector('#plug-list').hidden);

  // Settings → Copilot: defaults for new chats, with Copilot's own choices; a saved default is used by a new chat.
  await page.goto(`${base}/settings#copilot`);
  await page.waitForSelector('#COPILOT_PERMISSION option[value="full"]', { state: 'attached' });
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/settings.png` });
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

  // Starting Copilot on a PR with a skill: the start box asks for anything to add, with that
  // skill picked; Enter starts it, and the chat gets the skill and your words.
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');
  await page.locator('#list li.r', { hasText: 'ABC-5' }).first().hover();
  await page.locator('#list li.r', { hasText: 'ABC-5' }).first().locator('button.ask').click();
  await page.waitForSelector('.menu [data-run="standup"]');
  await page.click('.menu [data-run="standup"]');
  await page.waitForSelector('#start-dlg[open] #sd-text');
  assert.equal(await page.locator('#sd-skill').inputValue(), 'standup');
  assert.match(await page.locator('#start-dlg').innerText(), /Start Copilot on api#1/);
  // 🎤 in the box: what you say lands in it.
  await page.click('#start-dlg .talk-mic');
  await page.waitForFunction(() => document.querySelector('#sd-text').value === 'only the backend part');
  await page.click('#start-dlg .talk-mic');
  await page.waitForFunction(() => document.querySelector('#start-dlg .talk-mic').getAttribute('aria-pressed') === 'false');
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/start-box.png` });
  await page.press('#sd-text', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#start-dlg[open]'));
  await page.waitForFunction(() => /only the backend part/.test(document.querySelector('#chat-log').innerText), null, { timeout: 10_000 });
  assert.match(await page.locator('#chat-log .msg.me').last().innerText(), /\/standup only the backend part/);
  // Esc cancels: no chat starts.
  await page.goto(`${base}/#inbox`);
  await page.waitForSelector('#list li.r');
  await page.locator('#list li.r', { hasText: 'ABC-5' }).first().hover();
  await page.locator('#list li.r', { hasText: 'ABC-5' }).first().locator('button.ask').click();
  await page.click('.menu [data-run="standup"]');
  await page.waitForSelector('#start-dlg[open]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#start-dlg[open]'));
  assert.ok(await page.locator('#chat').isHidden(), 'no chat opens');

  // Copilot suggests a note for its memory: a card, saved only when you press Save, then in Settings.
  await page.goto(`${base}/#copilot`);
  await page.selectOption('#cp-perm', 'full');
  await page.fill('#chat-text', 'remember this');
  await page.press('#chat-text', 'Enter');
  await page.waitForSelector('.remember [data-remember="save"]', { timeout: 10_000 });
  assert.match(await page.locator('.remember').innerText(), /acme\/api[\s\S]*Run the tests with npm test/);
  assert.match(await page.locator('#chat-log').innerText(), /memory\/memory\.md/, 'the chat was told where its memory is');
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/remember.png` });
  await page.click('.remember [data-remember="save"]');
  await page.waitForSelector('.remember .remember-done', { timeout: 5000 });
  assert.equal(await page.locator('.remember .remember-done').innerText(), 'Saved to memory');
  await page.goto(`${base}/settings#copilot`);
  await page.waitForFunction(() => /## acme\/api\n- Run the tests with npm test/.test(document.querySelector('#memory-text').value), null, { timeout: 5000 });
  if (process.env.SHOT) { await page.locator('#memory-text').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOT}/memory-settings.png` }); }

  for (const w of [390, 360]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(base);
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scrolling at ${w}px`);
  }
  assert.deepEqual(errors, []);
});
