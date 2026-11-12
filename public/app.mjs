import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { marked } from '/vendor/marked.mjs';
import DOMPurify from '/vendor/purify.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  workspace: null,
  visible: [],
  active: null,
  terminals: new Map(),
  tree: new Map(),
  expanded: new Set(['']),
  treeLoading: new Set(),
  treeEpoch: 0,
  filter: '',
  reader: { type: 'help' },
  readerEpoch: 0,
  zoom: false,
  socket: null,
  reconnectDelay: 700,
  reconnectTimer: null,
  stopped: false,
  starting: false,
  agentPolling: false,
  lastInputWarning: 0,
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text, title, handler, className = '') {
  const element = node('button', className, text);
  element.type = 'button';
  if (title) element.title = title;
  element.addEventListener('click', handler);
  return element;
}

function notice(message, error = false) {
  const element = node('div', `notice${error ? ' error' : ''}`);
  element.append(node('span', '', message), button('×', 'Dismiss', () => element.remove(), 'icon-button'));
  $('notices').append(element);
  while ($('notices').children.length > 4) $('notices').firstElementChild.remove();
  setTimeout(() => element.remove(), error ? 14000 : 6500);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new Error('Cannot reach the local workspace server. Check that it is still running.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`Unexpected server response (${response.status}). Reopen the launch URL if authentication expired.`); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function post(path, body = {}) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

function perform(action) {
  return Promise.resolve().then(action).catch((error) => notice(error.message, true));
}

function session(id) { return state.workspace?.sessions.find((item) => item.id === id); }
function live(item) { return item && !['exited', 'error'].includes(item.status); }
function isDirty() { return state.reader.type === 'file' && state.reader.draft !== state.reader.file.content; }
function canLeaveReader() { return !isDirty() || window.confirm('Discard unsaved file changes?'); }
function basename(path) { return path.split(/[\\/]/).filter(Boolean).pop() || path; }
function shortPath(path) {
  const root = state.workspace?.root;
  if (root && path?.toLowerCase().startsWith(root.toLowerCase())) return `.${path.slice(root.length)}`;
  return path || '';
}

function setConnection(connected) {
  $('connection').textContent = connected ? 'LIVE' : state.stopped ? 'STOPPED' : 'RECONNECTING';
  $('connection').className = `connection ${connected ? 'live' : 'offline'}`;
  document.body.classList.toggle('disconnected', !connected);
  renderFooter();
}

function renderFooter() {
  const current = session(state.active);
  const connected = state.socket?.readyState === WebSocket.OPEN;
  $('footer-status').textContent = state.stopped ? 'Workspace stopped' : !connected ? 'Disconnected · reconnecting to local server…' : current ? `${current.name || 'omp'} · ${current.status}${current.lastTool ? ` · ${current.lastTool}` : ''}` : 'Local workspace · no terminal selected';
  const record = state.terminals.get(state.active);
  $('footer-position').textContent = record ? `${record.term.cols} × ${record.term.rows}${state.zoom ? ' · zoomed' : ''}` : 'local';
}

function receiveWorkspace(workspace) {
  if (!workspace || !Array.isArray(workspace.sessions)) return;
  const oldRoot = state.workspace?.root;
  state.workspace = { ...workspace, savedChats: workspace.savedChats || [] };
  if (oldRoot && oldRoot !== workspace.root) {
    state.treeEpoch++;
    state.tree.clear();
    state.treeLoading.clear();
    state.expanded = new Set(['']);
    if (state.reader.type === 'file') {
      if (!isDirty()) showHelp(false);
      else {
        notice('The repository changed. Your unsaved edits are preserved, but cannot be saved into the new repository.', true);
        updateDirtyLabel();
      }
    }
    perform(() => loadDirectory(''));
  }
  $('repo-name').textContent = workspace.name || basename(workspace.root);
  $('choose-root').title = `Choose repository · ${workspace.root}`;
  $('root-path').textContent = workspace.root;
  $('root-path').title = workspace.root;
  $('branch').textContent = workspace.branch ? `⑂ ${workspace.branch}` : '';
  renderNavigator();
  for (const record of state.terminals.values()) updatePane(record);
  renderFooter();
  updateAgentLabel();
}

function renderNavigator() {
  renderTree();
  renderAgents();
  renderChats();
}

function makeNavItem(name, detail, status, handler, active = false) {
  const item = button('', `${name}${detail ? ` · ${detail}` : ''}`, handler, `nav-item${active ? ' active' : ''}`);
  const copy = node('span', 'item-copy');
  copy.append(node('span', 'item-name ellipsis', name), node('span', 'item-detail ellipsis', detail));
  item.append(node('span', `item-dot ${status || ''}`), copy);
  return item;
}

function renderChats() {
  const container = $('chats');
  container.replaceChildren();
  if (!state.workspace) return;
  const sessions = state.workspace.sessions;
  for (const item of sessions) {
    const shown = state.visible.includes(item.id);
    const detail = `${item.status}${shown ? ` · pane ${state.visible.indexOf(item.id) + 1}` : ' · hidden'} · ${shortPath(item.cwd)}`;
    container.append(makeNavItem(item.name || 'Untitled chat', detail, item.status, () => perform(() => !live(item) && item.sessionFile ? resumeChat(item.sessionFile) : showSession(item.id)), item.id === state.active));
  }
  const activeFiles = new Set(sessions.map((item) => item.sessionFile).filter(Boolean));
  const saved = state.workspace.savedChats.filter((item) => !activeFiles.has(item.sessionFile));
  if (saved.length) container.append(node('div', 'list-divider', 'SAVED CHATS'));
  for (const item of saved) {
    const date = item.updatedAt ? new Date(item.updatedAt) : null;
    const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'saved';
    container.append(makeNavItem(item.name || basename(item.sessionFile), `${dateText} · ${shortPath(item.cwd)}`, '', () => perform(() => resumeChat(item.sessionFile))));
  }
  if (!sessions.length && !saved.length) container.append(node('div', 'nav-empty', 'No chats yet. Start a real omp session with +.'));
}

function renderAgents() {
  const container = $('agents');
  container.replaceChildren();
  let count = 0;
  for (const pane of state.workspace?.sessions || []) {
    for (const agent of pane.agents || []) {
      count++;
      const selected = state.reader.type === 'agent' && state.reader.paneId === pane.id && state.reader.agentId === agent.id;
      container.append(makeNavItem(agent.kind === 'sub' ? agent.id : (agent.name || agent.id), `${agent.status || pane.status} · ${agent.lastTool || pane.name || 'omp'}`, agent.kind === 'sub' && !['exited', 'error', 'parked'].includes(agent.status) ? 'sub' : agent.status, () => perform(() => openAgent(pane.id, agent.id)), selected));
    }
  }
  if (!count) container.append(node('div', 'nav-empty', 'Agents appear when omp connects. Open Hub in a terminal for native agent controls.'));
}

async function loadDirectory(path) {
  if (state.treeLoading.has(path)) return;
  const epoch = state.treeEpoch;
  state.treeLoading.add(path);
  renderTree();
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(path)}`);
    if (epoch !== state.treeEpoch) return;
    state.tree.set(path, data.entries);
  } finally {
    if (epoch === state.treeEpoch) {
      state.treeLoading.delete(path);
      renderTree();
    }
  }
}

function matchesTree(entry, visited = new Set()) {
  const query = state.filter.toLowerCase();
  if (!query || entry.path.toLowerCase().includes(query)) return true;
  if (entry.kind !== 'directory' || visited.has(entry.path)) return false;
  visited.add(entry.path);
  return (state.tree.get(entry.path) || []).some((child) => matchesTree(child, visited));
}

function renderTree() {
  const container = $('tree');
  const oldScroll = container.scrollTop;
  const fragment = document.createDocumentFragment();
  const appendEntries = (path, depth) => {
    for (const entry of state.tree.get(path) || []) {
      if (!matchesTree(entry)) continue;
      const directory = entry.kind === 'directory';
      const expanded = state.expanded.has(entry.path) || (state.filter && state.tree.has(entry.path));
      const selected = state.reader.type === 'file' && state.reader.file.path === entry.path;
      const row = button('', entry.path, () => perform(async () => {
        if (!directory) return openFile(entry.path);
        if (state.expanded.has(entry.path)) state.expanded.delete(entry.path);
        else {
          state.expanded.add(entry.path);
          if (!state.tree.has(entry.path)) await loadDirectory(entry.path);
        }
        renderTree();
      }), `tree-row ${directory ? 'directory' : 'file'}${selected ? ' selected' : ''}`);
      row.style.paddingLeft = `${8 + depth * 13}px`;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      if (directory) row.setAttribute('aria-expanded', String(Boolean(expanded)));
      row.append(node('span', 'tree-chevron', directory ? expanded ? '⌄' : '›' : ''), node('span', 'tree-file-icon', directory ? '▱' : /\.(md|mdx)$/i.test(entry.name) ? '≡' : '·'), node('span', 'ellipsis', entry.name));
      fragment.append(row);
      if (directory && expanded) {
        if (state.treeLoading.has(entry.path)) {
          const loading = node('div', 'nav-empty', 'loading…');
          loading.style.paddingLeft = `${25 + depth * 13}px`;
          fragment.append(loading);
        } else appendEntries(entry.path, depth + 1);
      }
    }
  };
  appendEntries('', 0);
  if (!fragment.childNodes.length) fragment.append(node('div', 'nav-empty', state.treeLoading.has('') ? 'Loading repository…' : state.filter ? 'No loaded files match.' : 'No visible files in this folder.'));
  container.replaceChildren(fragment);
  container.scrollTop = oldScroll;
}

function send(message) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > 1024 * 1024) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function attach(record) {
  if (!state.visible.includes(record.id) || !record.body.getClientRects().length) return;
  const socket = state.socket;
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (record.attachedSocket === socket) return;
  if (send({ type: 'attach', id: record.id, cols: record.term.cols, rows: record.term.rows })) record.attachedSocket = socket;
}

function fitTerminal(record) {
  if (!state.visible.includes(record.id) || !record.body.getClientRects().length) return;
  try {
    const dimensions = record.fit.proposeDimensions();
    if (!dimensions) return;
    const cols = Math.max(20, Math.min(400, dimensions.cols));
    const rows = Math.max(5, Math.min(200, dimensions.rows));
    if (record.term.cols !== cols || record.term.rows !== rows) {
      record.term.resize(cols, rows);
      if (record.attachedSocket === state.socket) send({ type: 'resize', id: record.id, cols, rows });
    }
    attach(record);
    if (state.active === record.id) renderFooter();
  } catch (error) {
    console.warn('Terminal sizing deferred:', error.message);
  }
}

function scheduleFit(record) {
  if (record.fitFrame) cancelAnimationFrame(record.fitFrame);
  record.fitFrame = requestAnimationFrame(() => { record.fitFrame = null; fitTerminal(record); });
}

function fitAll() {
  for (const id of state.visible) {
    const record = state.terminals.get(id);
    if (record) scheduleFit(record);
  }
}

function createTerminal(id) {
  if (state.terminals.has(id)) return state.terminals.get(id);
  const element = node('section', 'terminal-pane');
  element.dataset.session = id;
  const heading = node('div', 'pane-heading');
  const number = node('span', 'pane-number');
  const dot = node('span', 'item-dot');
  const name = node('span', 'pane-name ellipsis');
  const actions = node('div', 'pane-actions');
  actions.append(
    button('◫', 'Split · Ctrl+Alt+S', () => perform(() => splitSession(id)), 'icon-button'),
    button('⛶', 'Zoom · Ctrl+Shift+Enter', () => toggleZoom(id), 'icon-button'),
    button('−', 'Hide terminal (keeps chat running)', () => hideSession(id), 'icon-button'),
    button('×', 'Stop this terminal', () => perform(() => closeSession(id)), 'icon-button'),
  );
  heading.append(number, dot, name, actions);
  const body = node('div', 'terminal-body');
  const meta = node('div', 'pane-meta');
  const cwd = node('span', 'pane-cwd ellipsis');
  const model = node('span', 'pane-model ellipsis');
  meta.append(cwd, model);
  element.append(heading, body, meta);
  $('terminal-storage').append(element);
  const term = new Terminal({
    fontFamily: "'Cascadia Code', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    fontSize: 12.5,
    lineHeight: 1.14,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10000,
    allowProposedApi: false,
    convertEol: false,
    theme: {
      background: '#151719', foreground: '#d0d0ca', cursor: '#e6b46a', cursorAccent: '#151719',
      selectionBackground: '#6c665b70', selectionInactiveBackground: '#5e62664a',
      black: '#202226', red: '#d5837b', green: '#98b78c', yellow: '#dbba7c',
      blue: '#8daac4', magenta: '#b39ac0', cyan: '#84b6b6', white: '#d0d0ca',
      brightBlack: '#737a85', brightRed: '#e7988e', brightGreen: '#b4cca0', brightYellow: '#e9cb93',
      brightBlue: '#adc6dd', brightMagenta: '#cbb2d9', brightCyan: '#a5d2ce', brightWhite: '#eee8dc',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  const record = { id, element, heading, number, dot, name, body, cwd, model, term, fit, attachedSocket: null, fitFrame: null };
  state.terminals.set(id, record);
  record.observer = new ResizeObserver(() => scheduleFit(record));
  record.observer.observe(body);
  body.addEventListener('focusin', () => setActive(id, false));
  heading.addEventListener('pointerdown', (event) => { if (!event.target.closest('button')) setActive(id); });
  term.onData((data) => {
    if (send({ type: 'input', id, data })) return;
    if (Date.now() - state.lastInputWarning > 4000) {
      state.lastInputWarning = Date.now();
      notice('Terminal input was not sent: connection unavailable or busy. Wait for LIVE before typing.', true);
    }
  });
  updatePane(record);
  return record;
}

function updatePane(record) {
  const item = session(record.id);
  if (!item) return;
  record.number.textContent = `${state.visible.indexOf(record.id) + 1}`.padStart(2, '0');
  record.name.textContent = item.name || 'omp';
  record.name.title = `${item.name || 'omp'} · ${item.status}`;
  record.dot.className = `item-dot ${item.status}`;
  record.cwd.textContent = shortPath(item.cwd);
  record.cwd.title = item.cwd || '';
  record.model.textContent = item.status === 'exited' ? `exited ${item.exitCode ?? ''}` : item.model || item.lastTool || item.status;
  record.model.title = [item.model, item.lastTool, item.status].filter(Boolean).join(' · ');
  record.model.classList.toggle('pane-exited', !live(item));
  record.element.classList.toggle('focused', record.id === state.active);
}

function rememberPanes() {
  try {
    sessionStorage.setItem('omp-workspace-panes', JSON.stringify({ visible: state.visible, active: state.active }));
  } catch { /* Storage may be unavailable in a restricted browser profile. */ }
}

function renderPanes() {
  const center = $('terminals');
  for (const record of state.terminals.values()) {
    if (!state.visible.includes(record.id) && record.element.parentElement === center) {
      if (record.attachedSocket === state.socket) send({ type: 'detach', id: record.id });
      record.attachedSocket = null;
      $('terminal-storage').append(record.element);
    }
  }
  state.visible.forEach((id, index) => {
    const record = createTerminal(id);
    const position = [...center.children].filter((child) => child !== $('empty-terminals'))[index];
    if (position !== record.element) center.insertBefore(record.element, position || null);
    updatePane(record);
    scheduleFit(record);
  });
  $('empty-terminals').hidden = state.visible.length > 0;
  document.body.classList.toggle('pane-zoomed', state.zoom);
  renderChats();
  renderFooter();
  rememberPanes();
}

function setActive(id, focus = true) {
  if (!state.visible.includes(id)) return;
  const changed = state.active !== id;
  state.active = id;
  rememberPanes();
  for (const record of state.terminals.values()) record.element.classList.toggle('focused', record.id === id);
  if (changed) {
    renderChats();
    renderFooter();
    if (state.zoom) fitAll();
  }
  if (focus) state.terminals.get(id)?.term.focus();
}

async function showSession(id, newSlot = false) {
  if (!session(id)) throw new Error('This session is no longer available.');
  if (state.visible.includes(id)) {
    setActive(id);
    return;
  }
  if (!state.visible.length || (newSlot && state.visible.length < 2)) state.visible.push(id);
  else {
    const index = Math.max(0, state.visible.indexOf(state.active));
    state.visible[index] = id;
  }
  state.active = id;
  renderPanes();
  requestAnimationFrame(() => state.terminals.get(id)?.term.focus());
}

async function newSession(split = false) {
  if (state.starting) return;
  if (split && state.visible.length >= 2) {
    notice('Two terminals are already visible. Hide a pane first, or use New chat to switch the focused pane.');
    return;
  }
  state.starting = true;
  $('new-chat').disabled = $('split-pane').disabled = true;
  try {
    const item = await post('/api/sessions');
    if (!state.workspace.sessions.some((current) => current.id === item.id)) state.workspace.sessions.push(item);
    else Object.assign(session(item.id), item);
    await showSession(item.id, split);
  } finally {
    state.starting = false;
    $('new-chat').disabled = $('split-pane').disabled = false;
  }
}

async function resumeChat(sessionFile) {
  const existing = state.workspace.sessions.find((item) => item.sessionFile === sessionFile && live(item));
  if (existing) return showSession(existing.id);
  const item = await post('/api/sessions', { sessionFile });
  if (!session(item.id)) state.workspace.sessions.push(item);
  await showSession(item.id);
}

async function splitSession(id = state.active) {
  if (id) setActive(id, false);
  return newSession(true);
}

function hideSession(id) {
  const index = state.visible.indexOf(id);
  if (index < 0) return;
  state.visible.splice(index, 1);
  if (state.active === id) state.active = state.visible[Math.min(index, state.visible.length - 1)] || null;
  if (!state.visible.length) state.zoom = false;
  renderPanes();
  if (state.active) setActive(state.active);
}

async function closeSession(id) {
  const item = session(id);
  if (live(item) && !window.confirm(`Stop “${item.name || 'omp'}”? This ends the live process; its saved chat is kept.`)) return;
  await post(`/api/sessions/${encodeURIComponent(id)}/close`);
  hideSession(id);
  const record = state.terminals.get(id);
  if (record) {
    record.observer.disconnect();
    if (record.fitFrame) cancelAnimationFrame(record.fitFrame);
    record.term.dispose();
    record.element.remove();
    state.terminals.delete(id);
  }
  receiveWorkspace(await api('/api/workspace'));
}

function toggleZoom(id = state.active) {
  if (!id) return;
  setActive(id, false);
  state.zoom = !state.zoom;
  document.body.classList.toggle('pane-zoomed', state.zoom);
  fitAll();
  state.terminals.get(id)?.term.focus();
  renderFooter();
}

function showReader(show = true) {
  document.body.classList.toggle('reader-hidden', !show);
  $('toggle-reader').setAttribute('aria-pressed', String(show));
  fitAll();
}

function toggleReader() { showReader(document.body.classList.contains('reader-hidden')); }

function readerTitle(title, detail) {
  const heading = node('div', 'reader-title');
  heading.append(node('h1', '', title), node('div', 'reader-subtitle', detail));
  return heading;
}

function showHelp(reveal = true) {
  if (!canLeaveReader()) return;
  state.readerEpoch++;
  state.reader = { type: 'help' };
  $('reader-kind').textContent = 'WORKSPACE';
  const content = node('div', 'reader-scroll markdown');
  content.append(node('div', 'help-eyebrow', 'YOUR LOCAL DEVELOPMENT DESK'), node('h1', 'help-title', 'Less switching.\nMore building.'), node('p', 'help-lead', 'Real omp terminals, your repository, and live agent context — in one workspace.'));
  content.append(node('h2', '', 'Start here'), node('p', '', 'Type directly into the terminal. Everything there is native omp: prompts, tools, permissions, history, and keyboard shortcuts. Split opens an independent chat. Hidden chats keep running.'));
  const shortcuts = node('div', 'shortcut-list');
  for (const [label, keys] of [['New chat', 'Ctrl Alt N'], ['Split terminal', 'Ctrl Alt S'], ['Toggle reader', 'Ctrl Alt R'], ['Focus terminal', 'Alt 1 / Alt 2'], ['Zoom focused pane', 'Ctrl Shift Enter'], ['Save file in editor', 'Ctrl S'], ['Native Agent Hub', 'Alt A']]) shortcuts.append(node('span', '', label), node('kbd', '', keys));
  content.append(shortcuts, node('h2', '', 'Read. Edit. Steer.'), node('p', '', 'Select a file to read Markdown or source, then choose Edit to make and save changes. Select an agent to follow its read-only transcript and send steering to its live context. Explorer filters files in folders you have loaded.'));
  const commands = node('pre');
  commands.append(node('code', '', '/workspace-read README.md\n/workspace-split\n/workspace-rename My chat'));
  content.append(node('h2', '', 'From inside omp'), commands, node('p', 'help-note', 'Drag the vertical dividers to resize. Use the repository menu to choose a folder. Closing a pane with × stops that process; − only hides it. No terminal input is queued while disconnected.'));
  const stopButton = button('Stop workspace', 'Stop all chats and the local workspace server', () => perform(async () => {
    if (!window.confirm('Stop every chat in this workspace and shut down the local server? Saved conversations are kept.')) return;
    await post('/api/shutdown');
    state.stopped = true;
    clearTimeout(state.reconnectTimer);
    setConnection(false);
    for (const record of state.terminals.values()) record.term.options.disableStdin = true;
    stopButton.disabled = true;
    notice('Workspace stopped. Launch omp-workspace to reopen.');
  }));
  content.append(node('h2', '', 'End this workspace'), node('p', '', 'Closing the window leaves chats running. Stop everything here when you are finished; saved conversations are kept.'), stopButton);
  $('reader-content').replaceChildren(content);
  if (reveal) showReader();
  renderNavigator();
}

async function openFile(path) {
  if (!canLeaveReader()) return;
  const epoch = ++state.readerEpoch;
  const root = state.workspace.root;
  state.reader = { type: 'loading' };
  $('reader-kind').textContent = 'FILE';
  $('reader-content').replaceChildren(node('div', 'reader-message', 'Reading file…'));
  showReader();
  try {
    const file = await api(`/api/file?path=${encodeURIComponent(path)}`);
    if (epoch !== state.readerEpoch) return;
    if (root !== state.workspace.root) throw new Error('The repository changed while reading this file. Open the file again.');
    const markdown = /\.(md|markdown|mdown)$/i.test(file.path) || file.language === 'markdown';
    state.reader = { type: 'file', file, root, draft: file.content, mode: markdown ? 'preview' : 'source', markdown, saving: false };
    renderFile();
    renderTree();
  } catch (error) {
    if (epoch !== state.readerEpoch) return;
    state.reader = { type: 'error' };
    $('reader-content').replaceChildren(node('div', 'reader-message', error.message), button('Retry', 'Read file again', () => perform(() => openFile(path))));
    throw error;
  }
}

function renderFile() {
  const reader = state.reader;
  if (reader.type !== 'file') return;
  const file = reader.file;
  $('reader-kind').textContent = reader.markdown ? 'MARKDOWN / FILE' : 'SOURCE / FILE';
  const toolbar = node('div', 'reader-toolbar');
  const modes = reader.markdown ? ['preview', 'source', 'edit'] : ['source', 'edit'];
  for (const mode of modes) {
    const control = button(mode[0].toUpperCase() + mode.slice(1), `${mode} file`, () => { reader.mode = mode; renderFile(); }, reader.mode === mode ? 'selected' : '');
    control.disabled = reader.saving;
    toolbar.append(control);
  }
  const save = button(reader.saving ? 'Saving…' : 'Save', 'Save file · Ctrl+S', () => perform(saveFile), 'save-button');
  save.disabled = !isDirty() || reader.saving;
  toolbar.append(save);
  reader.saveButton = save;
  const title = readerTitle(basename(file.path), file.path);
  const note = node('div', 'file-note');
  reader.note = note;
  let body;
  if (reader.mode === 'edit') {
    body = node('textarea', 'file-editor');
    body.value = reader.draft;
    body.spellcheck = false;
    body.setAttribute('aria-label', `Edit ${file.path}`);
    body.readOnly = reader.saving;
    body.addEventListener('input', () => { reader.draft = body.value; updateDirtyLabel(); });
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        body.setRangeText('  ', body.selectionStart, body.selectionEnd, 'end');
        body.dispatchEvent(new Event('input'));
      }
    });
  } else if (reader.mode === 'preview') {
    body = node('div', 'reader-scroll markdown');
    body.innerHTML = DOMPurify.sanitize(marked.parse(reader.draft, { gfm: true, breaks: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'iframe', 'object', 'embed', 'img', 'link', 'meta'], FORBID_ATTR: ['style'] });
    for (const link of body.querySelectorAll('a')) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('#') && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//')) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          perform(async () => {
            const relative = decodeURIComponent(href.split(/[?#]/)[0]).replaceAll('\\', '/');
            const parts = relative.startsWith('/') ? [] : file.path.replaceAll('\\', '/').split('/').slice(0, -1);
            for (const part of relative.split('/')) {
              if (!part || part === '.') continue;
              if (part === '..') {
                if (!parts.length) throw new Error('This link points outside the repository.');
                parts.pop();
              } else parts.push(part);
            }
            await openFile(parts.join('/'));
          });
        });
      } else if (href?.startsWith('#')) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          perform(() => {
            const target = body.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
            target?.scrollIntoView({ block: 'start' });
          });
        });
      } else {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }
  } else {
    body = node('div', 'reader-scroll reader-source');
    const count = reader.draft.split('\n').length;
    const numbers = node('pre', 'line-numbers', Array.from({ length: count }, (_, index) => index + 1).join('\n'));
    numbers.setAttribute('aria-hidden', 'true');
    body.append(numbers, node('pre', 'source-code', reader.draft));
  }
  $('reader-content').replaceChildren(title, toolbar, body, note);
  updateDirtyLabel();
  if (reader.mode === 'edit') body.focus();
}

function updateDirtyLabel() {
  const reader = state.reader;
  if (reader.type !== 'file' || !reader.note) return;
  const dirty = isDirty();
  const wrongRoot = reader.root !== state.workspace?.root;
  reader.note.textContent = wrongRoot ? 'Repository changed · copy your edits before reopening this file' : dirty ? '● Unsaved changes · Ctrl+S to save' : reader.mode === 'edit' ? 'Saved · Ctrl+S to save · existing files only' : 'Read-only view · choose Edit to modify';
  reader.note.classList.toggle('dirty', dirty || wrongRoot);
  reader.saveButton.disabled = !dirty || reader.saving || wrongRoot;
}

async function saveFile() {
  const reader = state.reader;
  if (reader.type !== 'file' || reader.saving || !isDirty()) return;
  if (reader.root !== state.workspace?.root) throw new Error('The repository changed. Copy your unsaved edits before reopening this file in its original repository.');
  reader.saving = true;
  if (reader.saveButton) { reader.saveButton.disabled = true; reader.saveButton.textContent = 'Saving…'; }
  const savedDraft = reader.draft;
  try {
    const file = await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: reader.file.path, content: savedDraft, version: reader.file.version }) });
    if (state.reader !== reader) return;
    reader.file = file;
    if (reader.draft === savedDraft) reader.draft = file.content;
    notice(`Saved ${file.path}`);
  } catch (error) {
    throw new Error(`Could not save ${reader.file.path}: ${error.message} Your edits are preserved. If the file changed on disk, copy your changes before reopening it.`);
  } finally {
    reader.saving = false;
    if (state.reader === reader) {
      reader.saveButton.textContent = 'Save';
      updateDirtyLabel();
    }
  }
}

function selectedAgent() {
  const reader = state.reader;
  if (reader.type !== 'agent') return null;
  return session(reader.paneId)?.agents?.find((agent) => agent.id === reader.agentId);
}

function updateAgentLabel() {
  const reader = state.reader;
  if (reader.type !== 'agent' || !reader.subtitle) return;
  const agent = selectedAgent();
  reader.subtitle.textContent = reader.pollError ? `Transcript refresh unavailable · ${reader.pollError}` : `${agent?.status || 'unknown'} · read-only transcript${agent?.lastTool ? ` · ${agent.lastTool}` : ''}`;
}

async function openAgent(paneId, agentId) {
  if (!canLeaveReader()) return;
  state.readerEpoch++;
  const agent = session(paneId)?.agents?.find((item) => item.id === agentId);
  const reader = { type: 'agent', paneId, agentId, content: null };
  state.reader = reader;
  $('reader-kind').textContent = 'AGENT / TRANSCRIPT';
  const title = readerTitle(agent?.kind === 'sub' ? agentId : (agent?.name || agentId), 'Loading transcript…');
  reader.subtitle = title.querySelector('.reader-subtitle');
  const scroll = node('div', 'reader-scroll');
  reader.scroll = scroll;
  reader.transcript = node('pre', 'agent-transcript', 'Loading live agent transcript…');
  scroll.append(reader.transcript);
  const form = node('form', 'agent-steer');
  const label = node('label', '', 'STEER LIVE AGENT');
  label.htmlFor = 'steer-input';
  const row = node('div', 'steer-row');
  const input = node('input');
  input.id = 'steer-input';
  input.placeholder = 'Send a direction…';
  input.required = true;
  input.maxLength = 20000;
  input.autocomplete = 'off';
  const submit = node('button', '', 'Send ↗');
  submit.type = 'submit';
  row.append(input, submit);
  const feedback = node('div', 'reader-subtitle');
  feedback.setAttribute('role', 'status');
  feedback.style.marginTop = '7px';
  feedback.textContent = 'Steering is available only while this agent is live.';
  form.append(label, row, feedback);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || submit.disabled) return;
    submit.disabled = true;
    feedback.textContent = 'Sending…';
    post(`/api/agents/${encodeURIComponent(paneId)}/${encodeURIComponent(agentId)}/steer`, { message })
      .then(() => { input.value = ''; feedback.textContent = 'Queued for the live agent. Watch its transcript for the response.'; })
      .catch((error) => { feedback.textContent = error.message; notice(error.message, true); })
      .finally(() => { submit.disabled = false; });
  });
  $('reader-content').replaceChildren(title, scroll, form);
  showReader();
  updateAgentLabel();
  renderAgents();
  await pollAgent();
}

async function pollAgent() {
  const reader = state.reader;
  if (reader.type !== 'agent' || state.agentPolling || document.hidden || document.body.classList.contains('reader-hidden')) return;
  state.agentPolling = true;
  try {
    const data = await api(`/api/agents/${encodeURIComponent(reader.paneId)}/${encodeURIComponent(reader.agentId)}`);
    if (state.reader !== reader) return;
    reader.pollError = null;
    updateAgentLabel();
    if (reader.content !== data.content) {
      const atBottom = reader.content === null || reader.scroll.scrollTop + reader.scroll.clientHeight >= reader.scroll.scrollHeight - 70;
      const previousScroll = reader.scroll.scrollTop;
      reader.transcript.textContent = data.content || 'No transcript entries yet.';
      reader.content = data.content;
      reader.scroll.scrollTop = atBottom ? reader.scroll.scrollHeight : previousScroll;
    }
  } catch (error) {
    if (state.reader === reader) {
      reader.pollError = error.message;
      updateAgentLabel();
      if (reader.content === null) reader.transcript.textContent = error.message;
    }
  } finally { state.agentPolling = false; }
}

function connect() {
  if (state.stopped) return;
  clearTimeout(state.reconnectTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (state.socket !== socket) return;
    state.reconnectDelay = 700;
    setConnection(true);
    for (const id of state.visible) {
      const record = state.terminals.get(id);
      if (record) { fitTerminal(record); attach(record); }
    }
    perform(async () => receiveWorkspace(await api('/api/workspace')));
  });
  socket.addEventListener('message', (event) => {
    if (state.socket !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { notice('Received an invalid workspace event.', true); return; }
    const record = state.terminals.get(message.id);
    switch (message.type) {
      case 'output':
        if (record) record.term.write(message.data);
        break;
      case 'reset':
        if (record) { record.term.reset(); record.term.write(message.data || ''); }
        break;
      case 'workspace': receiveWorkspace(message.workspace || message); break;
      case 'read': perform(() => openFile(message.path)); break;
      case 'split': perform(() => splitSession(message.paneId)); break;
      case 'error': notice(message.error || 'Terminal connection error.', true); break;
      case 'exit':
        if (session(message.id)) {
          Object.assign(session(message.id), { status: 'exited', exitCode: message.exitCode });
          if (record) updatePane(record);
          renderChats();
          renderFooter();
        }
        break;
    }
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    for (const record of state.terminals.values()) record.attachedSocket = null;
    setConnection(false);
    if (!state.stopped) {
      state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
      state.reconnectDelay = Math.min(10000, state.reconnectDelay * 1.7);
    }
  });
  socket.addEventListener('error', () => { if (state.socket === socket) setConnection(false); });
}

function setWidth(name, value) {
  document.documentElement.style.setProperty(name, `${Math.round(value)}px`);
  fitAll();
}

function configureResizer(id, variable, direction, minimum, maximum) {
  const handle = $(id);
  const currentWidth = () => (variable === '--nav-width' ? $('navigator') : $('reader')).getBoundingClientRect().width;
  const clamp = (width) => Math.max(minimum, Math.min(maximum, Math.floor(window.innerWidth * .45), width));
  const persist = () => { try { localStorage.setItem(variable, String(currentWidth())); } catch { /* Storage may be disabled. */ } };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const width = currentWidth();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (next) => setWidth(variable, clamp(width + (next.clientX - start) * direction));
    const finish = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      persist();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    setWidth(variable, clamp(currentWidth() + (event.key === 'ArrowRight' ? 15 : -15) * direction));
    persist();
  });
  try {
    const saved = Number(localStorage.getItem(variable));
    if (saved >= minimum && saved <= maximum) setWidth(variable, clamp(saved));
  } catch { /* Storage may be disabled. */ }
}

$('new-chat').addEventListener('click', () => perform(() => newSession()));
$('sidebar-new').addEventListener('click', () => perform(() => newSession()));
$('empty-new').addEventListener('click', () => perform(() => newSession()));
$('split-pane').addEventListener('click', () => perform(() => splitSession()));
$('toggle-reader').addEventListener('click', toggleReader);
$('close-reader').addEventListener('click', () => showReader(false));
$('show-help').addEventListener('click', () => showHelp());
$('toggle-nav').addEventListener('click', () => { document.body.classList.toggle('nav-hidden'); fitAll(); });
$('agent-hub').addEventListener('click', () => {
  if (!state.active) { notice('Select a live terminal first.'); return; }
  if (!send({ type: 'input', id: state.active, data: '\u001ba' })) notice('Agent Hub could not open while disconnected.', true);
  state.terminals.get(state.active)?.term.focus();
});
$('tree-filter').addEventListener('input', (event) => { state.filter = event.target.value.trim(); renderTree(); });
$('refresh-tree').addEventListener('click', () => perform(async () => {
  state.treeEpoch++;
  state.treeLoading.clear();
  state.tree.clear();
  await loadDirectory('');
  for (const path of state.expanded) if (path) await loadDirectory(path);
}));
$('choose-root').addEventListener('click', () => {
  $('root-input').value = state.workspace?.root || '';
  $('root-error').textContent = '';
  $('root-dialog').showModal();
  $('root-input').focus();
  $('root-input').select();
});
$('cancel-root').addEventListener('click', () => $('root-dialog').close());
$('root-cancel-button').addEventListener('click', () => $('root-dialog').close());
$('root-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!canLeaveReader()) return;
  const path = $('root-input').value.trim();
  if (!path) return;
  $('root-submit').disabled = true;
  $('root-error').textContent = '';
  post('/api/root', { path }).then((workspace) => {
    if (state.reader.type === 'file') { state.reader = { type: 'help' }; showHelp(false); }
    receiveWorkspace(workspace);
    $('root-dialog').close();
  }).catch((error) => { $('root-error').textContent = error.message; }).finally(() => { $('root-submit').disabled = false; });
});

document.addEventListener('keydown', (event) => {
  if ($('root-dialog').open) return;
  if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    if (['n', 's', 'r'].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (key === 'n') perform(() => newSession());
      if (key === 's') perform(() => splitSession());
      if (key === 'r') toggleReader();
    }
  } else if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && ['1', '2'].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    const id = state.visible[Number(event.key) - 1];
    if (id) setActive(id);
  } else if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    toggleZoom();
  } else if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 's' && event.target.classList.contains('file-editor')) {
    event.preventDefault();
    perform(saveFile);
  }
}, true);

window.addEventListener('beforeunload', (event) => {
  if (isDirty()) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('resize', fitAll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { fitAll(); perform(pollAgent); }
});
setInterval(() => { pollAgent(); }, 3000);
configureResizer('nav-resizer', '--nav-width', 1, 160, 380);
configureResizer('reader-resizer', '--reader-width', -1, 260, 800);
if (window.innerWidth < 1150) showReader(false);
if (window.innerWidth < 850) document.body.classList.add('nav-hidden');
showHelp(false);

async function initialize() {
  try {
    receiveWorkspace(await api('/api/workspace'));
    connect();
    perform(() => loadDirectory(''));
    const running = state.workspace.sessions.filter(live);
    let previous;
    try { previous = JSON.parse(sessionStorage.getItem('omp-workspace-panes')); } catch { /* Restore live panes without saved layout. */ }
    const remembered = Array.isArray(previous?.visible) ? previous.visible.filter((id) => running.some((item) => item.id === id)).slice(0, 2) : [];
    if (running.length) {
      state.visible = remembered.length ? remembered : running.slice(0, 2).map((item) => item.id);
      state.active = state.visible.includes(previous?.active) ? previous.active : state.visible[0];
      renderPanes();
      setActive(state.active);
    } else await newSession();
  } catch (error) {
    notice(error.message, true);
    $('footer-status').textContent = 'Unable to start workspace · reopen the launcher URL or retry';
    $('connection').textContent = 'OFFLINE';
    $('connection').className = 'connection offline';
    const retry = button('Retry connection', 'Retry workspace initialization', () => { retry.remove(); initialize(); }, 'primary-button');
    $('empty-terminals').append(retry);
  }
}
initialize();
