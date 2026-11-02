const { chromium } = require('playwright');
// Screenshots of the demo (run.mjs) with Playwright: node scripts/demo/screenshots.cjs <port> <out folder>
// DEMO_CWD=<demo home>/dev/acme/payments-api opens the chat in its folder (run.mjs prints the home).
const base = `http://127.0.0.1:${process.argv[2] || 7790}`, out = process.argv[3] || 'screenshots';
require('node:fs').mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: 'Europe/Oslo', colorScheme: 'light', locale: 'en-GB' });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  const shot = async (name) => { await p.evaluate(() => { scrollTo(0, 0); document.querySelectorAll('main, .main, #main').forEach((e) => (e.scrollTop = 0)); }); await p.waitForTimeout(600); await p.screenshot({ path: `${out}/${name}.png` }); console.log('saved', name); };
  await p.goto(`${base}/#inbox`); await p.waitForTimeout(4000); await shot('1-inbox');
  // An item page
  await p.locator('text=PAY-412: Partial refunds for split payments').first().click(); await p.waitForTimeout(2500); await shot('2-item');
  await p.goto(`${base}/#calendar`); await p.waitForTimeout(2500); await shot('3-calendar');
  await p.goto(`${base}/#standup`); await p.waitForTimeout(3500); await shot('4-standup');
  await p.goto(`${base}/#copilot`); await p.waitForTimeout(1500);
  await p.evaluate((c) => openSession('demo-pay412-refunds', c), process.env.DEMO_CWD); await p.waitForTimeout(3500); await shot('5-copilot-chat');
  await p.goto(`${base}/#map`); await p.waitForTimeout(2500); await shot('6-agent-map');
  await p.goto(`${base}/#changes`); await p.waitForTimeout(2000); await shot('7-copilots-changes');
  await p.goto(`${base}/settings`); await p.waitForTimeout(2500); await p.locator('text=Modules').first().click(); await p.waitForTimeout(800); await shot('8-settings');
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.goto(`${base}/#inbox`); await p.waitForTimeout(3500); await shot('9-inbox-dark');
  await b.close();
})();
