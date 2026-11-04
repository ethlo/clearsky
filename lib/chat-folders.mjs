// Folders added to one chat (from its side panel), on top of Settings → Copilot's folders: the
// chat may read and change files there, and its doors (review, vm, outside) open there too.
// Only real folders in your home, never your home itself, a hidden folder at its top (config,
// keys, browser profiles) or a secret the sandbox hides.

import { resolve, sep } from 'node:path';
import { statSync, realpathSync } from 'node:fs';
import { SECRETS } from './sandbox.mjs';

export function checkFolder(input, home, { isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } }, real = (p) => { try { return realpathSync(p); } catch { return p; } } } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Say which folder.' };
  const abs = resolve(raw.replace(/^~(?=\/|$)/, home));
  if (!isDir(abs)) return { error: `${raw} isn't a folder on this machine.` };
  const path = real(abs), h = real(home);
  if (path === h || !path.startsWith(`${h}${sep}`)) return { error: 'Only a folder inside your home, not your home itself.' };
  const top = path.slice(h.length + 1).split(sep)[0];
  if (top.startsWith('.')) return { error: `${raw} is a hidden folder (settings, keys or logins live there).` };
  const secret = SECRETS.map((s) => resolve(s.replace(/^~(?=\/|$)/, h))).find((s) => path === s || path.startsWith(`${s}${sep}`) || s.startsWith(`${path}${sep}`));
  if (secret) return { error: `${raw} holds something the sandbox keeps hidden.` };
  return { path };
}
