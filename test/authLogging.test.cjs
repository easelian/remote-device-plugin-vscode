const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, freshToken, until } = require('./helpers/authHarness.cjs');
const { msg, callbackError } = require('../out/authErrors');

const secret = 'private-access-refresh-verifier-value';
function assertPrivate(h) {
  assert.ok(!h.logs.join('\n').includes(secret));
  assert.ok(!h.messages.join('\n').includes(secret));
}

for (const endpoint of ['/register', '/token']) {
  test(`sign-in ${endpoint} response bodies never reach logs or notifications`, async (t) => {
    const h = harness(t, {
      transport(url) {
        if (url.endsWith(endpoint)) {
          return new Response(`invalid_grant ${secret}`, { status: 400 });
        }
        return Response.json({ client_id: 'client' }, { status: 201 });
      },
    });
    await until(() => h.messages.some((message) => message.includes('HTTP 400')));
    assertPrivate(h);
    assert.equal(h.token, undefined);
  });
}

for (const error of ['server_error', secret]) {
  test(`OAuth callback diagnostics allowlist error codes (${error === secret ? 'unknown' : 'known'})`, async (t) => {
    const h = harness(t, { callbackError: error, callbackErrorDescription: secret });
    await until(() => h.messages.some((message) => message.includes('OAuth authorization failed')));
    assertPrivate(h);
    assert.equal(h.token, undefined);
  });
}

test('transport and native storage exceptions cannot disclose credentials', async (t) => {
  const transport = harness(t, {
    transport() {
      throw new Error(secret);
    },
  });
  await until(() =>
    transport.messages.some((message) => message.includes('Authentication operation failed')),
  );
  assertPrivate(transport);
  const storage = harness(t, {
    token: freshToken(),
    refreshOk: true,
    failStore: () => true,
    storeError: secret,
  });
  await storage.commands
    .get('rdh.signOut')()
    .catch(() => {});
  assertPrivate(storage);
  assert.ok(!msg(new Error(secret)).includes(secret));
  assert.ok(
    !msg({
      toString() {
        throw new Error('must not stringify arbitrary errors');
      },
    }).includes(secret),
  );
  assert.ok(msg(callbackError('issuer_mismatch')).includes('issuer_mismatch'));
});

test('the extension runs beside the chat runtime, so its loopback proxy is reachable in Remote SSH', () => {
  assert.deepEqual(require('../package.json').extensionKind, ['workspace']);
});
