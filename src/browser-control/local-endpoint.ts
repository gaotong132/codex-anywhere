import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, chmod, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { secretMatches } from '../shared/protocol.js';
import { requireBrowserId } from './contracts.js';
import { parseOperation } from './operations.js';
import type { BrowserSessionBroker } from './session-broker.js';

// Private loopback IPC; the token is read by stdio MCP, never passed to the model.
export async function startBrowserEndpoint(broker: BrowserSessionBroker, stateFile: string) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'POST' || request.url !== '/call' || request.headers.origin
      || !secretMatches(request.headers.authorization, `Bearer ${token}`)) {
      response.writeHead(403).end('{"error":"browser_ipc_denied"}'); return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 12_000) throw new Error('browser_invalid_request');
      }
      const input = JSON.parse(body);
      const result = await broker.execute(requireBrowserId(input.threadId), requireBrowserId(input.turnId), parseOperation(input.operation));
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error instanceof Error && /^browser_[a-z_]+$/.test(error.message) ? error.message : 'browser_operation_failed' }));
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('browser_endpoint_unavailable');
  const path = resolve(stateFile);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ port: address.port, token, environmentId: broker.environmentId }), { mode: 0o600 });
    await chmod(path, 0o600);
  } catch (error) { server.close(); throw error; }
  return {
    async close() {
      broker.clear(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      try { if (JSON.parse(await readFile(path, 'utf8')).token === token) await unlink(path); } catch { /* Already removed. */ }
    },
  };
}
