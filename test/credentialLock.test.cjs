const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { credentialLockPorts, withCredentialLock } = require('../out/credentialLock');

test('a different process waits for ownership and crash releases the lock', async (t) => {
  const scope = randomUUID();
  const modulePath = require.resolve('../out/credentialLock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(modulePath)}).withCredentialLock(${JSON.stringify(scope)}, async () => { process.send('owned'); await new Promise(() => {}); });`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(() => child.kill());
  await once(child, 'message');
  let entered = false;
  const waiting = withCredentialLock(scope, async () => {
    entered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(entered, false);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await waiting;
  assert.equal(entered, true);
});

test('candidate ports are deterministic and stay in the lock range', () => {
  const scope = randomUUID();
  const ports = credentialLockPorts(scope);
  assert.deepEqual(credentialLockPorts(scope), ports);
  assert.equal(new Set(ports).size, ports.length);
  for (const port of ports) {
    assert.ok(port >= 20000 && port <= 49999, `port ${port} out of range`);
  }
  assert.notDeepEqual(credentialLockPorts(randomUUID()), ports);
});

test('a foreign listener on the primary port does not block the lock', {
  timeout: 10000,
}, async (t) => {
  const scope = randomUUID();
  const [primary] = credentialLockPorts(scope);
  const foreign = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise((resolve) => foreign.listen(primary, '127.0.0.1', resolve));
  t.after(() => foreign.close());
  let entered = false;
  await withCredentialLock(scope, async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

test('a lock holder is recognised across processes instead of being skipped', {
  timeout: 10000,
}, async () => {
  const scope = randomUUID();
  const order = [];
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = withCredentialLock(scope, async () => {
    order.push('first-in');
    await gate;
    order.push('first-out');
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = withCredentialLock(scope, async () => {
    order.push('second-in');
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(order, ['first-in']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-in', 'first-out', 'second-in']);
});
