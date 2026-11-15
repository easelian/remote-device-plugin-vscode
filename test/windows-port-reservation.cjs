// Run explicitly on an elevated, disposable Windows CI runner, after compiling.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { credentialLockPorts, withCredentialLock } = require('../out/credentialLock');

function exclude(action, port) {
  return spawnSync(
    'netsh',
    [
      'interface',
      'ipv4',
      action,
      'excludedportrange',
      'protocol=tcp',
      `startport=${port}`,
      'numberofports=8',
      'store=active',
    ],
    { encoding: 'utf8' },
  );
}

function bindResult(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve('listening')));
  });
}

test('real Windows exclusions preserve cross-process locking and crash recovery', {
  timeout: 90000,
}, async (t) => {
  assert.equal(process.platform, 'win32', 'run only on a disposable Windows CI runner');
  let scope;
  let primary;
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = randomUUID();
    const [port] = credentialLockPorts(candidate);
    if (port < 22000 || port > 40000) {
      continue;
    }
    const result = exclude('add', port);
    if (result.status === 0) {
      scope = candidate;
      primary = port;
      break;
    }
    t.diagnostic(`Cannot reserve ${port}-${port + 7}: ${result.stdout}${result.stderr}`);
  }
  assert.ok(scope, 'could not create an active test-only TCP exclusion');
  t.after(() => {
    const result = exclude('delete', primary);
    assert.equal(
      result.status,
      0,
      `cannot remove test exclusion: ${result.stdout}${result.stderr}`,
    );
    t.diagnostic(`Removed active TCP exclusion ${primary}-${primary + 7}`);
  });
  for (const port of credentialLockPorts(scope).slice(0, 8)) {
    assert.equal(await bindResult(port), 'EACCES', `excluded port ${port} must deny a real bind`);
  }
  t.diagnostic(`Native EACCES confirmed on all eight ports ${primary}-${primary + 7}`);

  const modulePath = require.resolve('../out/credentialLock');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(modulePath)}).withCredentialLock(process.argv[1], async () => { process.send('owned'); await new Promise(() => {}); }, AbortSignal.timeout(30000)).catch(error => { console.error(error); process.exit(1); });`,
      scope,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  t.after(() => child.kill());
  await once(child, 'message', { signal: AbortSignal.timeout(35000) });

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
    AbortSignal.timeout(45000),
  );
  const fallback = await peer;
  assert.ok(!credentialLockPorts(scope).slice(0, 8).includes(fallback));
  assert.equal(entered, false, 'a second process must wait on the fallback lock');
  t.diagnostic(`Recognised the existing lock on fallback port ${fallback}`);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await waiting;
  assert.equal(entered, true, 'a crash must release the fallback lock');
});
