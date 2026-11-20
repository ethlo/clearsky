// What the browser is told about Clearsky's own pages and API answers, so a slip elsewhere (a
// title that isn't escaped, a link from a calendar invite) can't turn into code running on the
// page, which holds the token for every change the API makes.
//
// - Only the page's own scripts run: each inline script is named by its hash, so an injected
//   <script>, an on… attribute or a `javascript:` link does nothing.
// - The page loads nothing from other sites, and can't be put in a frame by one (clickjacking:
//   a site drawing its own button over Clearsky's Allow).
// - API answers can't be loaded by other sites as an image or script, and a request another site
//   makes to the API from your browser is refused (`crossSite`).

import { createHash } from 'node:crypto';

const INLINE_SCRIPT = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;

export function contentSecurityPolicy(html) {
  const hashes = [...String(html).matchAll(INLINE_SCRIPT)].map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? [...new Set(hashes)].join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:", // blob: a pasted image's thumbnail, made on the page itself
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const COMMON_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' };

// Headers for one of Clearsky's pages (worked out once per page: the hashes are of its scripts).
export function pageHeaders(html) {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': contentSecurityPolicy(html), 'X-Frame-Options': 'DENY', ...COMMON_HEADERS };
}

// A request to the API that another site made from your browser (an <img>, a form, a fetch):
// browsers say where a request comes from in Sec-Fetch-Site. `same-origin` is the page itself,
// `none` is you typing the address; no header at all is a command line or Clearsky itself.
// Another port on this machine counts as another site too (`same-site`).
export function crossSite(req, pathname) {
  const site = req.headers['sec-fetch-site'];
  return pathname.startsWith('/api/') && !!site && site !== 'same-origin' && site !== 'none';
}

// A link from outside (a calendar invite, a plugin's item) as a web link, or nothing.
export const webUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : null);
