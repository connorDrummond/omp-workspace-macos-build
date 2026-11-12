import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let root = process.cwd();
let shouldOpen = true;
let stop = false;
let port = '0';
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log('omp-workspace [repository] [--root PATH] [--port PORT] [--no-open] [--stop]\n\nOpens a local desktop-style workspace with real omp terminals.\nDefault repository: current directory. --stop closes all chats for that repository.');
    process.exit(0);
  } else if (arg === '--root' || arg === '--port') {
    const value = args[++i];
    if (!value) throw new Error(`${arg} needs a value`);
    if (arg === '--root') root = value;
    else port = value;
  } else if (arg === '--no-open') shouldOpen = false;
  else if (arg === '--stop') stop = true;
  else if (!arg.startsWith('-')) root = arg;
  else throw new Error(`Unknown option: ${arg}`);
}
if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('Port must be between 0 and 65535');
root = await realpath(path.resolve(root));
if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);

const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'omp-workspace');
const runDir = path.join(stateDir, 'run');
await mkdir(runDir, { recursive: true });
const key = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
const readyFile = path.join(runDir, `${key}.json`);
const lockFile = path.join(runDir, `${key}.lock`);
const logPath = path.join(runDir, `${key}.log`);

async function readRecord() {
  try { return JSON.parse(await readFile(readyFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
async function connect(record) {
  if (!record?.url || !record?.pid) return null;
  try {
    const url = new URL(record.url);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return null;
    const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1200) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) return null;
    const response = await fetch(new URL('/api/health', url), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(1200) });
    if (!response.ok || !(await response.json()).ok) return null;
    return { url, cookie };
  } catch { return null; }
}

async function run() {
  let record = await readRecord();
  let connection = await connect(record);
  if (stop) {
    if (!connection) { console.log(`No running workspace for ${root}`); return; }
    const response = await fetch(new URL('/api/shutdown', connection.url), {
      method: 'POST', headers: { Cookie: connection.cookie, Origin: connection.url.origin }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Could not stop workspace: HTTP ${response.status}`);
    console.log(`Stopped workspace for ${root}`);
    return;
  }

  if (!connection) {
    let lock;
    try { lock = await open(lockFile, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = Number(await readFile(lockFile, 'utf8')); } catch { /* Treat an incomplete lock as held. */ }
      let alive = true;
      if (owner > 0) {
        try { process.kill(owner, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('A workspace launch is already in progress. Try again shortly.');
      await unlink(lockFile);
      lock = await open(lockFile, 'wx');
    }
    try {
      await lock.writeFile(String(process.pid));
      // Another launcher may have completed just before we acquired the lock.
      record = await readRecord();
      connection = await connect(record);
      if (!connection) {
        if (!existsSync(path.join(appDir, 'node_modules', 'node-pty'))) throw new Error(`Dependencies missing. Run npm install in ${appDir}`);
        await unlink(readyFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const log = await open(logPath, 'a');
        const child = spawn(process.execPath, [path.join(appDir, 'server.mjs'), '--root', root, '--port', port, '--ready-file', readyFile], {
          cwd: appDir, detached: true, windowsHide: true,
          stdio: ['ignore', log.fd, log.fd],
        });
        let startupError;
        child.on('error', error => { startupError = error; });
        child.unref();
        await log.close();
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          if (startupError) throw startupError;
          record = await readRecord();
          if (record?.pid === child.pid) {
            connection = await connect(record);
            if (connection) break;
          }
          if (child.exitCode !== null) break;
          await new Promise(resolve => setTimeout(resolve, 160));
        }
        if (!connection) {
          const log = (await readFile(logPath, 'utf8').catch(() => '')).slice(-3500);
          throw new Error(`Workspace did not start. Log: ${logPath}\n${log}`);
        }
      }
    } finally {
      await lock.close();
      await unlink(lockFile).catch(() => {});
    }
  }

  console.log(`OMP Workspace\nRepository: ${root}\nLocal window: ${record.url}\nStop: omp-workspace --root "${root}" --stop`);
  if (!shouldOpen) return;
  const browserPaths = process.platform === 'win32' ? [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : [];
  const browser = browserPaths.find(existsSync);
  let executable;
  let browserArgs;
  if (browser) {
    executable = browser;
    browserArgs = [`--app=${record.url}`, `--user-data-dir=${path.join(stateDir, 'browser')}`, '--no-first-run', '--window-size=1680,980'];
  } else if (process.platform === 'win32') {
    executable = 'rundll32.exe';
    browserArgs = ['url.dll,FileProtocolHandler', record.url];
  } else {
    executable = process.platform === 'darwin' ? 'open' : 'xdg-open';
    browserArgs = [record.url];
  }
  const window = spawn(executable, browserArgs, { detached: true, stdio: 'ignore' });
  window.on('error', error => console.error(`Could not open a window: ${error.message}\nOpen ${record.url} manually.`));
  window.unref();
}

try { await run(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
