import path from 'node:path';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ownSessionDir, fail} from './storage.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const {Terminal} = require('@xterm/headless');
const {SerializeAddon} = require('@xterm/addon-serialize');
const appDir = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_LIMIT = 8;
export function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) fail(400, 'Terminal dimensions must be 20–400 columns and 5–200 rows.');
  return {cols, rows};
}
export function send(socket, value) {
  if (socket.readyState !== 1) return;
  if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.close(1013, 'Reconnect to restore terminal screen.'); return; }
  socket.send(JSON.stringify(value));
}
function childEnvironment(url, token, id) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(ORCA_|OMP_WORKSPACE_|OMP_SESSION_|PI_SESSION_|VSCODE_)/i.test(key) || /^(AGENT|OMP_TUI_DEBUG|PI_TUI_DEBUG|CI|CONTINUOUS_INTEGRATION|OMPCODE|PI_TERMINAL_OWNER_PID|PI_TOOL_CALL_ID|NO_COLOR|FORCE_COLOR|TERM_PROGRAM|TERM_PROGRAM_VERSION|WT_SESSION|WT_PROFILE_ID|TMUX|STY|NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START)$/i.test(key)) delete env[key];
  }
  return {...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', OMP_WORKSPACE_URL: url, OMP_WORKSPACE_TOKEN: token, OMP_WORKSPACE_PANE: id};
}
export class TerminalSession {
  constructor(record, options) {
    this.record = record;
    this.options = options;
    this.sockets = new Set();
    this.queue = Promise.resolve();
    this.backlog = 0;
    this.closed = false;
    this.process = null;
    this.terminal = null;
    this.serializer = null;
  }
  enqueue(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(error => {
      for (const socket of this.sockets) send(socket, {type: 'error', id: this.record.id, error: error.message});
    });
    return next;
  }
  async start(cols, rows) {
    if (this.process || this.closed) return;
    dimensions(cols, rows);
    const directory = path.join(ownSessionDir, this.record.id);
    await fs.mkdir(directory, {recursive: true});
    if (this.closed) return;
    this.terminal = new Terminal({cols, rows, scrollback: 3000, allowProposedApi: true, logLevel: 'off'});
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    const executable = process.env.OMP_BIN || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'omp', 'omp.exe') : 'omp');
    const args = ['--cwd', this.record.cwd, '--allow-home', '--session-dir', directory, '--extension', path.join(appDir, 'extension.mjs')];
    if (this.record.sessionFile) args.push('--resume', this.record.sessionFile);
    try {
      this.process = pty.spawn(executable, args, {name: 'xterm-256color', cols, rows, cwd: this.record.cwd, env: childEnvironment(this.options.url, this.options.token, this.record.id), useConpty: true});
      this.process.onData(data => {
        this.backlog += Buffer.byteLength(data);
        if (this.backlog > 1024 * 1024 && !this.paused) { this.paused = true; this.process.pause(); }
        this.enqueue(() => new Promise(resolve => {
          if (!this.terminal) { resolve(); return; }
          this.terminal.write(data, () => {
            this.backlog -= Buffer.byteLength(data);
            for (const socket of this.sockets) send(socket, {type: 'output', id: this.record.id, data});
            if (this.paused && this.backlog < 128 * 1024 && !this.closed) { this.paused = false; this.process?.resume(); }
            resolve();
          });
        })).catch(() => {});
      });
      this.process.onExit(({exitCode}) => {
        this.closed = true;
        this.record.status = 'exited';
        this.record.exitCode = exitCode;
        this.enqueue(() => {
          for (const socket of this.sockets) send(socket, {type: 'exit', id: this.record.id, exitCode});
          this.options.changed();
        }).catch(() => {});
      });
      this.record.status = 'starting';
      this.options.changed();
    } catch (error) {
      this.closed = true;
      this.record.status = 'error';
      this.terminal.dispose();
      this.terminal = null;
      this.options.changed();
      throw new Error(`Unable to start omp: ${error.message}`);
    }
  }
  attach(socket, cols, rows) {
    dimensions(cols, rows);
    return this.enqueue(async () => {
      if (!this.process && !this.closed) await this.start(cols, rows);
      if (socket.readyState !== 1) return;
      if (this.terminal) {
        if (!this.closed && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
          this.terminal.resize(cols, rows);
          this.process?.resize(cols, rows);
        }
        send(socket, {type: 'reset', id: this.record.id, data: this.serializer.serialize({scrollback: 3000})});
      } else send(socket, {type: 'reset', id: this.record.id, data: ''});
      this.sockets.add(socket);
      if (this.closed) send(socket, {type: 'exit', id: this.record.id, exitCode: this.record.exitCode ?? 0});
    });
  }
  detach(socket) { return this.enqueue(() => { this.sockets.delete(socket); }); }
  input(socket, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) fail(413, 'Terminal input is limited to 64 KiB.');
    return this.enqueue(() => {
      if (!this.sockets.has(socket)) fail(400, 'Attach this terminal before sending input.');
      if (this.closed || !this.process) fail(409, 'This terminal is not running.');
      this.process.write(data);
    });
  }
  resize(socket, cols, rows) {
    dimensions(cols, rows);
    return this.enqueue(() => {
      if (!this.sockets.has(socket)) fail(400, 'Attach this terminal before resizing.');
      if (this.closed || !this.terminal || (this.terminal.cols === cols && this.terminal.rows === rows)) return;
      this.terminal.resize(cols, rows);
      this.process.resize(cols, rows);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.record.status = 'exited';
    for (const agent of this.record.agents) agent.status = 'parked';
    if (this.process) {
      try { this.process.kill(); } catch { /* The child may already have exited. */ }
    } else {
      this.record.exitCode = 0;
      for (const socket of this.sockets) send(socket, {type: 'exit', id: this.record.id, exitCode: 0});
    }
    this.options.changed();
  }
  async dispose() {
    this.close();
    await this.queue;
    this.sockets.clear();
    this.terminal?.dispose();
    this.terminal = null;
  }
}
