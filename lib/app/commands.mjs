// What `clearsky` does in a terminal besides serving the page: restart, app (a window of its own)
// and docker.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { findBrowser, BROWSERS, openCommand } from '../browser.mjs';
import { wslInfo, isWindowsExe, windowsProfileDir } from '../wsl.mjs';
import { appDir, userEnvFile, config } from './config.mjs';
import { execFileP } from './services.mjs';
import { copilotFolders } from './chat-env.mjs';

// `clearsky restart`: ask the running server to restart once Copilot is idle.
export async function restartCommand(args) {
  const base = `http://127.0.0.1:${config.port}`;
  // Nothing to restart (never started here, or stopped): say so instead of a stack trace.
  const none = () => { console.error(`clearsky: nothing is running on ${base}. Start it with \`clearsky serve\`.`); process.exitCode = 1; };
  let csrf;
  try { csrf = readFileSync(join(dirname(userEnvFile), 'csrf'), 'utf8').trim(); } catch { return none(); }
  const res = await fetch(`${base}/api/restart`, { method: 'POST', headers: { 'X-Clearsky-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: args.includes('--now'), maxWaitMinutes: Number(args[args.indexOf('--wait') + 1]) || undefined }) }).catch(() => null);
  if (!res) return none();
  const { restart: r } = await res.json();
  console.log(r.busy && !args.includes('--now') ? `Restarting once Copilot is done (${r.busy} chat${r.busy > 1 ? 's' : ''} working; gives up at ${r.until}).` : 'Restarting now.');
}

// Your default browser, as the desktop opens links.
export function openInBrowser(u) {
  // Under WSL, the Windows browser (wslview, else rundll32.exe): see lib/browser.mjs.
  const [cmd, ...pre] = openCommand();
  spawn(cmd, [...pre, u], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
// The launcher's StartupWMClass, so GNOME files the window under Clearsky (icon, Alt+Tab, and a
// click on the icon brings it back): on Wayland Chrome names an --app window by its address and
// profile (chrome-127.0.0.1__-Default) and ignores --class, which only X11 uses.
function fixLauncher(env = process.env) {
  const file = join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', 'clearsky.desktop');
  const wm = env.XDG_SESSION_TYPE === 'wayland' ? 'chrome-127.0.0.1__-Default' : 'Clearsky';
  try {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/^StartupWMClass=.*$/m, `StartupWMClass=${wm}`);
    if (next !== text) writeFileSync(file, next);
  } catch { /* no launcher installed */ }
}

// `clearsky app`: Clearsky in a window of its own (Chromium's app mode: no tabs or address bar),
// starting the server first when it isn't running. Links elsewhere open in your default browser.
export async function appCommand() {
  const base = `http://127.0.0.1:${config.port}`;
  const up = () => fetch(`${base}/api/restart`).then((r) => r.ok, () => false);
  if (!(await up())) {
    // Clearsky runs in Docker once `clearsky docker up` has run (until `clearsky docker down`):
    // start that container, else Clearsky here.
    if (existsSync(join(dirname(userEnvFile), 'docker-mounts.yml'))) await dockerCommand(['start']);
    else spawn(process.execPath, [join(appDir, 'bin', 'clearsky.mjs'), 'serve', '--port', String(config.port)], { detached: true, stdio: 'ignore', env: process.env, cwd: appDir }).unref();
    for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
  }
  // Under WSL2 a Windows browser (Edge, Chrome): WSL forwards 127.0.0.1 to Windows.
  const wsl = wslInfo();
  const browser = findBrowser(process.env, { windows: !!wsl });
  if (!browser) { console.error(`No Chromium-based browser found (tried ${wsl ? 'Edge and Chrome on C:, then ' : ''}${BROWSERS.join(', ')}). Set CLEARSKY_BROWSER, or open ${base}`); process.exit(1); }
  // A size that fits a laptop screen (CLEARSKY_WINDOW_SIZE=1600,1000 for another); the page
  // shrinks the window too when the browser remembers one taller than the screen.
  const size = /^\d+,\d+$/.test(process.env.CLEARSKY_WINDOW_SIZE || '') ? process.env.CLEARSKY_WINDOW_SIZE : '1280,860';
  // A browser profile of its own: in your running browser the window would be filed under the
  // browser (Wayland ignores --class there), so it couldn't be found as Clearsky in the dock or
  // Alt+Tab. No logins needed in it: links open in your default browser.
  // A Windows browser keeps it on Windows (%LOCALAPPDATA%\Clearsky\app-window): it can't use the Linux home.
  const windows = isWindowsExe(browser);
  const profile = windows ? windowsProfileDir() : join(dirname(userEnvFile), 'app-window');
  if (process.platform === 'linux' && !wsl) fixLauncher();
  spawn(browser, [`--app=${base}/?app=1`, ...(windows ? [] : ['--class=Clearsky']), ...(profile ? [`--user-data-dir=${profile}`] : []), '--no-first-run', '--no-default-browser-check', `--window-size=${size}`],
    { detached: true, stdio: 'ignore' }).unref();
}

// `clearsky docker …`: Clearsky's container, with the folders from Settings → Agent mounted
// (see lib/docker.mjs). Runs on your machine, not in the container.
export async function dockerCommand([sub = 'up', ...rest]) {
  const { dockerMounts, writeMountsFile } = await import('../docker.mjs');
  if (process.env.CLEARSKY_IN_CONTAINER === '1') { console.error('Run this on your machine, not in the container.'); process.exitCode = 1; return; }
  const repo = appDir;
  for (const d of [dirname(userEnvFile), join(homedir(), '.copilot')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const mounts = dockerMounts({ folders: copilotFolders(), cwd: process.env.AGENT_CWD, home: homedir() });
  const file = writeMountsFile(join(dirname(userEnvFile), 'docker-mounts.yml'), mounts);
  if (sub === 'mounts') { for (const m of mounts) console.log(`${m.path}${m.ro ? ' (read-only)' : ''}`); return; }
  const files = [join(repo, 'docker-compose.yml'), file, join(repo, 'docker-compose.override.yml')].filter((f) => existsSync(f)).flatMap((f) => ['-f', f]);
  const compose = { up: ['up', '-d', '--build', ...rest], start: ['up', '-d', ...rest], down: ['down', ...rest], logs: ['logs', '--tail', '50', ...rest], login: ['exec', '-it', 'clearsky', 'clearsky-login', ...rest] }[sub];
  if (!compose) { console.error('usage: clearsky docker [up|start|down|logs|login|mounts]'); process.exitCode = 1; return; }
  const env0 = { ...process.env, HOME_DIR: homedir(), UID: String(process.getuid?.() ?? 1000), GID: String(process.getgid?.() ?? 1000), PORT: String(config.port) };
  // Logging in: bring over the logins this machine already has (gh, and Copilot with gh's
  // token; acli with an API token, as its own login can't be copied), the rest in the browser.
  if (sub === 'login' && !rest.length) {
    const inside = (cmd, input) => new Promise((done) => {
      const p = spawn('docker', ['compose', ...files, 'exec', '-T', 'clearsky', 'sh', '-c', `. ~/.session-bus; ${cmd}`], { stdio: ['pipe', 'inherit', 'inherit'], env: env0, cwd: repo });
      p.on('exit', (c) => done(c === 0)).on('error', () => done(false));
      p.stdin.end(input || '');
    });
    const left = [];
    const gh = await execFileP('gh', ['auth', 'token'], { timeout: 10_000 }).then((r) => r.stdout.trim()).catch(() => '');
    if (gh && await inside('gh auth login --with-token', `${gh}\n`)) console.log('gh: logged in with this machine\'s login');
    else left.push('gh');
    if (gh && await inside('copilot login --with-token', `${gh}\n`)) console.log('Copilot: logged in with gh\'s login');
    else left.push('copilot');
    // acli's web login calls back to a port on 127.0.0.1, which your browser can only reach
    // when acli shares this machine's network: a one-off container that does, with the same
    // folders and keyring (Clearsky's container stops meanwhile, so one keyring is in use).
    const acliOk = await inside('acli jira auth status >/dev/null 2>&1');
    if (acliOk) console.log('acli: logged in already');
    else if (process.stdin.isTTY) {
      console.log('acli: logging in through your browser (Clearsky pauses for it)…');
      const compose = (...a) => new Promise((done) => spawn('docker', ['compose', ...files, ...a], { stdio: 'inherit', env: env0, cwd: repo }).on('exit', done).on('error', done));
      await compose('stop', 'clearsky');
      const home = homedir(), ids = `${env0.UID}:${env0.GID}`;
      const tmp = (p, exec) => ['--tmpfs', `${p}:uid=${env0.UID},gid=${env0.GID},mode=0700${exec ? ',exec' : ''}`];
      // acli only opens a browser when it sees a display; the "browser" in there is the shim.
      const args = ['run', '--rm', '-it', '--network', 'host', '--user', ids, '-e', `HOME=${home}`, '-e', 'DISPLAY=:0', '-e', 'WAYLAND_DISPLAY=wayland-0',
        ...tmp(home, true), ...tmp(join(home, '.config')), ...tmp(join(home, '.cache'), true),
        ...mounts.flatMap((m) => ['-v', `${m.path}:${m.path}${m.ro ? ':ro' : ''}`]),
        'clearsky:local', '--run', 'acli jira auth login --web'];
      // The container leaves the login link in a file; open it here, in your own browser.
      const urlFile = join(dirname(userEnvFile), 'container', 'open-url');
      try { rmSync(urlFile, { force: true }); } catch {}
      const watch = setInterval(() => {
        let u = '';
        try { u = readFileSync(urlFile, 'utf8').trim(); rmSync(urlFile, { force: true }); } catch { return; }
        if (!/^https:\/\//.test(u)) return;
        process.stderr.write(`\nOpening ${u}\n`);
        openInBrowser(u);
      }, 300);
      const ok = await new Promise((done) => spawn('docker', args, { stdio: 'inherit' }).on('exit', (c) => done(c === 0)).on('error', () => done(false)));
      clearInterval(watch);
      await compose('up', '-d');
      if (!ok) left.push('acli');
    } else left.push('acli');
    if (!left.length) return;
    if (left.includes('acli')) console.log('acli: not logged in; run `clearsky docker login` again in a terminal to log in through the browser.');
    if (!left.some((x) => x !== 'acli')) return;
    console.log(`Now in the browser: ${left.filter((x) => x !== 'acli').join(', ')}`);
    for (const t of left.filter((x) => x !== 'acli')) await new Promise((done) => spawn('docker', ['compose', ...files, 'exec', '-it', 'clearsky', 'clearsky-login', t], { stdio: 'inherit', env: env0, cwd: repo }).on('exit', done).on('error', done));
    return;
  }
  if (sub === 'up') console.log(`Mounting ${mounts.length} folders (clearsky docker mounts lists them).`);
  const code = await new Promise((done) => spawn('docker', ['compose', ...files, ...compose], { stdio: 'inherit', env: env0, cwd: repo }).on('exit', done).on('error', (e) => { console.error(e.message); done(1); }));
  process.exitCode = code || 0;
  // Back to running natively: the app window starts Clearsky here again.
  if (sub === 'down' && !code) rmSync(file, { force: true });
}
