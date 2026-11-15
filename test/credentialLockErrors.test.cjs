const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { SafeAuthError } = require('../out/authErrors');
const { credentialLockPorts, withCredentialLock } = require('../out/credentialLock');

function denyBinds(t, denied, { refuseProbes = true, code = 'EACCES' } = {}) {
  const listen = net.Server.prototype.listen;
  const connect = net.connect;
  t.mock.method(net.Server.prototype, 'listen', function (port, ...args) {
    if (!denied(port)) {
      return listen.call(this, port, ...args);
    }
    queueMicrotask(() => this.emit('error', Object.assign(new Error(code), { code })));
    return this;
  });
  if (refuseProbes) {
    t.mock.method(net, 'connect', (options) => {
      if (!denied(options.port)) {
        return connect(options);
      }
      const socket = new EventEmitter();
      socket.setEncoding = socket.setTimeout = socket.destroy = () => socket;
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')));
      return socket;
    });
  }
}

test('EACCES on the original candidate block falls back to a dispersed port', async (t) => {
  const scope = randomUUID();
  const original = new Set(credentialLockPorts(scope).slice(0, 8));
  denyBinds(t, (port) => original.has(port));
  let entered = 0;
  await withCredentialLock(scope, async () => entered++, AbortSignal.timeout(3000));
  assert.equal(entered, 1);
});

test('EACCES must still probe and wait for a matching lock holder', async (t) => {
  const scope = randomUUID();
  let release;
  let acquired;
  const started = new Promise((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const first = withCredentialLock(scope, async () => {
    acquired();
    await gate;
  });
  await started;
  // A Windows exclusive listener may report EACCES instead of EADDRINUSE.
  let holding = true;
  denyBinds(t, () => holding, { refuseProbes: false });
  let observed;
  const probed = new Promise((resolve) => {
    observed = resolve;
  });
  const connect = net.connect;
  t.mock.method(net, 'connect', (options) => {
    const socket = connect(options);
    socket.once('data', observed);
    return socket;
  });
  let entered = false;
  const second = withCredentialLock(
    scope,
    async () => {
      entered = true;
    },
    AbortSignal.timeout(3000),
  );
  await probed;
  assert.equal(entered, false);
  release();
  await first;
  holding = false;
  await second;
  assert.equal(entered, true);
});

test('EACCES on every candidate fails promptly without running the protected work', async (t) => {
  denyBinds(t, () => true);
  let entered = false;
  await assert.rejects(
    withCredentialLock(
      randomUUID(),
      async () => {
        entered = true;
      },
      AbortSignal.timeout(3000),
    ),
    (error) =>
      error instanceof SafeAuthError && /loopback ports are unavailable/.test(error.message),
  );
  assert.equal(entered, false);
});

test('unrelated socket errors are not treated as occupied ports', async (t) => {
  denyBinds(t, () => true, { code: 'EADDRNOTAVAIL' });
  let entered = false;
  await assert.rejects(
    withCredentialLock(randomUUID(), async () => entered++),
    { code: 'EADDRNOTAVAIL' },
  );
  assert.equal(entered, false);
});
