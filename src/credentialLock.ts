import * as net from 'net';
import * as crypto from 'crypto';

// A loopback listener is an OS-owned mutex: it is released even if the host
// crashes. No token is written to disk or sent over the socket. A hash collision
// merely serializes two unrelated profiles. globalStorage is version independent.
//
// The derived port can already belong to an unrelated local service. The owner
// answers every connection with a scope-bound greeting, so a waiter can tell our
// lock apart from a foreign listener instead of blocking on a port it can never
// acquire. A foreign listener moves the scan to the next candidate port; only a
// matching greeting means another window holds the lock.
const CANDIDATE_COUNT = 8;
const GREETING_PREFIX = 'rdh-credential-lock/1 ';
const ACQUIRE_DEADLINE_MS = 6 * 60 * 1000;
const RETRY_DELAY_MS = 100;
const PROBE_TIMEOUT_MS = 1000;

function scopeTag(scope: string): string {
  return crypto.createHash('sha256').update(scope).digest('hex').slice(0, 32);
}

// Candidate ports for one scope, in scan order. Deterministic for every process
// and platform, so concurrent windows converge on the same port.
export function credentialLockPorts(scope: string): number[] {
  const base = 20000 + (crypto.createHash('sha256').update(scope).digest().readUInt32BE(0) % 30000);
  const ports: number[] = [];
  for (let offset = 0; offset < CANDIDATE_COUNT; offset++) {
    ports.push(20000 + ((base - 20000 + offset) % 30000));
  }
  return ports;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Listen on one candidate. The owner greets every probe so it is identifiable
// from inside another process; the greeting carries no credential material.
function tryListen(port: number, greeting: string): Promise<net.Server | 'in-use'> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {
      /* A probe may disconnect before it reads the greeting. */
    });
    socket.end(greeting);
  });
  return new Promise<net.Server | 'in-use'>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve('in-use');
      } else {
        reject(error);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// True only when the listener on this port identified itself as our lock. A
// foreign service, a silent listener, or a closed port all return false.
function isOurLock(port: number, greeting: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let received = '';
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (same: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(same);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.length >= greeting.length) {
        finish(received.startsWith(greeting));
      }
    });
    socket.on('end', () => finish(received.startsWith(greeting)));
    socket.on('error', () => finish(false));
  });
}

export async function withCredentialLock<T>(
  scope: string,
  work: () => PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  const greeting = `${GREETING_PREFIX}${scopeTag(scope)}\n`;
  const ports = credentialLockPorts(scope);
  const deadline = Date.now() + ACQUIRE_DEADLINE_MS;
  let owner: net.Server | undefined;
  let peerOwnsLock = false;
  while (!owner) {
    signal?.throwIfAborted();
    for (const port of ports) {
      const result = await tryListen(port, greeting);
      if (result !== 'in-use') {
        owner = result;
        break;
      }
      // A release between the failed listen and the probe leaves the port free
      // again. Re-listen once before deciding, so a just-released port is
      // acquired instead of skipped: skipping it would let this process take a
      // later candidate while another window takes this one.
      let heldByPeer = await isOurLock(port, greeting);
      if (!heldByPeer) {
        const retry = await tryListen(port, greeting);
        if (retry !== 'in-use') {
          owner = retry;
          break;
        }
        heldByPeer = await isOurLock(port, greeting);
      }
      if (heldByPeer) {
        // Another window holds this scope. It releases on exit; rescan later.
        peerOwnsLock = true;
        break;
      }
      // A foreign listener owns this port; keep scanning the other candidates.
    }
    if (owner) {
      break;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(RETRY_DELAY_MS);
  }
  if (!owner) {
    throw new Error(
      peerOwnsLock
        ? 'Another window is still authenticating; try again later'
        : 'Could not acquire the credential lock; try again later',
    );
  }
  const held = owner;
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    await new Promise<void>((resolve, reject) =>
      held.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
