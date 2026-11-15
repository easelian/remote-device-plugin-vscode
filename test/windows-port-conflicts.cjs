// Run explicitly on Windows after compiling; the fixture uses native Winsock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const path = require('node:path');
const net = require('node:net');
const { credentialLockPorts, withCredentialLock } = require('../out/credentialLock');

function bindResult(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve('listening')));
  });
}

async function exclusiveBlock(t) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const scope = randomUUID();
    const ports = credentialLockPorts(scope).slice(0, 8);
    if (ports[0] < 22000 || ports[0] > 40000) {
      continue;
    }
    if ((await Promise.all(ports.map(bindResult))).some((result) => result !== 'listening')) {
      continue;
    }
    const native = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        path.join(__dirname, 'helpers/exclusiveListener.ps1'),
        '-Ports',
        ports.join(','),
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    t.after(() => native.kill());
    const lines = createInterface({ input: native.stdout });
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(10000) });
    lines.close();
    assert.equal(line, 'READY');
    return { scope, ports, native };
  }
  throw new Error('No available eight-port block for the native listener fixture');
}

test('native Windows EACCES preserves cross-process locking and crash recovery', {
  timeout: 60000,
}, async (t) => {
  assert.equal(process.platform, 'win32');
  const { scope, ports, native } = await exclusiveBlock(t);
  for (const port of ports) {
    assert.equal(await bindResult(port), 'EACCES', `exclusive port ${port} must deny a real bind`);
  }
  t.diagnostic(`Native EACCES confirmed on all eight ports ${ports[0]}-${ports.at(-1)}`);

  const modulePath = require.resolve('../out/credentialLock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(modulePath)}).withCredentialLock(process.argv[1], async () => { process.send('owned'); await new Promise(() => {}); }, AbortSignal.timeout(15000)).catch(error => { console.error(error); process.exit(1); });`,
      scope,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(() => child.kill());
  await once(child, 'message', { signal: AbortSignal.timeout(20000) });

  const connect = net.connect;
  let found;
  const peer = new Promise((resolve) => {
    found = resolve;
  });
  t.mock.method(net, 'connect', (options) => {
    const socket = connect(options);
    socket.once('data', (data) => {
      if (data.toString().startsWith('rdh-credential-lock/1 ')) {
        found(options.port);
      }
    });
    return socket;
  });
  let entered = false;
  const waiting = withCredentialLock(
    scope,
    async () => {
      entered = true;
    },
    AbortSignal.timeout(20000),
  );
  const fallback = await peer;
  assert.ok(!ports.includes(fallback));
  assert.equal(entered, false, 'a second process must wait on the fallback lock');
  t.diagnostic(`Recognised the existing lock on fallback port ${fallback}`);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await waiting;
  assert.equal(entered, true, 'a crash must release the fallback lock');
  const nativeExited = once(native, 'exit');
  native.stdin.end('\n');
  await nativeExited;
  t.diagnostic('Native exclusive listeners stopped');
});
