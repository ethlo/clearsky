// Hand-offs: work one chat leaves for another, started in the background when its turn comes.
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logEvent } from '../event-log.mjs';
import { isDemo } from '../demo.mjs';
import { readHandoffs, saveHandoffs, nextHandoff, settleAfterRestart, handoffPrompt, handoffResult, updateHandoff } from '../handoff.mjs';
import { srtInstalled } from '../doctor.mjs';
import { userEnvFile, config } from './config.mjs';
import { copilotInfo } from './chat-env.mjs';

// Hand-offs (lib/handoff.mjs): one at a time, each an ordinary Copilot chat in the sandbox,
// started the way the page starts one (a POST to /api/copilot on this server), so it gets the
// same folders, worktree, sandbox and doors.
export const handoffFile = () => join(dirname(userEnvFile), 'handoffs.json');
export const handoffs = { running: null, timer: null };
function changeHandoff(id, patch) { saveHandoffs(handoffFile(), updateHandoff(readHandoffs(handoffFile()), id, patch)); }

async function handoffCheck(csrf) {
  if (handoffs.running) return;
  const h = nextHandoff(readHandoffs(handoffFile()));
  if (!h) return;
  handoffs.running = h.id;
  // The demo has no real Copilot or sandbox: it acts one out, so a hand-off can be shown.
  if (isDemo()) {
    changeHandoff(h.id, { status: 'working', startedAt: new Date().toISOString(), note: '' });
    setTimeout(() => { changeHandoff(h.id, { status: 'done', endedAt: new Date().toISOString(), pr: 'https://github.com/acme/payments-api/pull/479', note: 'Demo data: a real hand-off ends with its own draft PR.' }); handoffs.running = null; }, 8000);
    return;
  }
  try {
    const info = await copilotInfo();
    if (!info.available) throw new Error('GitHub Copilot CLI not found');
    if (!(await srtInstalled())) throw new Error('hand-offs run only in the sandbox: install srt (see the welcome page)');
    changeHandoff(h.id, { status: 'working', startedAt: new Date().toISOString(), note: '' });
    logEvent(`hand-off started: ${h.label}`);
    const res = await fetch(`http://127.0.0.1:${config.port}/api/copilot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clearsky-Token': csrf },
      body: JSON.stringify({ session: `handoff-${h.id}-${randomBytes(4).toString('hex')}`, refs: [h.ref], permission: 'sandboxed',
        model: process.env.AGENT_MODEL || undefined, effort: process.env.AGENT_EFFORT || undefined,
        message: handoffPrompt(h, { skills: (info.skills || []).map((x) => x.name) }) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    // Follow the answer as it streams: its chat, when it waits for an OK, and its last words.
    let text = '', buf = '', failed = null;
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'session') changeHandoff(h.id, { session: e.id });
        else if (e.type === 'cwd') changeHandoff(h.id, { cwd: e.cwd });
        else if (e.type === 'text') text += e.text || '';
        else if (e.type === 'tool') text += '\n';
        else if (e.type === 'permission') changeHandoff(h.id, { status: 'needs-you', note: 'Waiting for your OK in the chat.' });
        else if (e.type === 'permission-done') changeHandoff(h.id, { status: 'working', note: '' });
        else if (e.type === 'error') failed = e.message;
      }
    }
    const r = failed && !text.trim() ? { status: 'failed', pr: null, note: failed } : handoffResult(text);
    changeHandoff(h.id, { ...r, endedAt: new Date().toISOString() });
    logEvent(`hand-off ${r.status}: ${h.label}${r.pr ? ` (${r.pr})` : ''}`);
  } catch (e) {
    changeHandoff(h.id, { status: 'failed', note: e.message, endedAt: new Date().toISOString() });
  } finally {
    handoffs.running = null;
  }
}
export function startHandoffs(csrf) {
  saveHandoffs(handoffFile(), settleAfterRestart(readHandoffs(handoffFile())));
  handoffs.check = () => handoffCheck(csrf).catch((e) => logEvent(`hand-off error: ${e.message}`));
  handoffs.timer = setInterval(handoffs.check, 30_000);
  handoffs.timer.unref();
}
