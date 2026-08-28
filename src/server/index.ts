import { createBridgeServer } from './server.js';

const port = Number(process.env.PORT || 3300);
const host = process.env.HOST || '127.0.0.1';
const server = createBridgeServer();

await server.listen(port, host);
console.log(`Codex Anywhere listening on http://${host}:${port}`);

async function shutdown() {
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
