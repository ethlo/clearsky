// Plugins as you manage them: the list for Settings → Plugins, a look before adding one, and
// `clearsky add`, `remove`, `update` and `plugins` in a terminal.
import { randomBytes } from 'node:crypto';
import { listPlugins, preparePlugin, removePlugin, checkPlugin, readRegistry, withRef, changesText, catalogEntry, retiredText } from '../plugins.mjs';
import { srtCli } from '../plugin-sandbox.mjs';
import { pluginDirs, plugins } from './config.mjs';
import { BUILTIN_MANIFESTS, moduleManifests } from './work.mjs';
import { teamPlugins } from './setup.mjs';

// Every plugin for Settings → Plugins, all in one list and described the same way: Clearsky's
// own (GitHub, Jira, Calendar, Links), the ones you added, your own files in
// ~/.config/clearsky/sources, and what ships with Clearsky but isn't added. `reach` is what it
// holds and talks to; `ready` is false until its required settings are filled in.
export function pluginList() {
  const { added, available } = listPlugins({ paths: pluginDirs });
  const strip = ({ manifest, ...p }) => ({ ...p, manifest: manifest && { hosts: manifest.hosts, clis: manifest.clis, files: manifest.files, secrets: manifest.secrets, outside: manifest.outside || null, area: manifest.area } });
  const reach = new Map(moduleManifests().map((m) => [m.name, m]));
  const shape = (m) => m && { hosts: m.hosts || [], clis: m.clis || [], files: m.files || [], secrets: m.secrets || [], dbus: !!m.dbus, note: m.note || '', outside: m.outside || null };
  const loaded = (p) => plugins.sources.get(p.name)?.plugin?.from === p.from;
  const all = [
    ...BUILTIN_MANIFESTS.filter((m) => m.name !== 'copilot').map((m) => ({ name: m.name, label: m.label, description: m.description || '', area: m.area,
      kind: 'core', added: true, loaded: true, ready: true, reach: shape(reach.get(m.name)) })),
    ...[...plugins.sources.values()].map((p) => {
      const a = added.find((x) => x.name === p.name);
      let ready = true;
      try { ready = !p.enabled || !!p.enabled(process.env); } catch { ready = false; }
      return { name: p.name, label: p.label, description: a?.description || p.manifest?.description || '', area: p.area || 'personal',
        kind: a ? a.kind : 'local', from: a?.from || '~/.config/clearsky/sources', version: a?.version || '', commit: a?.commit || null, run: a?.run || 'inside',
        added: true, loaded: a ? loaded(a) : true, ready, problem: a?.problem || null, reach: shape(reach.get(p.name)) };
    }),
    // Added but not running in this Clearsky: new since it started, or it failed to load.
    ...added.filter((p) => !plugins.sources.has(p.name)).map((p) => ({
      name: p.name, label: p.label, description: p.description, area: p.manifest?.area || 'personal', kind: p.kind, from: p.from, version: p.version || '', commit: p.commit || null,
      run: p.run, added: true, loaded: false, ready: true, problem: p.problem, reach: shape(p.manifest) })),
    ...available.map((p) => ({ name: p.name, label: p.label, description: p.description, area: p.manifest?.area || 'personal', kind: p.kind, from: p.from,
      version: p.manifest?.version || '', added: false, loaded: false, ready: false, reach: shape(p.manifest) })),
  ];
  const pins = readRegistry(pluginDirs.registry).plugins;
  for (const p of all) if (pins[p.name]?.pin && p.added) p.pin = pins[p.name].pin;
  // Added from its folder here, and it has a repo of its own now: offer the move.
  for (const p of all) if (p.kind === 'bundled' && p.added && !retiredText(p.name)) { const c = catalogEntry(p.name); if (c) p.moveTo = c.from; }
  return {
    all, added: added.map((p) => ({ ...strip(p), loaded: loaded(p) })),
    available: available.map(strip), errors: plugins.errors, sandbox: !!srtCli(), team: teamPlugins(),
  };
}

// A fetched plugin waiting for you to say yes (10 minutes), so what's added is what you saw.
export const pendingPlugins = new Map();
export async function previewPlugin(from) {
  const p = await preparePlugin(from, { paths: pluginDirs });
  const token = randomBytes(12).toString('hex');
  pendingPlugins.set(token, { ...p, timer: setTimeout(() => { pendingPlugins.delete(token); p.discard(); }, 10 * 6e4) });
  const m = p.manifest;
  return { token, name: m.name, label: m.label, version: m.version, description: m.description, from, kind: p.spec.kind,
    commit: p.got.commit || null, hosts: m.hosts, clis: m.clis, files: m.files, secrets: m.secrets, settings: Object.keys(m.settings),
    outside: m.outside || null, replaces: p.had ? { version: p.had.version, commit: p.had.commit || null, from: p.had.from } : null, sandbox: !!srtCli(),
    changes: p.changes && { ...p.changes, text: changesText(p.changes) }, warning: p.warning || null };
}

// `clearsky add | remove | plugins | update`.
export async function pluginCommand(args) {
  const [cmd, name] = args, flag = (f) => args.includes(f);
  const say = (m) => console.log(m);
  const where = (m) => [m.hosts.length ? `reaches ${m.hosts.join(', ')}` : 'reaches no hosts', m.clis.length && `runs ${m.clis.join(', ')}`, m.files.length && `keeps ${m.files.join(', ')}`].filter(Boolean).join('; ');
  try {
    if (cmd === 'plugins') {
      const { added, available } = listPlugins({ paths: pluginDirs });
      say(added.length ? 'Added:' : 'No plugins added. `clearsky add <plugin>` adds one.');
      for (const p of added) say(`  ${p.name} ${p.version || ''}  ${p.run === 'inside' ? 'inside Clearsky' : 'sandboxed'}  from ${p.from}${p.commit ? ` @ ${p.commit.slice(0, 10)}` : ''}${p.problem ? `  (${p.problem})` : ''}`);
      if (available.length) { say('To add (`clearsky add <name>`):'); for (const p of available) say(`  ${catalogEntry(p.name)?.aka[0] || p.name}  ${p.description}${p.kind === 'catalog' ? `  (${p.from})` : ''}`); }
      if (!srtCli()) say('The sandbox (srt) isn\'t installed, so sandboxed plugins won\'t run. `clearsky doctor` says how to get it.');
      return 0;
    }
    if (!name && cmd !== 'update') { say(`usage: clearsky ${cmd} <plugin>`); return 2; }
    if (cmd === 'remove') { removePlugin(name, { paths: pluginDirs, data: flag('--data') }); say(`Removed ${name}${flag('--data') ? ', and what it kept' : ''}. Restart Clearsky to drop it.`); return 0; }
    const ask = async (q) => {
      if (flag('--yes')) return true;
      if (!process.stdin.isTTY) return false;
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      const yes = /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
      rl.close();
      return yes;
    };
    const opt = (f) => { const i = args.indexOf(f); return i > -1 ? (args[i + 1] ?? '') : undefined; };
    // clearsky update [name] [--to v1.3.0 | --to ''] [--check] [--yes]
    if (cmd === 'update') {
      const named = name && !name.startsWith('--') ? name : null;
      const names = named ? [named] : listPlugins({ paths: pluginDirs }).added.filter((p) => p.kind !== 'bundled').map((p) => p.name);
      const to = opt('--to');
      let changed = 0;
      for (const n of names) {
        if (flag('--check')) {
          const c = await checkPlugin(n, { paths: pluginDirs }).catch((e) => ({ problem: e.message }));
          const where = c.pin === 'tag' || c.pin === 'branch' ? `${c.pin} ${c.ref}` : c.pin === 'default' ? `follows ${c.branch || 'the default branch'}` : c.pin;
          say(`${n}: ${[where, c.problem, c.behind && 'has new commits', c.moved && `the tag now points to other code (${c.latest?.slice(0, 10)})`,
            c.newer?.length && `newer: ${c.newer.map((x) => x.tag).join(', ')}`].filter(Boolean).join('; ') || 'up to date'}`);
          continue;
        }
        const had = readRegistry(pluginDirs.registry).plugins[n];
        const p = await preparePlugin(to === undefined ? had?.from || n : withRef(had.from, to), { paths: pluginDirs });
        const before = { version: p.had?.version, commit: p.had?.commit };
        if (p.warning) say(`${n}: careful, ${p.warning}`);
        if (p.manifest.outside && p.had?.run !== 'inside') { p.discard(); say(`${n}: not updated, the new version wants to run outside the sandbox (${p.manifest.outside}). Add it again with --trust if you trust it.`); continue; }
        if (p.changes?.wider) {
          say(`${n}: the new version ${changesText(p.changes)}.`);
          if (!await ask('Take it?')) { p.discard(); say(`${n}: not updated.`); continue; }
        }
        const r = p.done({ trust: p.had?.run === 'inside' });
        changed++;
        say(`${n}: ${before.commit && r.commit ? `${before.commit.slice(0, 10)} → ${r.commit.slice(0, 10)}` : `${before.version} → ${r.version}`}${r.from !== p.had?.from ? ` (now ${r.from})` : ''}`);
      }
      if (changed) say('Restart Clearsky to load the new code.'); else if (!names.length) say('Nothing to update.');
      return 0;
    }
    // clearsky add --team: each of the team pack's plugins you haven't got (or have at another version).
    if (cmd === 'add' && name === '--team') {
      const t = teamPlugins();
      const todo = (t?.plugins || []).filter((p) => p.state !== 'added');
      if (!todo.length) { say(t ? `You have all of ${t.name}'s plugins.` : 'You haven\'t joined a team pack with plugins. `clearsky join <pack>` first.'); return 0; }
      for (const o of todo) {
        say(`\n${o.state === 'new' ? 'Team plugin' : `Team version of ${o.name} (you have ${o.yours})`}: ${o.from}${o.note ? ` — ${o.note}` : ''}`);
        const code = await pluginCommand(['add', o.from, ...args.filter((a) => a === '--yes' || a === '--trust')]);
        if (code) say('  skipped');
      }
      return 0;
    }
    // add: show what it is and what it reaches before any of its code runs, then ask.
    const p = await preparePlugin(name, { paths: pluginDirs });
    const m = p.manifest;
    say(`${m.label} ${m.version}${p.got.commit ? ` (${p.got.commit.slice(0, 10)})` : ''}: ${m.description || 'no description'}`);
    say(`  ${where(m)}`);
    if (Object.keys(m.settings).length) say(`  settings: ${Object.keys(m.settings).join(', ')}`);
    if (p.spec.kind === 'bundled') say('  ships with Clearsky; runs inside it');
    else if (m.outside) say(`  runs OUTSIDE the sandbox, as you: ${m.outside}`);
    else say(`  runs in a sandbox of its own${srtCli() ? '' : ' (not installed here, so it won\'t run until it is)'}`);
    if (m.outside && p.spec.kind !== 'bundled' && !flag('--trust')) { p.discard(); say('Not added: it can do anything you can. Add it again with --trust if you trust its code.'); return 1; }
    if (p.had) say(`  replaces ${p.had.from}${p.changes?.wider ? `; the new version ${changesText(p.changes)}` : ''}`);
    if (p.warning) say(`  careful: ${p.warning}`);
    if (!flag('--yes') && !process.stdin.isTTY) { p.discard(); say('Not added: say yes with --yes when there\'s no terminal to ask in.'); return 1; }
    if (!await ask('Add it?')) { p.discard(); say('Not added.'); return 1; }
    const r = p.done({ trust: flag('--trust') });
    say(`Added ${r.name}. Restart Clearsky (or Settings → Restart) to load it${Object.keys(m.settings).length ? ', then fill in its settings' : ''}.`);
    return 0;
  } catch (e) { console.error(`clearsky: ${e.message}`); return 1; }
}
