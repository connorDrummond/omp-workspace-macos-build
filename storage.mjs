import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const TEXT_LIMIT = 2 * 1024 * 1024;
export const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'omp-workspace');
export const nativeSessionDir = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'), 'sessions');
export const ownSessionDir = path.join(stateDir, 'sessions');
const stateFile = path.join(stateDir, 'state.json');
const hidden = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const locks = new Map();
export function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function samePath(a, b) { return path.relative(path.resolve(a), path.resolve(b)) === ''; }
export async function directory(value) {
  if (typeof value !== 'string' || value.length > 32768 || !path.isAbsolute(value) || value.includes('\0')) fail(400, 'Choose an absolute directory path.');
  const real = await fs.realpath(value);
  if (!(await fs.stat(real)).isDirectory()) fail(400, 'The selected path is not a directory.');
  return real;
}
export async function inside(root, relative, kind) {
  if (typeof relative !== 'string' || relative.length > 32768 || relative.includes('\0') || path.isAbsolute(relative) || /(^|[\\/])[^\\/]*:/.test(relative)) fail(400, 'Invalid workspace path.');
  const target = path.resolve(root, relative || '.');
  if (!within(root, target)) fail(403, 'Path is outside this workspace.');
  const real = await fs.realpath(target);
  if (!within(root, real)) fail(403, 'Links outside this workspace are not accessible.');
  const stat = await fs.stat(real);
  if (kind === 'file' && !stat.isFile()) fail(400, 'Select a regular file.');
  if (kind === 'directory' && !stat.isDirectory()) fail(400, 'Select a directory.');
  return {real, stat, path: path.relative(root, target).split(path.sep).join('/')};
}
export async function tree(root, relative = '') {
  const entry = await inside(root, relative, 'directory');
  const entries = [];
  const dir = await fs.opendir(entry.real);
  for await (const item of dir) {
    if (hidden.has(item.name)) continue;
    if (entries.length >= 5000) fail(413, 'Directory has too many entries; open a narrower workspace.');
    const rel = path.posix.join(entry.path, item.name);
    try {
      const child = await inside(root, rel);
      if (child.stat.isDirectory() || child.stat.isFile()) entries.push({name: item.name, path: rel, kind: child.stat.isDirectory() ? 'directory' : 'file'});
    } catch (error) { if (![403, 400].includes(error.status) && error.code !== 'ENOENT' && error.code !== 'EACCES' && error.code !== 'EPERM') throw error; }
  }
  entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
  return {path: entry.path, entries};
}
function decode(buffer) {
  if (buffer.includes(0)) fail(415, 'Binary files cannot be opened in the text reader.');
  try { return new TextDecoder('utf-8', {fatal: true}).decode(buffer); }
  catch { fail(415, 'This file is not valid UTF-8 text.'); }
}
function version(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function language(name) {
  return ({md:'markdown',mdx:'markdown',js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',jsx:'javascript',py:'python',rs:'rust',go:'go',json:'json',html:'html',css:'css',yml:'yaml',yaml:'yaml',sh:'bash',ps1:'powershell',cmd:'dos',toml:'toml',xml:'xml',sql:'sql'})[path.extname(name).slice(1).toLowerCase()] || 'text';
}
async function fileBytes(real) {
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(400, 'Select a regular file.');
    if (stat.size > TEXT_LIMIT) fail(413, 'Text files are limited to 2 MiB.');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, TEXT_LIMIT + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > TEXT_LIMIT) fail(413, 'Text files are limited to 2 MiB.');
    const after = await handle.stat();
    if (after.size !== length || after.mtimeMs !== stat.mtimeMs) fail(409, 'File changed while it was being read. Try again.');
    return {bytes: bytes.subarray(0, length), stat};
  } finally { await handle.close(); }
}
export async function readFile(root, relative) {
  const entry = await inside(root, relative, 'file');
  const {bytes} = await fileBytes(entry.real);
  return {path: entry.path, content: decode(bytes), language: language(entry.path), version: version(bytes)};
}
export async function writeFile(root, body) {
  if (typeof body.path !== 'string' || typeof body.content !== 'string' || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version)) fail(400, 'A file path, text content, and current version are required.');
  const bytes = Buffer.from(body.content, 'utf8');
  if (bytes.length > TEXT_LIMIT) fail(413, 'Text files are limited to 2 MiB.');
  decode(bytes);
  const key = path.resolve(root, body.path).toLowerCase();
  const previous = locks.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const entry = await inside(root, body.path, 'file');
    const old = await fileBytes(entry.real);
    decode(old.bytes);
    if (version(old.bytes) !== body.version) fail(409, 'File changed on disk. Reload before saving.');
    const temporary = path.join(path.dirname(entry.real), `.omp-workspace-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', old.stat.mode);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const current = await inside(root, body.path, 'file');
      if (!samePath(current.real, entry.real) || version((await fileBytes(current.real)).bytes) !== body.version) fail(409, 'File changed on disk. Reload before saving.');
      await fs.rename(temporary, entry.real);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return {path: entry.path, content: body.content, language: language(entry.path), version: version(bytes)};
  });
  locks.set(key, operation);
  try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
}
export async function loadState() {
  await fs.mkdir(ownSessionDir, {recursive: true});
  try {
    const stat = await fs.stat(stateFile);
    if (stat.size > TEXT_LIMIT) return {sessions: []};
    const data = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return {sessions: Array.isArray(data.sessions) ? data.sessions.slice(-500) : []};
  } catch { return {sessions: []}; }
}
let saving = Promise.resolve();
export function saveState(sessions) {
  const content = JSON.stringify({version: 1, sessions: sessions.slice(-500)}, null, 2);
  saving = saving.catch(() => {}).then(async () => {
    const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, content, {mode: 0o600}); await fs.rename(temporary, stateFile); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  });
  return saving;
}
async function prefix(file, length = 65536) {
  const handle = await fs.open(file, 'r');
  try { const buffer = Buffer.alloc(length); const {bytesRead} = await handle.read(buffer, 0, length, 0); return buffer.subarray(0, bytesRead).toString('utf8'); }
  finally { await handle.close(); }
}
export async function sessionMetadata(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) return null;
  let header, title;
  for (const line of (await prefix(file)).split('\n')) {
    try { const entry = JSON.parse(line); if (entry.type === 'session') header = entry; if (entry.type === 'title') title = entry.title; }
    catch { /* A partial final line is normal in live sessions. */ }
  }
  if (!header || typeof header.cwd !== 'string') return null;
  return {sessionFile: file, sessionId: header.id, name: typeof title === 'string' ? title.slice(0, 200) : 'Saved chat', cwd: header.cwd, updatedAt: stat.mtime.toISOString()};
}
export async function knownSessionPath(file) {
  if (typeof file !== 'string' || file.length > 32768 || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.jsonl') fail(400, 'Invalid native session file.');
  const real = await fs.realpath(file);
  const roots = await Promise.all([ownSessionDir, nativeSessionDir].map(item => fs.realpath(item).catch(() => null)));
  if (!roots.some(root => root && within(root, real))) fail(403, 'Session is outside the workspace session stores.');
  if (!(await fs.stat(real)).isFile()) fail(400, 'Invalid native session file.');
  return real;
}
export async function scanSaved(records) {
  const files = new Set(records.map(item => item.sessionFile).filter(item => typeof item === 'string'));
  let scanned = 0;
  for (const base of [ownSessionDir, nativeSessionDir]) {
    let directories;
    try { directories = await fs.readdir(base, {withFileTypes: true}); } catch { continue; }
    for (const child of directories.slice(0, 250)) {
      if (child.isFile() && child.name.endsWith('.jsonl')) files.add(path.join(base, child.name));
      if (!child.isDirectory()) continue;
      let items; try { items = await fs.readdir(path.join(base, child.name), {withFileTypes: true}); } catch { continue; }
      for (const item of items) {
        if (++scanned > 3000) break;
        if (item.isFile() && item.name.endsWith('.jsonl')) files.add(path.join(base, child.name, item.name));
      }
      if (scanned > 3000) break;
    }
  }
  const saved = new Map();
  for (const file of [...files].slice(-3000)) {
    try { const real = await knownSessionPath(file); const data = await sessionMetadata(real); if (data) saved.set(real, data); }
    catch { /* Sessions can disappear while the store is scanned. */ }
  }
  return saved;
}
export async function transcript(file) {
  const real = await knownSessionPath(file);
  const handle = await fs.open(real, 'r');
  let text, truncated = false;
  try {
    const stat = await handle.stat();
    truncated = stat.size > TEXT_LIMIT;
    const offset = Math.max(0, stat.size - TEXT_LIMIT);
    const buffer = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
    text = buffer.subarray(0, bytesRead).toString('utf8');
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
  } finally { await handle.close(); }
  const output = truncated ? ['[Showing the most recent 2 MiB of this session]\n'] : [];
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || !entry.message) continue;
      const message = entry.message;
      const content = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content : []).map(part => {
        if (part.type === 'text') return part.text || '';
        if (part.type === 'toolCall' || part.type === 'tool_use') return `[${part.name || 'tool'}]\n${JSON.stringify(part.arguments || part.input || {})}`;
        if (part.type === 'image') return '[image]';
        return '';
      }).filter(Boolean).join('\n');
      if (content) output.push(`## ${message.role || 'message'}${message.toolName ? ` · ${message.toolName}` : ''}\n${content}\n`);
    } catch { /* Ignore incomplete live JSONL entries. */ }
  }
  return output.join('\n').slice(-TEXT_LIMIT);
}
