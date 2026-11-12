import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WebSocketServer} from 'ws';
import {TerminalSession, SESSION_LIMIT, send, dimensions} from './terminal.mjs';
import {TEXT_LIMIT, ownSessionDir, fail, directory, inside, within, samePath, tree, readFile, writeFile, loadState, saveState, knownSessionPath, sessionMetadata, scanSaved, transcript} from './storage.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const args = process.argv.slice(2);
let rootArgument = process.cwd(), portArgument = 0, readyFile;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (!['--root', '--port', '--ready-file'].includes(flag) || index + 1 >= args.length) throw new Error(`Unknown or incomplete option: ${flag}`);
  const value = args[++index];
  if (flag === '--root') rootArgument = path.resolve(value);
  if (flag === '--ready-file') readyFile = path.resolve(value);
  if (flag === '--port') {
    if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('Port must be between 0 and 65535.');
    portArgument = Number(value);
  }
}
let root = await directory(rootArgument);
let branch = '';
const token = crypto.randomBytes(32).toString('base64url');
const cookieName = `omp_workspace_${crypto.randomBytes(6).toString('hex')}`;
const state = await loadState();
const records = new Map(state.sessions.filter(item => item && typeof item.id === 'string' && typeof item.cwd === 'string').map(item => [item.id, item]));
let saved = await scanSaved([...records.values()]);
const terminals = new Map();
const bridge = new Map();
const commands = new Map();
let origin, stopping = false, updateTimer, scanPromise;
let creationQueue = Promise.resolve();
const webSockets = new WebSocketServer({noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false, clientTracking: true});
const publicFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['public/icon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['public/icon.ico', 'image/x-icon']],
  ['/vendor/xterm.mjs', ['node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/addon-fit.mjs', ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8']],
  ['/vendor/marked.mjs', ['node_modules/marked/lib/marked.esm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/purify.mjs', ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8']],
]);
function validToken(value) {
  if (typeof value !== 'string') return false;
  const expected = Buffer.from(token), candidate = Buffer.from(value);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function bearer(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ') && validToken(authorization.slice(7));
}
function authenticated(request) {
  return (request.headers.cookie || '').split(';').some(part => {
    const index = part.indexOf('=');
    return part.slice(0, index).trim() === cookieName && validToken(part.slice(index + 1));
  });
}
function isBridge(url) { return url.pathname === '/api/bridge' || url.pathname === '/api/bridge/commands'; }
function secureRequest(request) {
  if (request.headers.host !== new URL(origin).host) fail(403, 'Unexpected request host.');
}
function sameOrigin(request) { if (request.headers.origin !== origin) fail(403, 'A same-origin browser request is required.'); }
function headers(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${new URL(origin).host}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
}
function json(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'Use application/json.');
  const limit = TEXT_LIMIT * 6 + 65536;
  if (Number(request.headers['content-length']) > limit) fail(413, 'Request body is too large.');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) fail(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Expected a JSON object.');
    return parsed;
  } catch (error) { if (error.status) throw error; fail(400, 'Invalid JSON body.'); }
}
function text(value, name, limit = 200, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) fail(400, `Invalid ${name}.`);
  return value;
}
function sessionView(terminal) {
  const record = terminal.record;
  const {id, name, cwd, status, sessionFile, sessionId, model, lastTool, exitCode} = record;
  return {id, name, cwd, status, sessionFile, sessionId, model, lastTool, exitCode, agents: record.agents.map(agent => ({...agent}))};
}
function workspace() {
  return {root, name: path.basename(root) || root, branch, sessions: [...terminals.values()].map(sessionView), savedChats: [...saved.values()].filter(item => samePath(item.cwd, root)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 250)};
}
function broadcast(value) { for (const socket of webSockets.clients) send(socket, value); }
function persist() {
  for (const terminal of terminals.values()) {
    const record = terminal.record;
    records.set(record.id, {id: record.id, name: record.name, cwd: record.cwd, sessionFile: record.sessionFile, sessionId: record.sessionId, model: record.model, updatedAt: new Date().toISOString()});
  }
  return saveState([...records.values()]);
}
function changed() {
  if (updateTimer || stopping) return;
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    broadcast({type: 'workspace', ...workspace()});
    persist().catch(error => console.error(`Workspace state could not be saved: ${error.code || 'I/O error'}`));
  }, 80);
}
async function refreshSaved() {
  if (scanPromise) return scanPromise;
  scanPromise = scanSaved([...records.values()]).then(result => { saved = result; }).finally(() => { scanPromise = undefined; });
  return scanPromise;
}
async function refreshBranch() {
  const target = root;
  try {
    const {stdout} = await exec('git', ['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {timeout: 2000, windowsHide: true, maxBuffer: 4096});
    if (root === target) branch = stdout.trim().slice(0, 200);
  } catch { if (root === target) branch = ''; }
}
function getTerminal(id) { const terminal = terminals.get(id); if (!terminal) fail(404, 'Unknown terminal session.'); return terminal; }
function keyFor(paneId, agentId) { return JSON.stringify([paneId, agentId]); }
function getAgent(paneId, agentId) {
  const terminal = getTerminal(paneId);
  const agent = terminal.record.agents.find(item => item.id === agentId);
  if (!agent) fail(404, 'Unknown agent.');
  return {terminal, agent, heartbeat: bridge.get(keyFor(paneId, agentId))};
}
function queuedCreate(data) {
  const operation = creationQueue.then(() => createSession(data));
  creationQueue = operation.catch(() => {});
  return operation;
}
async function createSession(data) {
  const sessionRoot = root;
  if ([...terminals.values()].filter(item => !item.closed).length >= SESSION_LIMIT) fail(409, `At most ${SESSION_LIMIT} terminals may run at once. Close a session first.`);
  let resume;
  if (data.sessionFile !== undefined) {
    const requested = await knownSessionPath(text(data.sessionFile, 'session file', 32768));
    const known = saved.get(requested);
    if (!known || !samePath(known.cwd, sessionRoot)) fail(403, 'Choose a saved chat belonging to this workspace.');
    if ([...terminals.values()].some(item => !item.closed && item.record.sessionFile && samePath(item.record.sessionFile, requested))) fail(409, 'That saved chat is already open. Select its existing terminal.');
    resume = known;
  }
  for (const [id, terminal] of terminals) {
    if (terminals.size < 24) break;
    if (terminal.closed) { await terminal.dispose(); terminals.delete(id); }
  }
  const record = {id: crypto.randomUUID(), name: resume?.name || `Chat ${terminals.size + 1}`, cwd: sessionRoot, status: 'starting', agents: [], ...(resume ? {sessionFile: resume.sessionFile, sessionId: resume.sessionId} : {})};
  const terminal = new TerminalSession(record, {url: origin, token, changed});
  terminals.set(record.id, terminal);
  await persist();
  changed();
  return sessionView(terminal);
}
async function postBridge(data) {
  const paneId = text(data.paneId, 'pane id', 256);
  const terminal = getTerminal(paneId);
  if (terminal.closed) fail(409, 'This terminal has stopped.');
  if (!data.agent || typeof data.agent !== 'object') fail(400, 'Agent identity is required.');
  const agentId = text(data.agent.id, 'agent id', 256);
  if (!agentId || !['main', 'sub'].includes(data.agent.kind)) fail(400, 'Invalid agent identity.');
  const name = text(data.agent.name, 'agent name', 200, true) || (data.agent.kind === 'main' ? 'Main' : agentId);
  const status = text(data.status, 'agent status', 64, true);
  if (status && !['starting', 'idle', 'running', 'exited', 'error', 'parked', 'completed', 'waiting', 'stopped'].includes(status)) fail(400, 'Invalid agent status.');
  const model = text(data.model, 'model', 300, true);
  const lastTool = text(data.lastTool, 'last tool', 300, true);
  const sessionId = text(data.sessionId, 'session id', 256, true);
  const title = text(data.name, 'session name', 200, true);
  let sessionFile;
  if (data.sessionFile !== undefined) sessionFile = await knownSessionPath(text(data.sessionFile, 'session file', 32768));
  const record = terminal.record;
  const reportedCwd = data.cwd === undefined ? undefined : text(data.cwd, 'working directory', 32768);
  const actualCwd = data.agent.kind === 'main' && reportedCwd !== undefined && !samePath(reportedCwd, record.cwd) ? await directory(reportedCwd) : undefined;
  if (data.agent.kind === 'main') {
    if (sessionFile && [...terminals.values()].some(item => item !== terminal && !item.closed && item.record.sessionFile && samePath(item.record.sessionFile, sessionFile))) fail(409, 'This native session is already attached to another terminal.');
    for (const previous of record.agents.filter(item => item.kind === 'main' && item.id !== agentId)) {
      bridge.delete(keyFor(paneId, previous.id));
      commands.delete(keyFor(paneId, previous.id));
    }
    record.agents = record.agents.filter(item => item.kind !== 'main' || item.id === agentId);
  }
  let agent = record.agents.find(item => item.id === agentId);
  if (!agent) {
    if (record.agents.length >= 256) fail(413, 'Agent roster is full.');
    agent = {id: agentId, kind: data.agent.kind, name, status: status || 'idle'};
    record.agents.push(agent);
  } else if (agent.kind !== data.agent.kind) fail(409, 'Agent identity kind cannot change.');
  agent.name = name;
  if (status !== undefined) agent.status = status;
  if (model !== undefined) agent.model = model;
  if (lastTool !== undefined) agent.lastTool = lastTool;
  if (sessionFile) agent.sessionFile = sessionFile;
  bridge.set(keyFor(paneId, agentId), {seen: Date.now()});
  if (agent.kind === 'main') {
    if (title) record.name = title;
    if (status) record.status = ['parked', 'completed', 'waiting', 'stopped'].includes(status) ? 'idle' : status;
    if (sessionFile) {
      record.sessionFile = sessionFile;
      const metadata = await sessionMetadata(sessionFile);
      if (metadata) saved.set(sessionFile, {...metadata, name: title || metadata.name});
    }
    if (sessionId !== undefined) record.sessionId = sessionId;
    if (actualCwd !== undefined) record.cwd = actualCwd;
    if (model !== undefined) record.model = model;
    if (lastTool !== undefined) record.lastTool = lastTool;
  }
  if (data.action !== undefined) {
    const action = data.action;
    if (!action || typeof action !== 'object') fail(400, 'Invalid bridge action.');
    if (action.type === 'rename') record.name = text(action.name, 'session name', 200);
    else if (action.type === 'split') broadcast({type: 'split', paneId, ...(action.name ? {name: text(action.name, 'split name', 200)} : {})});
    else if (action.type === 'read') {
      const requested = text(action.path, 'reader path', 32768);
      const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(record.cwd, requested);
      if (!within(record.cwd, absolute) || !within(root, absolute)) fail(403, 'Reader actions must be inside the current and originating workspace.');
      const target = await inside(root, path.relative(root, absolute), 'file');
      broadcast({type: 'read', path: target.path});
    } else fail(400, 'Unknown bridge action.');
  }
  changed();
  return {ok: true};
}
async function route(request, response) {
  headers(response);
  secureRequest(request);
  const url = new URL(request.url, origin);
  if (request.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
    if (!validToken(url.searchParams.get('token'))) fail(401, 'Invalid workspace token.');
    response.writeHead(303, {'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/'});
    response.end();
    return;
  }
  const bridgeRoute = isBridge(url);
  const extension = bridgeRoute && bearer(request);
  if (!extension && !authenticated(request)) fail(401, 'Open the private workspace launch URL to sign in.');
  if (bridgeRoute && !extension) fail(401, 'The extension bridge requires bearer authentication.');
  if (!['GET', 'HEAD'].includes(request.method) && !extension) sameOrigin(request);
  if (stopping) fail(503, 'Workspace is shutting down.');
  const pathname = url.pathname;
  if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, {ok: true});
  if (request.method === 'GET' && pathname === '/api/workspace') return json(response, 200, workspace());
  if (request.method === 'POST' && pathname === '/api/sessions') return json(response, 201, await queuedCreate(await body(request)));
  const close = /^\/api\/sessions\/([^/]+)\/close$/.exec(pathname);
  if (request.method === 'POST' && close) {
    const terminal = getTerminal(decodeURIComponent(close[1]));
    terminal.close();
    await persist();
    await refreshSaved();
    changed();
    return json(response, 200, {ok: true});
  }
  if (request.method === 'GET' && pathname === '/api/tree') return json(response, 200, await tree(root, url.searchParams.get('path') || ''));
  if (request.method === 'GET' && pathname === '/api/file') return json(response, 200, await readFile(root, url.searchParams.get('path')));
  if (request.method === 'PUT' && pathname === '/api/file') return json(response, 200, await writeFile(root, await body(request)));
  if (request.method === 'POST' && pathname === '/api/root') {
    const data = await body(request);
    root = await directory(data.path);
    await Promise.all([refreshBranch(), refreshSaved()]);
    changed();
    return json(response, 200, workspace());
  }
  if (request.method === 'POST' && pathname === '/api/shutdown') {
    json(response, 200, {ok: true});
    setImmediate(() => shutdown().catch(() => process.exit(1)));
    return;
  }
  const agentRoute = /^\/api\/agents\/([^/]+)\/([^/]+)(\/steer)?$/.exec(pathname);
  if (agentRoute) {
    const paneId = decodeURIComponent(agentRoute[1]), agentId = decodeURIComponent(agentRoute[2]);
    const {terminal, agent, heartbeat} = getAgent(paneId, agentId);
    if (request.method === 'GET' && !agentRoute[3]) {
      if (!agent.sessionFile) fail(409, 'This agent has not published a transcript yet.');
      return json(response, 200, {name: agent.name, content: await transcript(agent.sessionFile)});
    }
    if (request.method === 'POST' && agentRoute[3]) {
      const data = await body(request);
      const message = text(data.message, 'steering message', 16000);
      if (!message.trim()) fail(400, 'A steering message is required.');
      if (terminal.closed || !heartbeat || Date.now() - heartbeat.seen > 12000 || !['idle', 'running', 'starting', 'waiting'].includes(agent.status)) fail(409, 'This agent is not live. Revive it in the native Agent Hub first.');
      const key = keyFor(paneId, agentId), queue = commands.get(key) || [];
      if (queue.length >= 16) fail(429, 'This agent has too many queued messages.');
      queue.push({type: 'steer', message});
      commands.set(key, queue);
      return json(response, 200, {ok: true});
    }
  }
  if (request.method === 'POST' && pathname === '/api/bridge') return json(response, 200, await postBridge(await body(request)));
  if (request.method === 'GET' && pathname === '/api/bridge/commands') {
    const paneId = text(url.searchParams.get('paneId'), 'pane id', 256), agentId = text(url.searchParams.get('agentId'), 'agent id', 256);
    const {terminal, heartbeat} = getAgent(paneId, agentId);
    if (terminal.closed || !heartbeat || Date.now() - heartbeat.seen > 12000) fail(409, 'Agent bridge is no longer live.');
    const key = keyFor(paneId, agentId), pending = commands.get(key) || [];
    commands.delete(key);
    return json(response, 200, {commands: pending});
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const asset = publicFiles.get(pathname);
    if (asset) {
      const bytes = await fs.readFile(path.join(appDir, asset[0]));
      response.writeHead(200, {'Content-Type': asset[1], 'Content-Length': bytes.length});
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return;
    }
  }
  fail(404, 'Not found.');
}
function errorResponse(response, error) {
  if (response.headersSent || response.destroyed) { response.destroy(); return; }
  let status = error.status;
  if (!status) status = error.code === 'ENOENT' ? 404 : ['EACCES', 'EPERM'].includes(error.code) ? 403 : 500;
  const message = error.status ? error.message : status === 404 ? 'File or directory no longer exists.' : status === 403 ? 'Access denied.' : 'The workspace operation failed.';
  if (status === 500) console.error(`Workspace operation failed: ${error.code || error.name || 'Error'}`);
  json(response, status, {error: message});
}
const server = http.createServer((request, response) => { route(request, response).catch(error => errorResponse(response, error)); });
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;
server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
server.on('upgrade', (request, socket, head) => {
  try {
    secureRequest(request);
    sameOrigin(request);
    if (new URL(request.url, origin).pathname !== '/ws' || !authenticated(request) || stopping) fail(401, 'Unauthorized.');
    webSockets.handleUpgrade(request, socket, head, websocket => webSockets.emit('connection', websocket, request));
  } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
webSockets.on('connection', socket => {
  socket.alive = true;
  socket.on('pong', () => { socket.alive = true; });
  socket.on('error', () => {});
  send(socket, {type: 'workspace', ...workspace()});
  socket.on('message', async (data, binary) => {
    let message;
    try {
      if (binary) fail(400, 'Only JSON text messages are supported.');
      try { message = JSON.parse(data.toString('utf8')); } catch { fail(400, 'Invalid WebSocket JSON.'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) fail(400, 'Expected a terminal message.');
      const terminal = getTerminal(text(message.id, 'session id', 256));
      if (message.type === 'attach') { dimensions(message.cols, message.rows); await terminal.attach(socket, message.cols, message.rows); }
      else if (message.type === 'input') await terminal.input(socket, message.data);
      else if (message.type === 'resize') await terminal.resize(socket, message.cols, message.rows);
      else if (message.type === 'detach') terminal.detach(socket);
      else fail(400, 'Unknown terminal message.');
    } catch (error) { send(socket, {type: 'error', ...(typeof message?.id === 'string' ? {id: message.id} : {}), error: error.status || !error.code ? error.message : 'Terminal operation failed.'}); }
  });
  socket.on('close', () => { for (const terminal of terminals.values()) terminal.detach(socket); });
});
const heartbeatTimer = setInterval(() => {
  for (const socket of webSockets.clients) {
    if (!socket.alive) { socket.terminate(); continue; }
    socket.alive = false;
    socket.ping();
  }
  for (const terminal of terminals.values()) {
    for (const agent of terminal.record.agents) {
      const heartbeat = bridge.get(keyFor(terminal.record.id, agent.id));
      if (heartbeat && Date.now() - heartbeat.seen > 12000 && ['starting', 'idle', 'running', 'waiting'].includes(agent.status)) {
        agent.status = 'parked';
        commands.delete(keyFor(terminal.record.id, agent.id));
        changed();
      }
    }
  }
}, 5000);
heartbeatTimer.unref();
let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    clearInterval(heartbeatTimer);
    clearTimeout(updateTimer);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    for (const socket of webSockets.clients) socket.terminate();
    const serverClosed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.all([...terminals.values()].map(terminal => terminal.dispose()));
    await persist();
    if (readyFile) {
      try { const ready = JSON.parse(await fs.readFile(readyFile, 'utf8')); if (ready.pid === process.pid) await fs.unlink(readyFile); }
      catch { /* A launcher may have already removed its readiness file. */ }
    }
    await serverClosed;
    webSockets.close();
    clearTimeout(force);
  })();
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { shutdown().catch(() => process.exit(1)); });
process.on('uncaughtException', error => { console.error(`Workspace stopped after ${error.code || error.name || 'an unexpected error'}.`); shutdown().finally(() => process.exit(1)); });
process.on('unhandledRejection', error => { console.error(`Workspace stopped after ${error?.code || error?.name || 'an unexpected rejection'}.`); shutdown().finally(() => process.exit(1)); });
await refreshBranch();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(portArgument, '127.0.0.1', resolve); });
const port = server.address().port;
origin = `http://127.0.0.1:${port}`;
const url = `${origin}/?token=${token}`;
if (readyFile) {
  await fs.mkdir(path.dirname(readyFile), {recursive: true});
  const temporary = `${readyFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({url, port, pid: process.pid, root}), {mode: 0o600});
  await fs.rename(temporary, readyFile);
}
console.log(`OMP_WORKSPACE_READY ${url}`);
