import { createServer } from 'node:net';

const DEFAULT_LOCK_NAME = `PersonalCodexBridgeConnector-${process.env.USERNAME || 'current-user'}`;

export async function acquireConnectorInstanceLock(name = DEFAULT_LOCK_NAME) {
  if (process.platform !== 'win32') return createNoopLock();
  const safeName = String(name || DEFAULT_LOCK_NAME).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160);
  const pipePath = `\\\\.\\pipe\\${safeName}`;
  const server = createServer((socket) => socket.destroy());
  const acquired = await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') resolve(false);
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipePath);
  });
  if (!acquired) return null;

  let closed = false;
  return {
    pipePath,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function createNoopLock() {
  return { pipePath: null, async close() {} };
}
