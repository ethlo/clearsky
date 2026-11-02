// The demo's throw-away home folder, made once by run.mjs and handed on to Clearsky and the
// fake Copilot through CLEARSKY_DEMO_HOME. Imported first, so the paths in chat.mjs can use it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CLEARSKY_DEMO_HOME) process.env.CLEARSKY_DEMO_HOME = mkdtempSync(join(tmpdir(), 'clearsky-demo-'));
export const HOME = process.env.CLEARSKY_DEMO_HOME;
