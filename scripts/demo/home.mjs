// The demo's throw-away home folder, made once by run.mjs and handed on to Clearsky and the
// fake Copilot through CLEARSKY_DEMO_HOME. Imported first, so the paths in chat.mjs can use it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// MADE: this run made the folder, so it may remove it when the demo stops (never one you gave it).
export const MADE = !process.env.CLEARSKY_DEMO_HOME;
if (MADE) process.env.CLEARSKY_DEMO_HOME = mkdtempSync(join(tmpdir(), 'clearsky-demo-'));
export const HOME = process.env.CLEARSKY_DEMO_HOME;
