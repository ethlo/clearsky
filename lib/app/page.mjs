// The page as it is sent: web/index.html with its styles and scripts put inline, the agent's name
// filled in, and the headers that say what the browser may do with it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDemo } from '../demo.mjs';
import { pageHeaders } from '../page-security.mjs';
import { appDir, backend } from './config.mjs';

// The page: web/index.html with web/css/app.css and web/js/*.js (in name order, one shared
// scope) put inline, so it stays one request and works offline.
// The demo's pages say so: a "Demo data" badge with Leave demo, so nobody takes it for real.
export const demoMark = (html) => (isDemo() ? html.replace('<meta name="theme-color"', '<meta name="demo" content="1">\n<meta name="theme-color"') : html);

export function buildPage(csrf, web = join(appDir, 'web')) {
  const css = readFileSync(join(web, 'css', 'app.css'), 'utf8');
  const js = readdirSync(join(web, 'js')).filter((n) => n.endsWith('.js')).sort()
    .map((n) => readFileSync(join(web, 'js', n), 'utf8')).join('\n');
  return demoMark(readFileSync(join(web, 'index.html'), 'utf8').replace('__CSRF__', csrf)
    .replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js));
}

// Pages name the agent your chats run in ("Copilot", "Claude Code") where they say __AGENT__.
const named = new Map();
const forAgent = (text) => { const k = `${backend().label}\n${text.length}\n${text.slice(0, 64)}`; return named.get(k) || named.set(k, text.replaceAll('__AGENT__', backend().label)).get(k); };
// What the browser may do with each page (lib/page-security.mjs): only its own scripts, no frames.
const htmlHeaders = new Map();
export const html = (res, page) => { const text = forAgent(page); res.writeHead(200, htmlHeaders.get(text) || htmlHeaders.set(text, pageHeaders(text)).get(text)); res.end(text); };
