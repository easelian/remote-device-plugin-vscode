import * as net from 'net';
import * as crypto from 'crypto';

// A loopback listener is an OS-owned mutex: it is released even if the host
// crashes. No token is written to disk or sent over the socket. A hash collision
// merely serializes two unrelated profiles. globalStorage is version independent.
export async function withCredentialLock<T>(
  scope: string,
  work: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  const port = 20000 + (crypto.createHash('sha256').update(scope).digest().readUInt32BE(0) % 30000);
  const deadline = Date.now() + 6 * 60 * 1000;
  let owner: net.Server;
  while (true) {
    signal?.throwIfAborted();
    owner = net.createServer((socket) => socket.destroy());
    const acquired = await new Promise<boolean>((resolve, reject) => {
      owner.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          reject(error);
        }
      });
      owner.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (acquired) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error('Another window is still authenticating; try again later');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    await new Promise<void>((resolve, reject) =>
      owner.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
