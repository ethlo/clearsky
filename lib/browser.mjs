// The Chromium-based browser to open Clearsky's own windows with (its app window, the school
// login): CLEARSKY_BROWSER, else your default browser when it's one of these, else the first
// one installed.

import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { wslInfo, windowsBrowser, wslOpenCommand } from './wsl.mjs';

export const BROWSERS = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'];
// Default-browser .desktop names (xdg-settings) and the commands they run.
const BY_DESKTOP = [[/^google-chrome/, ['google-chrome-stable', 'google-chrome']], [/chromium/i, ['chromium', 'chromium-browser']],
  [/^brave/, ['brave-browser']], [/^microsoft-edge/, ['microsoft-edge']]];

function defaultDesktop(platform) {
  if (platform !== 'linux') return '';
  try { return execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// windows: under WSL, a Windows browser first (the app window, which you use from Windows).
// Not for the school login: that one talks to the browser's DevTools port, which a Windows
// browser keeps on Windows' side, out of WSL's reach.
export function findBrowser(env = process.env, { platform = process.platform, desktop = defaultDesktop(platform), windows = false,
  wsl = windows ? wslInfo({ platform, env }) : null, winBrowser = windowsBrowser } = {}) {
  if (env.CLEARSKY_BROWSER) return env.CLEARSKY_BROWSER;
  if (windows && wsl?.version === 2) { const w = winBrowser(); if (w) return w; }
  const onPath = (b) => (env.PATH || '').split(delimiter).map((d) => d && join(d, b)).find((p) => p && existsSync(p));
  const preferred = BY_DESKTOP.find(([re]) => re.test(desktop))?.[1] || [];
  for (const b of [...preferred, ...BROWSERS]) { const p = onPath(b); if (p) return p; }
  // Where they install themselves on Linux (snap, flatpak), macOS and Windows.
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const known = ['/snap/bin/chromium', '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    ...['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'].map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`),
    ...pf.flatMap((d) => [join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])];
  return known.find((p) => existsSync(p)) || null;
}

// The command that opens a URL in your default browser, as the desktop does: under WSL, the
// Windows one. Windows' start would read & as a command separator; rundll32 takes the URL as it is.
export function openCommand({ platform = process.platform, env = process.env, wsl = wslInfo({ platform, env }) } = {}) {
  if (platform === 'darwin') return ['open'];
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler'];
  if (wsl) return wslOpenCommand({ env });
  return ['xdg-open'];
}
