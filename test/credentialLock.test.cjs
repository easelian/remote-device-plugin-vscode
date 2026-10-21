const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { withCredentialLock } = require('../out/credentialLock');

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
