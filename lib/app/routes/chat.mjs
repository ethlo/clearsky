// Routes for chats: starting and stopping a turn, answering its questions, its folders, files,
// jobs and VM, the list of chats, memory and hand-offs.
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as localState from '../../state.mjs';
import * as copilot from '../../copilot.mjs';
import { sessionUsage } from '../../copilot-events.mjs';
import { branchesFor } from '../../branches.mjs';
import { vmSupport, vmsLoad } from '../../vm.mjs';
import { pruneMirror } from '../../registry-mirror.mjs';
import { jobView, tailOf } from '../../jobs.mjs';
import { logWrite, readWrites } from '../../agent-log.mjs';
import { checkFolder } from '../../chat-folders.mjs';
import { checkFileRef, findFiles, fileRefLine } from '../../file-refs.mjs';
import * as memory from '../../memory.mjs';
import * as checkpoints from '../../checkpoints.mjs';
import { allCreditRecords, creditTotals, costRates, costOf, liveRate } from '../../credit-usage.mjs';
import { disclosureLine } from '../../disclosure.mjs';
import { buildMap } from '../../map.mjs';
import { isDemo } from '../../demo.mjs';
import { NEW_TASK_HINT, cleanNewTask, newTaskPrompt } from '../../new-task.mjs';
import { untilde } from '../../util.mjs';
import { AGENTS } from '../../agents.mjs';
import { readHandoffs, saveHandoffs, addHandoff, updateHandoff } from '../../handoff.mjs';
import { srtInstalled } from '../../doctor.mjs';
import { stateFile, agentLogFile, agentFilesFile, list, backend } from '../config.mjs';
import { jiraModule } from '../services.mjs';
import { sessionAgent, copilotCwd, copilotInfo, copilotTmp, acpChats, folderNotes, chatFolders, chatReadRoots, chatRepos, tildeHome, sessionsCache, forgetSessions, codeDirs, findCheckout, worktreeFor, prBranch, isDir, copilotFolders, defaultPermission } from '../chat-env.mjs';
import { CONTEXT_INTRO, UPDATE_INTRO, PR_HINT, trackerHints, CHOICES_HINT, memoryHint, foldersHint, sandboxHintFor, MSG_MARK, REFS_INTRO, referenceText, validRefs, copilotContext } from '../chat-hints.mjs';
import { vmsOverview, IMAGE_CACHE_DIR, imageCacheView } from '../chat-builds.mjs';
import { copilotCommands, hintOwed, stopCopilot, jobs, watchdog, readFx, chatCredits, acpTurn, attachCopilot } from '../chat.mjs';
import { copilotSessions, ticketPr, itemSessionName, copilotLinks, refKey, copilotHistory, cachedHistories } from '../chat-sessions.mjs';
import { safeName, isStaged, keepAttachment, chatFile, fileDiff, chatOutputs } from '../chat-outputs.mjs';
import { handoffFile, handoffs } from '../handoffs.mjs';
import { readJson, sendFile, json, NEXT } from '../http.mjs';

// Changes: POST only, and the server has checked the page's token before it asks here.
export async function post({ req, res, url }) {
  // End a chat's Copilot. Its conversation stays; the next message resumes it in a new one.
  if (url.pathname === '/api/copilot/close') {
    const { chat } = await readJson(req);
    const c = acpChats.get(String(chat || ''));
    if (c) { stopCopilot(String(chat)); jobs.stopChat(String(chat)); watchdog.forget(String(chat)); c.agent.close(); c.vm?.stop(); acpChats.delete(String(chat)); }
    return json(res, 200, { closed: !!c });
  }
  // The VMs view's Purge: the image cache emptied (a pull running now still finishes).
  if (url.pathname === '/api/vms/image-cache/purge') {
    if (isDemo()) return json(res, 200, { removed: 0, freed: 0 });
    const r = pruneMirror(IMAGE_CACHE_DIR, { all: true });
    return json(res, 200, { ...r, imageCache: imageCacheView(true) });
  }
  if (url.pathname === '/api/vm/stop') {
    const { chat } = await readJson(req);
    const vm = acpChats.get(String(chat || ''))?.vm;
    if (vm && (vm.state !== 'off' || vm.queue?.().position)) { vm.event('Stopped from Clearsky'); vm.stop(); }
    return json(res, 200, { stopped: !!vm });
  }
  // A background job stopped from the chat's side panel.
  if (url.pathname === '/api/copilot/jobs/stop') {
    const { chat, id } = await readJson(req);
    return json(res, 200, { stopped: jobs.stop(String(id || ''), String(chat || '')) });
  }
  // The watchdog paused (or on again) for one chat.
  if (url.pathname === '/api/copilot/watchdog') {
    const { chat, paused } = await readJson(req);
    if (!/^[\w-]{8,64}$/.test(String(chat || ''))) return json(res, 400, { error: 'bad chat' });
    watchdog.pause(String(chat), paused === true);
    return json(res, 200, { watchdog: watchdog.view(String(chat)) });
  }
  if (url.pathname === '/api/copilot/stop') {
    const { chat } = await readJson(req);
    return json(res, 200, { stopped: stopCopilot(String(chat || '')) });
  }
  // Your own name for a Copilot session; it wins over the title Copilot gave it.
  // A folder added to (or taken off) one chat, from its side panel. Its Copilot starts again
  // with it on the next message, resuming the same session.
  if (url.pathname === '/api/copilot/folders') {
    const { chat: id, add, remove } = await readJson(req);
    if (!/^[\w-]{8,64}$/.test(String(id || ''))) return json(res, 400, { error: 'bad chat' });
    let list = localState.sessionFolders(stateFile)[id] || [];
    if (add) {
      const r = checkFolder(add, homedir());
      if (r.error) return json(res, 400, { error: r.error });
      if (!list.includes(r.path)) {
        list = [...list, r.path];
        folderNotes.set(id, `I added ${r.path.replace(homedir(), '~')} to this chat: you can read and change files there now, and review, vm and outside work there too.`);
      }
    }
    if (remove) list = list.filter((f) => f !== untilde(remove));
    localState.setSessionFolders(stateFile, id, list);
    return json(res, 200, { folders: list.map((f) => f.replace(homedir(), '~')) });
  }
  if (url.pathname === '/api/copilot/rename') {
    const { id, title } = await readJson(req);
    if (!/^[\w-]{8,64}$/.test(String(id || '')) || typeof title !== 'string' || !title.trim()) return json(res, 400, { error: 'bad session or title' });
    localState.setSessionName(stateFile, id, title.trim().split('\n')[0]);
    forgetSessions();
    return json(res, 200, { ok: true });
  }
  // Rewind: put a chat's files back to how they were before one of your messages.
  if (url.pathname === '/api/copilot/rewind') {
    const { chat, id } = await readJson(req);
    if (!/^[\w-]{8,64}$/.test(String(chat || '')) || !/^[0-9a-f]{12}$/.test(String(id || ''))) return json(res, 400, { error: 'bad chat or checkpoint' });
    if (acpChats.get(chat)?.busy) return json(res, 409, { error: 'The chat is working. Stop it first, then rewind.' });
    try { return json(res, 200, await checkpoints.rewind(chat, id)); } catch (e) { return json(res, 400, { error: e.message.split('\n')[0] }); }
  }
  if (url.pathname === '/api/copilot/permission') {
    const { chat, id, option, values } = await readJson(req);
    const waiting = acpChats.get(chat)?.waiting;
    const resolve = waiting?.get(id);
    if (!resolve) return json(res, 404, { error: 'that question has already been answered or expired' });
    waiting.delete(id);
    // What you picked in a card's fields (a new ticket's project and fix version): short strings only.
    const picked = values && typeof values === 'object' && !Array.isArray(values)
      ? Object.fromEntries(Object.entries(values).filter(([k, v]) => /^\w{1,32}$/.test(k) && typeof v === 'string' && v.length <= 200).slice(0, 8)) : undefined;
    resolve(option ? { outcome: 'selected', optionId: String(option), ...(picked ? { values: picked } : {}) } : { outcome: 'cancelled' });
    return json(res, 200, { ok: true });
  }
  // A file you drop on the chat: kept where the chat can read it, named in your next message.
  if (url.pathname === '/api/copilot/attach') {
    const name = safeName(url.searchParams.get('name') || 'file');
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 25 * 1024 * 1024) return json(res, 413, { error: 'at most 25 MB' }); chunks.push(ch); }
    const dir = join(copilotTmp(), 'attachments', randomBytes(6).toString('hex'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
    return json(res, 200, { path, name, size });
  }
  if (url.pathname === '/api/copilot') {
    const body = await readJson(req);
    const info = await copilotInfo();
    if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found; install it or set COPILOT_BIN' });
    // Files you attached (uploaded first to /api/copilot/attach): named at the end of the message.
    const attached = (Array.isArray(body.attachments) ? body.attachments : []).map(String).filter((pth) => isStaged(pth)).slice(0, 10);
    // Files on disk you pointed at with @: only their paths go in, Copilot reads them itself.
    const pointRoots = chatReadRoots(body.session, body.cwd && isDir(body.cwd) ? body.cwd : null);
    const pointed = [];
    for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, 20)) {
      const r = checkFileRef(f, { roots: pointRoots, home: homedir(), cwd: body.cwd });
      if (r.error) return json(res, 400, { error: r.error });
      if (!pointed.some((x) => x.path === r.path)) pointed.push(r);
    }
    const tail = [attached.length && `Files I attached: ${attached.join(', ')}`, fileRefLine(pointed, homedir())].filter(Boolean).join('\n');
    // A new task from another chat's card (lib/new-task.mjs): its hand-off, and how to start.
    const task = !body.resume && cleanNewTask(body.newTask);
    const typed = String(body.message || '').slice(0, 20_000);
    const message = `${task ? newTaskPrompt(task, typed, { skills: (info.skills || []).map((x) => x.name) }) : typed}${tail ? `\n\n${tail}` : ''}`;
    if (!message.trim()) return json(res, 400, { error: 'empty message' });
    if (!copilot.validModel(body.model)) return json(res, 400, { error: 'bad model name' });
    if (!body.session || !/^[\w-]{8,64}$/.test(body.session)) return json(res, 400, { error: 'bad session' });
    const refs = validRefs(body.refs);
    // A new chat about a PR runs in your clone of that repository, when there is one.
    // A chat about a PR or GitHub issue runs in your clone of its repo; one about a ticket, in
    // the clone of the PR that carries its key (in the PR's title or branch), if there is one.
    const repoRef = !body.resume && !body.cwd && (refs.find((r) => r.kind === 'pr' || r.kind === 'gh') || ticketPr(refs.find((r) => r.kind === 'issue')));
    let clone = repoRef ? findCheckout(repoRef.repo) : null;
    let checkout = clone && (worktreeFor(clone, prBranch(repoRef)) || clone);
    // A ticket with no PR yet: the clone (and worktree) of a branch that carries its key.
    const ticket = !checkout && !body.resume && !body.cwd && refs.find((r) => r.kind === 'issue');
    if (ticket) {
      const found = (await branchesFor([ticket.key], codeDirs()).catch(() => ({})))[ticket.key] || [];
      const b = found.find((x) => x.local) || found[0];
      if (b) checkout = worktreeFor(b.clone, b.branch) || b.clone;
    }
    // A new task names its repository: its clone, when the ticket gave none.
    if (!checkout && task?.repo && !body.cwd) checkout = findCheckout(task.repo);
    // A PR or ticket chat with no clone found starts in your first folder (Settings → Agent).
    const cwd = checkout || (body.cwd && isDir(body.cwd) ? body.cwd : (refs.length && !body.resume && copilotFolders().map((d) => untilde(d)).find(isDir)) || copilotCwd());
    let refText = '';
    if (refs.length) {
      const parts = await Promise.all(refs.map((r) => referenceText(r).catch((e) => `## ${r.key || `${r.repo}#${r.number}`}\n(couldn't load: ${e.message})`)));
      refText = `${REFS_INTRO}\n\n${parts.join('\n\n')}`;
    }
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    if (body.permission === 'assisted') body.permission = 'sandboxed'; // Assisted is gone: the sandbox does its job
    // No mode given: the default (Settings → Agent, else Sandboxed where it can run). One it doesn't know: Ask.
    if (!body.permission) body.permission = defaultPermission();
    const options = { model: body.model, effort: body.effort, permission: copilot.PERMISSIONS[body.permission] ? body.permission : 'ask',
      allow: list(body.allow), deny: list(body.deny) };
    // The first turn carries the dashboard so Copilot knows what you're looking at.
    const sandboxHint = sandboxHintFor(body.permission);
    const folders = foldersHint();
    // A Copilot command (/compact, say) only works as the whole message: nothing goes in front.
    // The sandbox hint a resumed chat is owed then goes with the next message instead.
    const command = /^\/(compact|clear|context|usage|model)\b/.test(message.trim());
    const owed = body.resume && sandboxHint && (!acpChats.has(body.session) || hintOwed.has(body.session));
    if (command) { if (owed) hintOwed.add(body.session); } else hintOwed.delete(body.session);
    // Folders you added to this chat since its last message: say so once.
    const note = !command && folderNotes.get(body.session);
    if (note) folderNotes.delete(body.session);
    const update = !command && (owed || note) && `${UPDATE_INTRO}${owed ? sandboxHint : ''}${note ? `\n\n${note}` : ''}`;
    const prefix = command ? '' : [update, !body.resume && `${CONTEXT_INTRO}\n\n${copilotContext()}\n\n${CHOICES_HINT}\n\n${NEW_TASK_HINT}\n\n${memoryHint()}\n\n${PR_HINT}\n\n${trackerHints()}${folders && `\n\n${folders}`}${sandboxHint}`, refText].filter(Boolean).join('\n\n---\n\n');
    const prompt = prefix ? `${prefix}${MSG_MARK}${message}` : message;
    // Answers stream back as one JSON event per line: text, tool, permission, done, error.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    let sessionId = body.session;
    const emit = (e) => {
      e.at ??= Date.now(); // when it happened, shown on each line in the chat
      if (e.type === 'session') { sessionId = e.id; linkRefs(); }
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
    };
    // A new chat about one item is named after it. (Copilot 1.0.105 ignores /rename over ACP, so the name lives here.)
    const named1 = !body.resume && refs.length === 1 ? itemSessionName(refs[0]) : null;
    // A new task is named after its card when Jira doesn't know the ticket yet (or it has none).
    const itemName = task?.title && !named1?.includes(' · ') ? [named1, task.title !== named1 && task.title].filter(Boolean).join(' · ').slice(0, 100) : named1;
    // Remember which PRs and tickets this session is about, for the links on the page.
    const kept = new Set();
    const linkRefs = () => {
      for (const pth of attached) if (!kept.has(`${sessionId}|${pth}`)) { kept.add(`${sessionId}|${pth}`); keepAttachment(sessionId, pth); }
      for (const f of pointed) if (!f.dir && !kept.has(`${sessionId}|${f.path}`)) { kept.add(`${sessionId}|${f.path}`); logWrite(agentFilesFile, { where: 'file', what: f.path, kind: 'pointed', chats: [{ id: sessionId }], decided: 'done' }); }
      if (refs.length) localState.addSessionRefs(stateFile, sessionId, refs.map(refKey));
      if (prefix && !body.resume) localState.setSessionTitle(stateFile, sessionId, message.trim().split('\n')[0]);
      if (itemName) localState.setSessionName(stateFile, sessionId, itemName);
    };
    res.on('close', linkRefs);
    if (cwd !== (body.cwd || copilotCwd())) emit({ type: 'cwd', cwd });
    if (itemName) emit({ type: 'title', title: itemName });
    forgetSessions();
    try {
      const named = [...String(message).matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)].map((m) => ({ kind: 'issue', key: m[0] }));
      watchdog.userMessage(body.session); // a message from you: a new task, so a fresh count of nudges
      await acpTurn({ chat: body.session, options, prompt, resumeId: body.resume ? body.session : null, cwd, emit, res, bin: info.bin, scope: [...refs, ...named], agent: AGENTS[body.agent] ? body.agent : null, images: attached });
    } catch (e) { emit({ type: 'error', message: e.message }); }
    return res.end();
  }
  // Copilot's memory (lib/memory.mjs): the whole file from Settings, or notes from a card's Save.
  if (url.pathname === '/api/copilot/memory') {
    const body = await readJson(req, 64 * 1024);
    const file = memory.memoryFile();
    const r = typeof body.text === 'string' ? memory.writeMemory(file, body.text)
      : (() => { const a = memory.addNotes(memory.readMemory(file), { lines: Array.isArray(body.lines) ? body.lines.map(String) : [], repo: body.repo });
        return a.error || !a.added ? a : { ...memory.writeMemory(file, a.text), added: a.added }; })();
    if (r.error) return json(res, 400, { error: r.error });
    return json(res, 200, { text: r.text, added: r.added ?? null, max: memory.MAX_BYTES });
  }
  // Hand-offs: add one (now, or from a time such as your next meeting), start one now, cancel.
  if (url.pathname === '/api/handoffs') {
    const body = await readJson(req);
    let list = readHandoffs(handoffFile());
    if (body.action === 'add') {
      const r = addHandoff(list, body.ref, { after: body.after });
      saveHandoffs(handoffFile(), r.list);
      setTimeout(() => handoffs.check?.(), 100);
      return json(res, 200, { handoff: r.handoff, already: r.already, handoffs: r.list });
    }
    const h = list.find((x) => x.id === body.id);
    if (!h) return json(res, 404, { error: 'no such hand-off' });
    if (body.action === 'start' && h.status === 'queued') list = updateHandoff(list, h.id, { after: null });
    else if (body.action === 'retry' && ['failed', 'stopped', 'blocked', 'cancelled'].includes(h.status)) list = updateHandoff(list, h.id, { status: 'queued', after: null, note: '' });
    else if (body.action === 'cancel' && h.status === 'queued') list = updateHandoff(list, h.id, { status: 'cancelled' });
    else if (body.action === 'forget' && !['working', 'needs-you'].includes(h.status)) list = list.filter((x) => x.id !== h.id);
    else return json(res, 400, { error: `can't ${body.action} a hand-off that is ${h.status}` });
    saveHandoffs(handoffFile(), list);
    setTimeout(() => handoffs.check?.(), 100);
    return json(res, 200, { handoffs: list });
  }
  return NEXT;
}

// Reads.
export async function get({ req, res, url }) {
  if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: readHandoffs(handoffFile()), sandbox: isDemo() || await srtInstalled() });
  if (url.pathname === '/api/copilot') return json(res, 200, { ...await copilotInfo(url.searchParams.has('refresh')), commands: copilotCommands });
  // Files and folders for the @ picker: names under the chat's folders, or a path's entries.
  if (url.pathname === '/api/copilot/checkpoints') {
    const id = url.searchParams.get('chat') || '';
    return json(res, 200, { checkpoints: await checkpoints.list(id), busy: !!acpChats.get(id)?.busy });
  }
  if (url.pathname === '/api/copilot/files') {
    const id = url.searchParams.get('chat') || '';
    const cwd = url.searchParams.get('cwd') || '';
    const dir = cwd && isDir(cwd) ? cwd : null;
    return json(res, 200, { files: findFiles(url.searchParams.get('q') || '', { roots: chatReadRoots(id, dir), home: homedir(), cwd: dir || acpChats.get(id)?.cwd || copilotCwd() }) });
  }
  // A chat's background jobs, newest first, and the end of one's output.
  if (url.pathname === '/api/copilot/jobs') {
    const id = url.searchParams.get('chat') || '';
    if (isDemo()) return json(res, 200, (await import('../../../scripts/demo/data.mjs')).jobs(id));
    return json(res, 200, { jobs: jobs.list(id).slice(0, 20).map((j) => jobView(j, { tilde: tildeHome })), watchdog: watchdog.view(id) });
  }
  if (url.pathname === '/api/copilot/job-log') {
    const j = jobs.get(url.searchParams.get('id') || '');
    if (!j || j.chat !== url.searchParams.get('chat')) return json(res, 404, { error: 'no such job' });
    return json(res, 200, { log: tailOf(j.log, 400, 256 * 1024) });
  }
  // What one chat runs with, for the panel beside it.
  if (url.pathname === '/api/copilot/chat') {
    const id = url.searchParams.get('id') || '';
    const c = acpChats.get(id);
    const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
    return json(res, 200, {
      running: !!c && !c.agent.closed, busy: !!c?.busy, sandboxed: c ? !!c.agent.sandboxed : null, hosts: c?.agent.hosts || null, github: c?.agent.github || null,
      cwd: c?.cwd ? tilde(c.cwd) : null,
      folders: copilotFolders().map(tilde), read: list(process.env.AGENT_READ).map(tilde), chatFolders: chatFolders(id).map(tilde),
      sandbox: process.env.AGENT_SANDBOX === 'srt',
      usage: /^[\w-]{8,64}$/.test(id) ? sessionUsage(join(homedir(), '.copilot'), id) : null,
      // What it cost so far, split like the line at the end of a PR (lib/disclosure.mjs).
      credits: /^[\w-]{8,64}$/.test(id) ? (() => { const sp = chatCredits(id, c?.model); return sp.total != null ? { ...sp, line: disclosureLine(sp), cost: costOf(sp.total, costRates(process.env, readFx())) } : null; })() : null,
      // When it last did anything (its log's time), and what it's about: for "start fresh".
      lastAt: /^[\w-]{8,64}$/.test(id) ? (() => { try { return statSync(join(homedir(), '.copilot', 'session-state', id, 'events.jsonl')).mtimeMs; } catch { return null; } })() : null,
      refs: localState.sessionRefs(stateFile)[id] || [],
    });
  }
  // AI credits across all chats (today, this week, this month, all time; by day, week and
  // chat), with what they cost in dollars and your currency (lib/credit-usage.mjs).
  if (url.pathname === '/api/copilot/usage') {
    const home = join(homedir(), '.copilot');
    const t = creditTotals(allCreditRecords(home));
    const env = process.env;
    const live = env.CLEARSKY_FX_LIVE === 'on' ? await liveRate(String(env.CLEARSKY_CURRENCY || '').trim().toUpperCase(), join(homedir(), '.cache', 'clearsky', 'fx.json')) : null;
    const rates = costRates(env, live);
    // Chat names, if Copilot's list is at hand (never waits long for it).
    let names = {};
    try {
      const info = await copilotInfo();
      if (info.available) names = Object.fromEntries((await Promise.race([copilotSessions(info.bin, false), new Promise((r) => setTimeout(() => r([]), 3000))])).map((x) => [x.id, x.title]));
    } catch { /* ids only */ }
    const cost = (n) => costOf(n, rates);
    return json(res, 200, {
      ...t, agent: backend().name, rates, liveFailed: rates.live && !!rates.currency && rates.rateFrom !== 'live',
      cost: { total: cost(t.total), today: cost(t.today), week: cost(t.week), month: cost(t.month) },
      days: t.days.map((d) => ({ ...d, cost: cost(d.credits) })), weeks: t.weeks.map((w) => ({ ...w, cost: cost(w.credits) })),
      chats: t.chats.map((c) => ({ ...c, title: names[c.id] || null, cost: cost(c.credits) })),
    });
  }
  // What Copilot changed as you on GitHub and Jira (all chats, or one).
  // A chat's outputs: files it made, files you attached, and what it changed elsewhere, linked.
  if (url.pathname === '/api/copilot/outputs') {
    const id = url.searchParams.get('chat') || '';
    if (!/^[\w-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad chat' });
    return json(res, 200, await chatOutputs(id));
  }
  if (url.pathname === '/api/copilot/file') {
    const id = url.searchParams.get('chat') || '', pth = url.searchParams.get('path') || '';
    const file = /^[\w-]{8,64}$/.test(id) && chatFile(id, pth);
    if (!file) return json(res, 404, { error: 'not one of this chat\'s files' });
    if (url.searchParams.has('diff')) return json(res, 200, await fileDiff(pth, acpChats.get(id)));
    return sendFile(res, file);
  }
  if (url.pathname === '/api/copilot/memory') {
    const file = memory.memoryFile();
    return json(res, 200, { path: file.replace(homedir(), '~'), text: memory.readMemory(file), max: memory.MAX_BYTES });
  }
  // The map of what chats did where (lib/map.mjs): one chat's, or the recent ones'.
  if (url.pathname === '/api/copilot/map') {
    const chatId = url.searchParams.get('chat') || null;
    const writes = readWrites(agentLogFile, { chat: chatId, limit: 3000 });
    const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
    const refs = localState.sessionRefs(stateFile);
    const scope = (id) => {
      const c = acpChats.get(id), r = refs[id] || [];
      return {
        repos: [...new Set([...(c ? chatRepos(c) : []), ...r.map((k) => k.match(/^(?:pr|gh):([\w.-]+\/[\w.-]+)#/)?.[1]?.toLowerCase()).filter(Boolean)])],
        tickets: [...new Set([...(c?.tickets || []), ...r.filter((k) => k.startsWith('issue:')).map((k) => k.slice(6))])],
      };
    };
    let chats = buildMap(writes, { scope });
    if (chatId && !chats.length) {
      const sc = scope(chatId), n = (kind) => (key) => ({ kind, key, first: null, acts: [], prs: [], branches: [], scope: true });
      const nodes = [...sc.repos.map(n('repo')), ...sc.tickets.map(n('ticket'))];
      if (nodes.length) chats = [{ id: chatId, first: null, at: null, shared: 0, nodes }];
    }
    for (const ch of chats) Object.assign(ch, { title: names[ch.id] || titles.get(ch.id) || null, live: acpChats.has(ch.id) });
    return json(res, 200, { chats: chats.slice(0, 40), jira: jiraModule.site || null });
  }
  if (url.pathname === '/api/agent-log') return json(res, 200, { writes: readWrites(agentLogFile, { chat: url.searchParams.get('chat') || null, limit: Math.min(Number(url.searchParams.get('limit')) || 300, 2000) }) });
  // A chat's VM, for its view: what runs in it, what it can reach, and what happened.
  if (url.pathname === '/api/vm') {
    const vm = acpChats.get(url.searchParams.get('id') || '')?.vm;
    const support = vmSupport();
    if (!vm) return json(res, 200, { vm: null, support });
    await vm.refresh();
    const v = vm.view();
    const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
    return json(res, 200, { vm: { ...v, cwd: tilde(v.cwd), shares: v.shares.map(tilde) }, support });
  }
  // All chats' VMs (the VMs view): who has a place, who waits in line, and what runs in each.
  if (url.pathname === '/api/vms') {
    if (isDemo()) { const d = (await import('../../../scripts/demo/data.mjs')).vms(); return json(res, 200, { ...d, load: vmsLoad(d.vms), support: { ok: true } }); }
    { const d = await vmsOverview({ look: !url.searchParams.has('quick') }); return json(res, 200, { ...d, load: vmsLoad(d.vms), support: vmSupport() }); }
  }
  if (url.pathname === '/api/copilot/sessions') {
    const info = await copilotInfo();
    if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found' });
    // How full each chat's context is (from its log, cached by the file's size and time).
    const full = (x) => { const u = /^[\w-]{8,64}$/.test(x.id) ? sessionUsage(join(homedir(), '.copilot'), x.id) : null; return u?.context != null && u.limit ? { context: u.context, limit: u.limit } : {}; };
    const hot = new Set(cachedHistories());
    return json(res, 200, { cwd: copilotCwd(), sessions: (await copilotSessions(info.bin, url.searchParams.has('refresh'))).map((x) => ({ ...x, ...full(x), cached: hot.has(x.id) })) });
  }
  if (url.pathname === '/api/copilot/links') {
    const info = await copilotInfo();
    if (!info.available) return json(res, 200, { links: {}, live: [] });
    return json(res, 200, await copilotLinks(info.bin));
  }
  const histId = url.pathname.match(/^\/api\/copilot\/sessions\/([\w-]{8,64})$/)?.[1];
  if (histId) {
    const info = await copilotInfo();
    if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found' });
    const cwd = isDir(url.searchParams.get('cwd')) ? url.searchParams.get('cwd') : copilotCwd();
    const c = acpChats.get(histId);
    const busy = !!c?.busy;
    // A chat that only exists in this server so far may not be readable from disk yet.
    const t0 = Date.now();
    const h = await copilotHistory(info.bin, histId, cwd).catch((e) => { if (c || busy) return { messages: [], stamp: null, read: true }; throw e; });
    // How long it took, and whether the agent had to replay the session (the browser's network tab shows it).
    res.setHeader('Server-Timing', `${h.read ? 'agent' : 'cached'};dur=${Date.now() - t0}`);
    const about = { id: histId, agent: c?.agentName || sessionAgent(histId) || backend().name, cwd, home: homedir(), here: !!c, busy, stamp: h.stamp, title: localState.sessionNames(stateFile)[histId] || null };
    // The page already shows this very conversation: just say so, and what's live about it.
    if (h.stamp && url.searchParams.get('have') === h.stamp) return json(res, 200, { ...about, same: true });
    return json(res, 200, { ...about, messages: h.messages });
  }
  const attach = url.pathname.match(/^\/api\/copilot\/sessions\/([\w-]{8,64})\/live$/)?.[1];
  if (attach) return attachCopilot(attach, req, res);
  return NEXT;
}
