// Scheduled chats (lib/schedules.mjs): every minute, start the ones that are due. Each run is
// a new chat in the sandbox, started the way the page starts one (a POST to /api/copilot on this
// server), like hand-offs, so it gets the same folders, worktree, sandbox and doors.
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logEvent } from '../event-log.mjs';
import { isDemo } from '../demo.mjs';
import { readSchedules, saveSchedules, updateSchedule, dueNow, noteRun, schedulePrompt } from '../schedules.mjs';
import { srtInstalled } from '../doctor.mjs';
import { userEnvFile, config } from './config.mjs';
import { copilotInfo } from './chat-env.mjs';

export const scheduleFile = () => join(dirname(userEnvFile), 'schedules.json');
export const schedules = { running: new Set(), timer: null, run: null };

// Change one schedule's newest run (or the schedule) on disk, read fresh: the page may have
// changed the list meanwhile.
function changeRun(id, at, patch) {
  const list = readSchedules(scheduleFile()).map((s) => (s.id !== id ? s : { ...s, runs: (s.runs || []).map((r) => (r.at === at ? { ...r, ...patch } : r)) }));
  saveSchedules(scheduleFile(), list);
}

export async function runSchedule(csrf, s, { now = new Date() } = {}) {
  if (schedules.running.has(s.id)) return;
  schedules.running.add(s.id);
  const at = now.toISOString();
  saveSchedules(scheduleFile(), readSchedules(scheduleFile()).map((x) => (x.id === s.id ? noteRun(x, { at, status: 'working' }) : x)));
  try {
    const info = await copilotInfo();
    if (!info.available) throw new Error('the agent CLI isn’t found');
    if (!isDemo() && !(await srtInstalled())) throw new Error('scheduled chats run only in the sandbox: install srt (see the welcome page)');
    logEvent(`schedule started: ${s.name}`);
    const res = await fetch(`http://127.0.0.1:${config.port}/api/copilot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clearsky-Token': csrf },
      body: JSON.stringify({ session: `sched-${s.id}-${randomBytes(4).toString('hex')}`, permission: isDemo() ? 'ask' : 'sandboxed', ...(s.cwd ? { cwd: s.cwd } : {}),
        model: process.env.AGENT_MODEL || undefined, effort: process.env.AGENT_EFFORT || undefined, message: schedulePrompt(s, now) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    let text = '', buf = '', failed = null;
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'session') changeRun(s.id, at, { session: e.id });
        else if (e.type === 'cwd') changeRun(s.id, at, { cwd: e.cwd });
        else if (e.type === 'text') text += e.text || '';
        else if (e.type === 'tool') text = '';
        else if (e.type === 'permission') changeRun(s.id, at, { status: 'needs-you' });
        else if (e.type === 'permission-done') changeRun(s.id, at, { status: 'working' });
        else if (e.type === 'error') failed = e.message;
      }
    }
    const said = text.trim().replace(/\s+/g, ' ').slice(0, 400);
    changeRun(s.id, at, failed && !said ? { status: 'failed', note: failed, endedAt: new Date().toISOString() } : { status: 'done', note: said, endedAt: new Date().toISOString() });
    logEvent(`schedule ${failed && !said ? 'failed' : 'done'}: ${s.name}`);
  } catch (e) {
    changeRun(s.id, at, { status: 'failed', note: e.message, endedAt: new Date().toISOString() });
  } finally {
    schedules.running.delete(s.id);
  }
}

function check(csrf, now = Date.now()) {
  for (const s of readSchedules(scheduleFile())) {
    const due = dueNow(s, now);
    if (due === 'skip') {
      saveSchedules(scheduleFile(), updateSchedule(readSchedules(scheduleFile()), s.id, noteRun(s, { at: new Date(now).toISOString(), status: 'missed', note: 'Clearsky wasn’t running at the time.' })));
    } else if (due === 'run') runSchedule(csrf, s).catch((e) => logEvent(`schedule error: ${e.message}`));
  }
}

export function startSchedules(csrf) {
  // Runs a restart cut short are over.
  const list = readSchedules(scheduleFile());
  if (list.some((s) => s.runs?.[0]?.status === 'working' || s.runs?.[0]?.status === 'needs-you')) {
    saveSchedules(scheduleFile(), list.map((s) => (['working', 'needs-you'].includes(s.runs?.[0]?.status) ? { ...s, runs: [{ ...s.runs[0], status: 'stopped', note: 'Cut short by a restart; its chat is in History.' }, ...s.runs.slice(1)] } : s)));
  }
  schedules.run = (s) => runSchedule(csrf, s);
  schedules.timer = setInterval(() => check(csrf), 60_000);
  schedules.timer.unref();
}
