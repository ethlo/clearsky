// Routes for plugins: the list, a look before adding one, adding, updating and removing.
import { removePlugin, updatePlugin, checkPlugin } from '../../plugins.mjs';
import { logEvent } from '../../event-log.mjs';
import { isDemo } from '../../demo.mjs';
import { pluginDirs } from '../config.mjs';
import { moduleManifests } from '../work.mjs';
import { pluginList, pendingPlugins, previewPlugin } from '../plugin-admin.mjs';
import { readJson, json, NEXT } from '../http.mjs';

// Changes: POST only, and the server has checked the page's token before it asks here.
export async function post({ req, res, url }) {
  // Plugins (lib/plugins.mjs): look first (what it reaches, before any of its code runs), then add.
  if (url.pathname === '/api/plugins/preview') {
    if (isDemo()) return json(res, 400, { error: 'not in the demo' });
    const { from } = await readJson(req);
    try { return json(res, 200, await previewPlugin(String(from || ''))); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/plugins/add') {
    const { token, trust } = await readJson(req);
    const p = pendingPlugins.get(String(token || ''));
    if (!p) return json(res, 400, { error: 'look at it again first; that preview has run out' });
    pendingPlugins.delete(String(token));
    clearTimeout(p.timer);
    // A new version of one you trusted keeps that trust; one that newly wants out needs your tick.
    try { const r = p.done({ trust: trust === true || p.had?.run === 'inside' }); logEvent(`plugin ${r.name} ${p.had ? `updated to ${r.from}${r.commit ? ` @ ${r.commit.slice(0, 10)}` : ''}` : 'added from ' + r.from} (${r.run === 'inside' ? 'runs inside Clearsky' : 'sandboxed'})`); return json(res, 200, { added: r, ...pluginList() }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  // Is there a newer version? Looks at the repo's tags and branch, without fetching code.
  if (url.pathname === '/api/plugins/check') {
    const { name } = await readJson(req);
    try { return json(res, 200, await checkPlugin(String(name || ''), { paths: pluginDirs })); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/plugins/remove' || url.pathname === '/api/plugins/update') {
    const { name, data } = await readJson(req);
    try {
      const r = url.pathname.endsWith('remove') ? removePlugin(String(name || ''), { paths: pluginDirs, data: data === true }) : await updatePlugin(String(name || ''), { paths: pluginDirs });
      logEvent(`plugin ${r.name} ${url.pathname.endsWith('remove') ? 'removed' : `updated from ${r.from}`}`);
      return json(res, 200, { done: r, ...pluginList() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  return NEXT;
}

// Reads.
export async function get({ res, url }) {
  if (url.pathname === '/api/modules') return json(res, 200, { modules: moduleManifests() });
  if (url.pathname === '/api/plugins') return json(res, 200, pluginList());
  return NEXT;
}
