import { existsSync } from 'node:fs';

// Loaded explicitly for workspace-owned terminals; never installed into global omp config.
export default function workspaceBridge(pi) {
  const base = process.env.OMP_WORKSPACE_URL;
  const token = process.env.OMP_WORKSPACE_TOKEN;
  const paneId = process.env.OMP_WORKSPACE_PANE;
  if (!base || !token || !paneId) return;

  let context;
  let status = 'idle';
  let lastTool = '';
  let heartbeat;
  let polling;
  let pending;
  let posting = false;
  let pollBusy = false;
  let stopped = false;
  let warned = false;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  function snapshot(ctx) {
    // Native sessions are lazy: the path exists only after a persisted entry.
    const sessionFile = ctx.sessionManager.getSessionFile();
    const identity = ctx.agent;
    return {
      paneId,
      agent: { id: identity?.id || 'main', kind: identity?.kind || 'main', name: identity?.name || 'Main' },
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: sessionFile && existsSync(sessionFile) ? sessionFile : undefined,
      cwd: ctx.cwd,
      name: pi.getSessionName(),
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      status,
      lastTool,
    };
  }

  async function request(route, options = {}) {
    const response = await fetch(`${base}${route}`, {
      ...options, headers, signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).error; } catch { /* HTTP status still identifies the failure. */ }
      throw new Error(detail || `Workspace returned HTTP ${response.status}`);
    }
    return response.json();
  }

  function report(error) {
    if (warned || stopped) return;
    warned = true;
    pi.logger?.warn?.(`Workspace bridge unavailable: ${error.message}`);
  }

  async function drain() {
    if (posting) return;
    posting = true;
    try {
      while (pending) {
        const payload = pending;
        pending = undefined;
        try {
          await request('/api/bridge', { method: 'POST', body: JSON.stringify(payload) });
          warned = false;
        } catch (error) { report(error); }
      }
    } finally { posting = false; }
  }

  function publish(ctx) {
    context = ctx;
    pending = snapshot(ctx);
    void drain().catch(report);
  }

  async function poll() {
    if (pollBusy || stopped || !context) return;
    pollBusy = true;
    try {
      const agentId = snapshot(context).agent.id;
      const query = new URLSearchParams({ paneId, agentId });
      const result = await request(`/api/bridge/commands?${query}`);
      for (const command of result.commands) {
        if (command.type === 'steer' && typeof command.message === 'string') {
          // Omitted deliverAs starts idle agents and steers running agents.
          await pi.sendUserMessage(command.message);
        }
      }
    } catch (error) { report(error); }
    finally { pollBusy = false; }
  }

  pi.setLabel('OMP Workspace');
  pi.on('session_start', (_event, ctx) => {
    if (context && heartbeat) context.clearTimer(heartbeat);
    if (context && polling) context.clearTimer(polling);
    stopped = false;
    status = 'idle';
    publish(ctx);
    heartbeat = ctx.setInterval(() => publish(context), 3000);
    polling = ctx.setInterval(poll, 900);
  });
  for (const event of ['session_switch', 'session_branch', 'session_tree', 'model_select']) {
    pi.on(event, (_event, ctx) => publish(ctx));
  }
  pi.on('agent_start', (_event, ctx) => { status = 'running'; publish(ctx); });
  pi.on('agent_end', (_event, ctx) => { status = 'idle'; lastTool = ''; publish(ctx); });
  pi.on('tool_execution_start', (event, ctx) => {
    status = 'running';
    lastTool = event.toolName || '';
    publish(ctx);
  });
  pi.on('tool_execution_end', (_event, ctx) => publish(ctx));
  pi.on('session_shutdown', async (_event, ctx) => {
    stopped = true;
    if (heartbeat) ctx.clearTimer(heartbeat);
    if (polling) ctx.clearTimer(polling);
    status = ctx.agent?.kind === 'sub' ? 'parked' : 'exited';
    pending = undefined;
    try {
      await request('/api/bridge', { method: 'POST', body: JSON.stringify(snapshot(ctx)) });
    } catch { /* The workspace may already have closed its server. */ }
  });

  async function action(ctx, payload) {
    try {
      await request('/api/bridge', { method: 'POST', body: JSON.stringify({ ...snapshot(ctx), action: payload }) });
    } catch (error) { ctx.ui.notify(error.message, 'error'); }
  }
  pi.registerCommand('workspace-read', {
    description: 'Open a repository file in the workspace reader',
    handler: async (args, ctx) => {
      let path = args.trim();
      if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
      if (!path) return ctx.ui.notify('Usage: /workspace-read path/to/file', 'warning');
      await action(ctx, { type: 'read', path });
    },
  });
  pi.registerCommand('workspace-split', {
    description: 'Open a second independent omp chat beside this one',
    handler: async (args, ctx) => action(ctx, { type: 'split', name: args.trim() || undefined }),
  });
  pi.registerCommand('workspace-rename', {
    description: 'Name this chat in omp and the workspace sidebar',
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) return ctx.ui.notify('Usage: /workspace-rename chat title', 'warning');
      await pi.setSessionName(name);
      await action(ctx, { type: 'rename', name });
    },
  });
}
