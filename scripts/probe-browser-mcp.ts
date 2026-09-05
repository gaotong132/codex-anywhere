import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserSessionBroker } from '../src/browser-control/session-broker.js';
import { startBrowserEndpoint } from '../src/browser-control/local-endpoint.js';
import { resolveCodexExecutable } from '../src/connector/codex-executable.js';

// Explicit developer probe. Uses an ephemeral test task, never a business task.
if (process.argv.includes('--server')) {
  const server = new McpServer({ name: 'anywhere-browser-probe', version: '0.0.1' });
  server.registerTool('inspect_caller', {
    description: 'Read the host-supplied identity of this test call. No external access.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (_args, extra) => {
    const meta = extra._meta as Record<string, unknown> | undefined;
    const context = meta?.['x-codex-turn-metadata'] as Record<string, unknown> | undefined;
    return { content: [{ type: 'text', text: JSON.stringify({
      marker: 'anywhere-browser-probe', threadId: context?.thread_id ?? null,
      turnId: context?.turn_id ?? null, metaKeys: Object.keys(meta ?? {}),
    }) }] };
  });
  await server.connect(new StdioServerTransport());
} else {
  const writeProbe = process.argv.includes('--write');
  const integration = process.argv.includes('--integration') || writeProbe;
  const directory = integration ? await mkdtemp(join(tmpdir(), 'anywhere-live-browser-probe-')) : '';
  const endpointFile = join(directory, 'endpoint.json');
  const browserClient = { clientId: 'probe-client', clientDeviceId: 'probe-browser' };
  const broker = new BrowserSessionBroker('probe-environment', (frame: any) => {
    if (!['snapshot', ...(writeProbe ? ['click'] : [])].includes(frame.payload.operation.method)) return false;
    queueMicrotask(() => broker.result(browserClient, { ...frame.payload, ok: true,
      result: { marker: 'anywhere-browser-probe', threadId: frame.payload.threadId, turnId: frame.payload.turnId,
        method: frame.payload.operation.method, nodes: [{ ref: 'probe-button', tag: 'button', text: 'Synthetic increment' }],
        text: 'Synthetic fixture; no real webpage was accessed.' } }));
    return true;
  });
  const endpoint = integration ? await startBrowserEndpoint(broker, endpointFile) : undefined;
  const child = spawn(await resolveCodexExecutable(process.env.CODEX_BIN || 'codex'), ['app-server', '--listen', 'stdio://'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' },
  });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: Record<string, any>): void; reject(error: Error): void }>();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  let found = false;
  let writeFound = false;
  let expectedThread = '';
  const rejectPending = () => { for (const request of pending.values()) request.reject(new Error('probe_host_stopped')); pending.clear(); finish(); };
  child.on('error', rejectPending); child.on('exit', rejectPending);
  const timer = setTimeout(() => { child.kill(); rejectPending(); console.error('probe_timeout'); process.exitCode = 1; finish(); }, 90_000);
  child.stderr.on('data', () => {}); // Never print host logs or configuration.
  const rpc = (method: string, params: object) => new Promise<Record<string, any>>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame: Record<string, any>;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id && !frame.method && pending.has(frame.id)) {
      const request = pending.get(frame.id)!; pending.delete(frame.id);
      if (frame.error) request.reject(new Error(frame.error.message)); else request.resolve(frame.result);
      return;
    }
    if (frame.id && frame.method) {
      child.stdin.write(`${JSON.stringify({ id: frame.id, error: { code: -32601, message: 'Probe does not approve external operations' } })}\n`);
    }
    if (frame.method === 'item/completed' && frame.params?.item?.type === 'mcpToolCall') {
      const result = frame.params.item.result;
      const texts = (result?.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text);
      for (const text of texts) {
        try {
          const parsed = JSON.parse(text);
          const value = parsed.untrustedBrowserResult ?? parsed;
          if (value.marker === 'anywhere-browser-probe') {
            found = value.threadId === expectedThread && typeof value.turnId === 'string' && value.turnId.length > 0;
            if (found && value.method === 'click') writeFound = true;
            console.log(JSON.stringify({ metadataMatchesTask: found, integration, method: value.method, metaKeys: value.metaKeys }));
          }
        } catch { /* Ignore unrelated tool output. */ }
      }
    }
    if (frame.method === 'turn/completed') { console.log(JSON.stringify({ turnStatus: frame.params?.turn?.status, verified: found && (!writeProbe || writeFound) })); finish(); }
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'anywhere-browser-probe', version: '0.0.1' }, capabilities: { experimentalApi: true } });
    const thread = await rpc('thread/start', { cwd: process.cwd(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      config: { 'mcp_servers.anywhere_browser_probe': { command: process.execPath,
        args: integration ? ['--import', 'tsx', fileURLToPath(new URL('../src/browser-control/mcp-server.ts', import.meta.url)), endpointFile]
          : ['--import', 'tsx', fileURLToPath(import.meta.url), '--server'], required: true,
        ...(writeProbe ? { tools: { anywhere_browser_click: { approval_mode: 'approve' } } } : {}) } },
    });
    expectedThread = thread.thread.id;
    if (integration) {
      const grant = broker.bind(browserClient, expectedThread, { browserDeviceId: browserClient.clientDeviceId, tabId: 1, documentId: 'probe-document', origin: 'https://example.com' });
      broker.heartbeat(browserClient, grant.grantId);
    }
    console.log('Ephemeral test task started; only synthetic fixture tools are requested.');
    await rpc('turn/start', { threadId: expectedThread, input: [{ type: 'text', text: `Call the MCP tool anywhere_browser_probe.${integration ? 'anywhere_browser_snapshot' : 'inspect_caller'} once.${writeProbe ? ' Then use anywhere_browser_probe.anywhere_browser_click on the returned Synthetic increment button ref. This in-memory test click is explicitly authorized and changes no real website.' : ''} This is an authorized synthetic fixture. Do not use shell, web, files, or other tools. Then answer DONE.` }] });
    await completed;
    if (!found || (writeProbe && !writeFound)) process.exitCode = 1;
  } finally { clearTimeout(timer); child.kill(); await endpoint?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }
}
