// Why Clearsky needs a restart: what changed on disk or in Settings since it started that only a
// restart picks up. Each check compares what was loaded with what's there now, so undoing a
// change (removing a plugin you just added) also takes the notice away.

// What of a plugin's entry in plugins.json a restart would load differently.
const LOADED = ['from', 'kind', 'version', 'commit', 'hash', 'run'];
const loadedAs = (e) => JSON.stringify(LOADED.map((k) => e?.[k] ?? null));

// Plugins added, removed or updated since start (from Settings, `clearsky add` or a team pack).
// `before`/`after`: plugins.json's `plugins`; `label(name)`: a name to show.
export function pluginChanges(before = {}, after = {}, label = (n) => n) {
  const out = [];
  for (const n of Object.keys(after).sort()) {
    if (!before[n]) out.push({ kind: 'plugin', name: n, text: `${label(n)} added` });
    else if (loadedAs(before[n]) !== loadedAs(after[n])) out.push({ kind: 'plugin', name: n, text: `${label(n)} updated` });
  }
  for (const n of Object.keys(before).sort()) if (!after[n]) out.push({ kind: 'plugin', name: n, text: `${label(n)} removed` });
  return out;
}

// Settings your plugin reads only when Clearsky starts (`"restart": true` in its manifest) that
// changed since. `fields`: FIELDS of lib/settings.mjs.
export function settingChanges(before = {}, after = {}, fields = {}) {
  return Object.entries(fields).filter(([k, f]) => f?.restart && (before[k] || '') !== (after[k] || ''))
    .map(([k, f]) => ({ kind: 'setting', name: k, text: `${f.label && f.label !== k ? f.label : k} changed` }));
}

// Lines of your settings file changed by hand (or by a script) since start: Clearsky reads the
// file only when it starts. Saving in Settings changes the running values too, so it's not here.
// `atStart`/`now`: the file's values then and now; `running`: the values in use (process.env).
// Names only: a value may be a secret.
export function fileChanges(atStart = {}, now = {}, running = {}) {
  const keys = [...new Set([...Object.keys(atStart), ...Object.keys(now)])].sort();
  const changed = keys.filter((k) => (atStart[k] || '') !== (now[k] || '') && (now[k] || '') !== (running[k] || ''));
  return changed.length ? [{ kind: 'file', name: changed.join(','), text: `${changed.join(', ')} changed in your settings file` }] : [];
}
