const { assertBridge } = require('./helpers/assertBridge.cjs');
const { MCP_PUBLIC_URL } = require('../out/deploymentDefaults');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  harness,
  freshToken,
  tick,
  until,
  TOKEN_KEY,
  REFRESH_KEY_PREFIX,
} = require('./helpers/authHarness.cjs');
const realFetch = global.fetch;

test('split-issuer discovery routes sign-in and revocation to the discovered Auth service', async (t) => {
  const issuer = 'https://auth.example/';
  const h = harness(t, { issuer });
  await until(() => h.token);
  assert.equal(h.token._issuer, issuer);
  assert.equal(h.opens[0].origin, 'https://auth.example');
  assert.equal(h.opens[0].searchParams.get('resource'), `${MCP_PUBLIC_URL}/mcp`);
  assert.equal(
    h.requests.find((request) => request.url.endsWith('/register')).url,
    `${issuer}register`,
  );
  assert.equal(h.requests.find((request) => request.url.endsWith('/token')).url, `${issuer}token`);
  await h.commands.get('rdh.signOut')();
  assert.equal(h.requests.at(-1).url, `${issuer}revoke`);
  assert.equal(h.discoveryRequests.length, 2);
  assert.ok(h.discoveryRequests.every(({ init }) => !init.headers.Authorization));
});

test('a changed issuer does not receive legacy refresh or revocation credentials', async (t) => {
  const token = {
    ...freshToken('legacy'),
    _got_at: 0,
    _refresh_state: 'pending',
    _refresh_request_id: 'a'.repeat(43),
  };
  const h = harness(t, { token, issuer: 'https://auth.example/' });
  await until(() => h.logs.some((line) => line.includes('authorization_changed')));
  assert.deepEqual(h.token, token);
  assert.equal(h.requests.length, 0);
  await h.commands.get('rdh.signOut')();
  assert.equal(h.token, undefined);
  assert.equal(h.requests.length, 0);
  assert.ok(h.messages.some((message) => message.includes('revocation could not be confirmed')));
});

test('split-issuer refresh uses the advertised recovery endpoint and preserves its issuer', async (t) => {
  const issuer = 'https://auth.example/';
  const h = harness(t, {
    issuer,
    token: { ...freshToken(), _issuer: issuer, _got_at: 0 },
    recovery: true,
    refreshOk: true,
  });
  await until(() => h.requests.some((request) => request.url.endsWith('/token/refresh')));
  const request = h.requests.find((entry) => entry.url.endsWith('/token/refresh'));
  assert.equal(request.url, `${issuer}token/refresh`);
  assert.match(new URLSearchParams(request.init.body).get('rdh_refresh_id'), /^[A-Za-z0-9_-]{43}$/);
  await until(() => h.token && !h.token._refresh_state);
  assert.equal(h.token._issuer, issuer);
});

test('an uncertain refresh is never replayed when recovery is no longer advertised', async (t) => {
  const issuer = 'https://auth.example/';
  const token = {
    ...freshToken(),
    _issuer: issuer,
    _got_at: 0,
    _refresh_state: 'pending',
    _refresh_request_id: 'a'.repeat(43),
    _refresh_recovery: true,
  };
  const h = harness(t, {
    issuer,
    token,
    authMetadata: {
      issuer,
      authorization_endpoint: `${issuer}authorize`,
      registration_endpoint: `${issuer}register`,
      token_endpoint: `${issuer}token`,
    },
  });
  await until(() => h.logs.some((line) => line.includes('refresh_outcome_unknown')));
  assert.deepEqual(h.token, token);
  assert.equal(h.requests.filter((request) => request.url.includes('/token')).length, 0);
});

test('explicit sign-in replaces credentials whose issuer is missing', async (t) => {
  const token = freshToken();
  delete token._issuer;
  const h = harness(t, { token, issuer: 'https://auth.example/' });
  await until(() => h.logs.some((line) => line.includes('authorization_changed')));
  assert.equal(h.requests.length, 0);
  await h.commands.get('rdh.signIn')();
  assert.equal(h.token._issuer, 'https://auth.example/');
  assert.equal(h.opens.length, 1);
});

test('a sign-out during discovery prevents the stale token being sent to MCP', async (t) => {
  let releaseDiscovery;
  const h = harness(t, {
    token: freshToken(),
    beforeAuthMetadata: () =>
      new Promise((resolve) => {
        releaseDiscovery = resolve;
      }),
  });
  await until(() => releaseDiscovery);
  const signOut = h.commands.get('rdh.signOut')();
  await until(() => !h.token);
  releaseDiscovery();
  await signOut;
  await tick();
  assert.equal(h.requests.filter((request) => request.url.endsWith('/mcp')).length, 0);
  assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 0);
  assert.equal(h.token, undefined);
});

for (const callbackIssuer of [null, 'https://wrong.example/']) {
  test(`authorization code is not exchanged when callback issuer is ${callbackIssuer}`, async (t) => {
    const h = harness(t, { issuer: 'https://auth.example/', callbackIssuer });
    await until(() => h.messages.some((message) => message.includes('issuer_mismatch')));
    assert.equal(h.token, undefined);
    assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 0);
  });
}

test('optional callback issuer may be absent, but a present issuer must match', async (t) => {
  const issuer = 'https://auth.example/';
  const authMetadata = {
    issuer,
    authorization_endpoint: `${issuer}authorize`,
    registration_endpoint: `${issuer}register`,
    token_endpoint: `${issuer}token`,
    authorization_response_iss_parameter_supported: false,
  };
  const allowed = harness(t, { issuer, authMetadata, callbackIssuer: null });
  await until(() => allowed.token);
  assert.equal(allowed.token._issuer, issuer);

  const rejected = harness(t, { issuer, authMetadata, callbackIssuer: 'https://other.example/' });
  await until(() => rejected.messages.some((message) => message.includes('issuer_mismatch')));
  assert.equal(rejected.requests.filter((request) => request.url.endsWith('/token')).length, 0);
});

test('sign-in waits for an explanation and affirmative choice before contacting authorization services', async (t) => {
  let approve;
  const h = harness(t, {
    confirmSignIn: () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  });
  await until(() => approve);
  const prompt = h.signInPrompts[0];
  assert.equal(prompt.options.modal, true);
  assert.deepEqual(prompt.items, ['Continue']);
  assert.match(prompt.options.detail, /Easelian/);
  assert.match(prompt.options.detail, /authorized devices/);
  assert.match(prompt.options.detail, /does not pair/);
  assert.equal(h.discoveryRequests.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.callbackUris.length, 0);
  assert.equal(h.opens.length, 0);
  assert.equal(h.token, undefined);
  approve('Continue');
  await until(() => h.token);
  assert.equal(h.opens.length, 1);
});

test('browser authorization denial cancels sign-in without token exchange or an error notification', async (t) => {
  const h = harness(t, { callbackError: 'access_denied' });
  await until(() => h.logs.some((line) => line.includes('sign-in cancelled in browser')));
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.token, undefined);
  assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 0);
  assert.equal(h.requests.filter((request) => request.url.endsWith('/mcp')).length, 0);
  assert.ok(!h.messages.some((message) => message.includes('sign-in failed')));
});

for (const callbackIssuer of [null, 'https://wrong.example/']) {
  test(`browser denial with invalid issuer ${callbackIssuer} is not accepted as cancellation`, async (t) => {
    const h = harness(t, { callbackError: 'access_denied', callbackIssuer });
    await until(() => h.messages.some((message) => message.includes('issuer_mismatch')));
    assert.ok(!h.logs.some((line) => line.includes('sign-in cancelled in browser')));
    assert.equal(h.token, undefined);
    assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 0);
  });
}

test('Chinese VS Code explains sign-in in Chinese and accepts its localized action', async (t) => {
  const h = harness(t, { language: 'zh-cn' });
  await until(() => h.token);
  const prompt = h.signInPrompts[0];
  assert.match(prompt.text, /将 VS Code 连接到/);
  assert.match(prompt.options.detail, /易连网（Easelian）的远程设备服务/);
  assert.match(prompt.options.detail, /列出你已授权的设备、读写允许访问的文件/);
  assert.match(prompt.options.detail, /登录不会自动配对新设备/);
  assert.match(prompt.options.detail, /拒绝授权/);
  assert.deepEqual(prompt.items, ['继续']);
  assert.equal(h.opens.length, 1);
});

test('declining sign-in suppresses queued windows and reload until an explicit retry', async (t) => {
  let decline;
  const a = harness(t, {
    confirmSignIn: () =>
      new Promise((resolve) => {
        decline = resolve;
      }),
  });
  await until(() => decline);
  const b = harness(t, { shared: a.shared, scope: a.scope });
  const waiting = b.provider.resolveMcpServerDefinition();
  const pending = a.commands.get('rdh.signIn')();
  decline(undefined);
  await pending;
  assert.equal(await waiting, undefined);
  const c = harness(t, { shared: a.shared, scope: a.scope });
  assert.equal(await c.provider.resolveMcpServerDefinition(), undefined);
  for (const h of [a, b, c]) {
    assert.equal(h.opens.length, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.discoveryRequests.length, 0);
    assert.equal(h.callbackUris.length, 0);
    assert.equal(h.token, undefined);
  }
  assert.equal(a.signInPrompts.length, 1);
  assert.equal(b.signInPrompts.length + c.signInPrompts.length, 0);
  await b.commands.get('rdh.signIn')();
  assert.equal(b.signInPrompts.length, 1);
  assert.equal(b.opens.length, 1);
  assert.equal(b.token.access_token, 'accepted');
});

for (const action of ['cancel', 'signOut', 'dispose']) {
  test(`${action} during sign-in confirmation ignores a late affirmative choice`, async (t) => {
    let approve;
    const h = harness(t, {
      confirmSignIn: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    });
    await until(() => approve);
    const pending = h.commands.get('rdh.signIn')();
    if (action === 'signOut') {
      await h.commands.get('rdh.signOut')();
    } else if (action === 'dispose') {
      h.disposeSession();
    } else {
      h.cancel();
    }
    await pending;
    approve('Continue');
    await tick();
    assert.equal(h.opens.length, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.discoveryRequests.length, 0);
    assert.equal(h.callbackUris.length, 0);
    assert.equal(h.token, undefined);
    assert.ok(!h.messages.some((message) => message.includes('sign-in failed')));
  });
}

for (const ssh of [false, true]) {
  test(`activation authorizes after confirmation via ${ssh ? 'forwarded SSH callback' : 'local callback'}`, async (t) => {
    const h = harness(t, { ssh });
    await until(() => h.token);
    assert.equal(h.token._refresh_recovery, true);
    assert.match(
      h.shared.extraSecrets.get(REFRESH_KEY_PREFIX + h.token.client_id),
      /^[A-Za-z0-9_-]{43}$/,
    );
    assert.equal(h.opens.length, 1);
    const browserRedirect = h.opens[0].searchParams.get('redirect_uri');
    assert.equal(browserRedirect === h.callbackUris[0], !ssh);
    const registration = h.requests.find((r) => r.url.endsWith('/register'));
    assert.equal(JSON.parse(registration.init.body).redirect_uris[0], browserRedirect);
    const exchange = h.requests.find((r) => r.url.endsWith('/token'));
    assert.equal(exchange.url, MCP_PUBLIC_URL + '/token');
    assert.equal(exchange.init.redirect, 'error');
    const body = new URLSearchParams(exchange.init.body);
    assert.equal(body.get('redirect_uri'), browserRedirect);
    const challenge = require('node:crypto')
      .createHash('sha256')
      .update(body.get('code_verifier'))
      .digest('base64url');
    assert.equal(challenge, h.opens[0].searchParams.get('code_challenge'));
    assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
    assert.ok(!h.messages.some((m) => m.includes('sign in to use')));
  });
}
test('MCP startup and Sign In share one browser flow', async (t) => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  const resolving = h.provider.resolveMcpServerDefinition();
  const manual = h.commands.get('rdh.signIn')();
  await tick();
  assert.equal(h.progressCount, 1);
  await h.callback(h.opens[0]);
  await manual;
  assertBridge(await resolving, h, 'accepted');
  assert.equal(h.opens.length, 1);
});
test('accepted stored credentials do not open a browser', async (t) => {
  const h = harness(t, { token: freshToken() });
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(h.opens.length, 0);
  assert.equal(h.signInPrompts.length, 0);
});
test('rejected saved credentials stop MCP startup without opening a browser', async (t) => {
  const h = harness(t, { token: freshToken('revoked') });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.opens.length, 0);
  assert.equal(h.token._refresh_state, 'rejected');
  assert.equal(h.requests.filter((r) => r.url.endsWith('/mcp')).length, 1);
  assert.ok(h.logs.some((line) => line.includes('invalid_grant')));
  await h.commands.get('rdh.signIn')();
  assert.equal(h.opens.length, 1);
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
});
test('rejected credentials refresh before invoking browser', async (t) => {
  const h = harness(t, { token: freshToken('revoked'), refreshOk: true });
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(h.opens.length, 0);
});
test('MCP outage stops startup without starting OAuth', async (t) => {
  const h = harness(t, { token: freshToken(), mcpStatus: 503 });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.opens.length, 0);
});
test('browser open false allows copying the same authorization URL', async (t) => {
  const h = harness(t, { openFalse: true, copy: true, ssh: true });
  await until(() => h.token);
  assert.equal(h.clipboard, h.opens[0].toString());
});
test('cancellation stops waiting, closes callback and prevents MCP startup', async (t) => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  const resolving = h.provider.resolveMcpServerDefinition();
  await tick();
  h.cancel();
  assert.equal(await resolving, undefined);
  assert.equal(h.token, undefined);
  await assert.rejects(realFetch(h.callbackUris[0]));
});
test('SSH forwarding failure is reported and callback is closed', async (t) => {
  const h = harness(t, { tunnelError: true });
  await until(() => h.messages.some((m) => m.includes('Authentication operation failed')));
  assert.equal(h.opens.length, 0);
  await assert.rejects(realFetch(h.callbackUris[0]));
});
test('sign-out cancels an in-flight login before clearing credentials', async (t) => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  await h.commands.get('rdh.signOut')();
  assert.equal(h.token, undefined);
  await assert.rejects(realFetch(h.callbackUris[0]));
});
test('requested connection preserves rejected credentials and waits for an explicit sign-in', async (t) => {
  const h = harness(t, { token: freshToken('revoked') });
  await h.startup;
  assert.equal(h.token.access_token, 'revoked');
  assert.equal(h.opens.length, 0);
  assert.equal(h.progressCount, 0);
});
test('requested connection reuses server-accepted credentials without opening a browser', async (t) => {
  const h = harness(t, { token: freshToken() });
  await h.startup;
  assert.equal(h.opens.length, 0);
  assert.equal(h.requests.filter((r) => r.url.endsWith('/mcp')).length, 1);
});

test('independent extension hosts share a single browser authorization', async (t) => {
  const shared = {};
  const scope = require('node:crypto').randomUUID();
  const a = harness(t, { shared, scope, hold: true });
  await until(() => a.opens.length);
  const b = harness(t, { shared, scope, hold: true });
  const resolving = b.provider.resolveMcpServerDefinition();
  await a.callback(a.opens[0]);
  assertBridge(await resolving, b, 'accepted');
  assert.equal(a.opens.length + b.opens.length, 1);
});
test('independent hosts rotate an expired refresh token only once', async (t) => {
  const shared = { stored: JSON.stringify({ ...freshToken(), _got_at: 0 }) };
  const scope = require('node:crypto').randomUUID();
  const a = harness(t, { shared, scope, refreshOk: true });
  const b = harness(t, { shared, scope, refreshOk: true });
  await Promise.all([
    a.provider.resolveMcpServerDefinition(),
    b.provider.resolveMcpServerDefinition(),
  ]);
  assert.equal([...a.requests, ...b.requests].filter((r) => r.url.endsWith('/token')).length, 1);
  assert.equal(a.opens.length + b.opens.length, 0);
});
test('temporary refresh failure retains credentials without opening OAuth', async (t) => {
  const token = { ...freshToken(), _got_at: 0 };
  const h = harness(t, { token, refreshStatus: 503 });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.deepEqual(h.token, { ...token, _refresh_state: 'pending' });
  assert.equal(h.opens.length, 0);
});
test('permission denial does not start a new authorization', async (t) => {
  const h = harness(t, { token: freshToken(), mcpStatus: 403 });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.opens.length, 0);
});

test('a lost refresh response is not replayed by startup, another host, or reload', async (t) => {
  let consumed = 0;
  const token = { ...freshToken(), _got_at: 0 };
  const a = harness(t, {
    token,
    onRefresh: async () => {
      consumed++;
      throw new DOMException('response lost after rotation', 'TimeoutError');
    },
  });
  await until(() => a.logs.some((line) => line.includes('token refresh failed')));
  assert.equal(a.token._refresh_state, 'pending');
  assert.equal(a.token.refresh_token, token.refresh_token);
  assert.equal(await a.provider.resolveMcpServerDefinition(), undefined);
  const b = harness(t, {
    shared: a.shared,
    onRefresh: async () => {
      consumed++;
      throw new Error('must not replay');
    },
  });
  assert.equal(await b.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(consumed, 1);
  assert.equal(a.opens.length + b.opens.length, 0);
  assert.ok(b.logs.some((line) => line.includes('old refresh token will not be replayed')));
  await b.commands.get('rdh.signIn')();
  assert.equal(b.opens.length, 1);
  assert.equal(b.token._refresh_state, undefined);
  assertBridge(await b.provider.resolveMcpServerDefinition(), b, 'accepted');
});

test('a failed credential save retries persistence without rotating again', async (t) => {
  let failSave = true;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    refreshOk: true,
    failStore: (key, value) => failSave && key === TOKEN_KEY && !JSON.parse(value)._refresh_state,
  });
  await until(() => h.logs.some((line) => line.includes('secret storage unavailable')));
  assert.equal(h.token._refresh_state, 'pending');
  failSave = false;
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 1);
  assert.equal(h.opens.length, 0);
});

test('a running extension retries saving a rotation response in the background', async (t) => {
  const clock = { now: Date.now() };
  let failSave = true;
  const h = harness(t, {
    clock,
    token: { ...freshToken(), _got_at: 0 },
    refreshOk: true,
    failStore: (key, value) => failSave && key === TOKEN_KEY && !JSON.parse(value)._refresh_state,
  });
  await until(
    () => h.logs.some((line) => line.includes('secret storage unavailable')) && h.timers.size === 1,
  );
  failSave = false;
  await h.advance(60 * 1000);
  await until(() => h.logs.some((line) => line.includes('recovered rotated credentials')));
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 1);
  assert.equal(h.opens.length, 0);
});

test('a reload cannot retry a rotation whose response existed only in the old host', async (t) => {
  const a = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    refreshOk: true,
    failStore: (key, value) => key === TOKEN_KEY && !JSON.parse(value)._refresh_state,
  });
  await until(() => a.logs.some((line) => line.includes('secret storage unavailable')));
  const b = harness(t, { shared: a.shared, scope: a.scope, refreshOk: true });
  assert.equal(await b.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(b.requests.filter((r) => r.url.endsWith('/token')).length, 0);
  assert.equal(b.opens.length, 0);
});

test('discovery waits for a refresh in flight and publishes its result', async (t) => {
  let finishRefresh;
  const h = harness(t, {
    mcpStatus: 200,
    token: { ...freshToken(), _got_at: 0 },
    onRefresh: () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  });
  await until(() => finishRefresh);
  const discovering = h.provider.provideMcpServerDefinitions();
  finishRefresh(Response.json({ ...freshToken('rotated'), refresh_token: 'next' }));
  assertBridge((await discovering)[0], h, 'rotated');
  assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 1);
  assert.equal(h.opens.length, 0);
});

test('discovery withholds the definition while a refresh fails, without opening a browser', async (t) => {
  const h = harness(t, {
    activateOnly: true,
    token: { ...freshToken(), _got_at: 0 },
    onRefresh: async () => {
      throw new Error('network down');
    },
  });
  assert.equal((await h.provider.provideMcpServerDefinitions()).length, 0);
  assert.equal(h.signInPrompts.length, 0);
  assert.equal(h.opens.length, 0);
});

test('discovery offers Sign In once when the saved sign-in can no longer be renewed', async (t) => {
  const h = harness(t, {
    activateOnly: true,
    token: { ...freshToken(), _got_at: 0, _refresh_state: 'rejected' },
  });
  assert.equal((await h.provider.provideMcpServerDefinitions()).length, 0);
  assert.equal((await h.provider.provideMcpServerDefinitions()).length, 0);
  assert.equal(h.messages.filter((message) => message.includes('Sign In')).length, 1);
  assert.equal(h.signInPrompts.length, 0);
  assert.equal(h.opens.length, 0);
});

test('refresh is never sent if its intent cannot be persisted', async (t) => {
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    refreshOk: true,
    failStore: (key, value) => key === TOKEN_KEY && JSON.parse(value)._refresh_state === 'pending',
  });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 0);
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.opens.length, 0);
});

test('canceled first-time login is not restarted by queued windows or reload', async (t) => {
  const a = harness(t, { hold: true });
  await until(() => a.opens.length);
  const b = harness(t, { shared: a.shared, scope: a.scope });
  const waiting = b.provider.resolveMcpServerDefinition();
  const pending = a.commands.get('rdh.signIn')();
  a.cancel();
  await pending;
  assert.equal(await waiting, undefined);
  const c = harness(t, { shared: a.shared, scope: a.scope });
  assert.equal(await c.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(a.opens.length + b.opens.length + c.opens.length, 1);
  await b.commands.get('rdh.signIn')();
  assert.equal(b.opens.length, 1);
  assert.equal(b.token.access_token, 'accepted');
});

test('a timed-out login does not cause another window to open a browser', async (t) => {
  const clock = { now: Date.now() };
  const a = harness(t, { hold: true, clock });
  await until(() => a.opens.length);
  await a.advance(5 * 60 * 1000);
  await until(() => a.logs.some((line) => line.includes('sign-in failed: sign-in timed out')));
  const b = harness(t, { shared: a.shared, scope: a.scope });
  assert.equal(await b.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(a.opens.length + b.opens.length, 1);
});

test('sign-out cancels a silent wait for another window before deleting credentials', async (t) => {
  const a = harness(t, { hold: true });
  await until(() => a.opens.length);
  const b = harness(t, { shared: a.shared, scope: a.scope });
  const resolving = b.provider.resolveMcpServerDefinition();
  await until(() => b.logs.some((line) => line.includes('waiting for another window')));
  const signingOut = b.commands.get('rdh.signOut')();
  a.cancel();
  await signingOut;
  assert.equal(await resolving, undefined);
  assert.equal(b.token, undefined);
  assert.equal(b.opens.length, 0);
  assert.ok(b.logs.some((line) => line.includes('signed out;')));
});

test('refresh is scheduled from token expiration even when login and activation times differ', async (t) => {
  const clock = { now: Date.now() };
  const token = { ...freshToken(), _got_at: clock.now / 1000 - 4 * 60 };
  const h = harness(t, { token, refreshOk: true, clock });
  await until(() => h.timers.size === 1);
  assert.equal([...h.timers.values()][0].at, (token._got_at + token.expires_in - 180) * 1000);
  await h.advance(53 * 60 * 1000);
  await until(() => h.logs.some((line) => line.includes('token refreshed')));
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 1);
  assert.equal(h.opens.length, 0);
  await until(() => h.timers.size === 1);
  assert.equal([...h.timers.values()][0].at, clock.now + 57 * 60 * 1000);
});

test('another window reschedules refresh when shared credentials rotate', async (t) => {
  const clock = { now: Date.now() };
  const a = harness(t, { token: freshToken(), clock });
  const b = harness(t, { shared: a.shared, scope: a.scope, clock });
  await until(() => a.timers.size === 1 && b.timers.size === 1);
  const rotated = { ...freshToken(), _got_at: clock.now / 1000 + 10 * 60 };
  a.shared.stored = JSON.stringify(rotated);
  for (const fn of a.shared.secretListeners) {
    fn({ key: TOKEN_KEY });
  }
  await until(() => b.timers.size === 1);
  assert.equal([...b.timers.values()][0].at, (rotated._got_at + 3600 - 180) * 1000);
  assert.equal(a.opens.length + b.opens.length, 0);
});

test('sign-out survives reload without automatically reopening OAuth', async (t) => {
  const a = harness(t, { token: freshToken() });
  await a.commands.get('rdh.signOut')();
  const b = harness(t, { shared: a.shared, scope: a.scope });
  assert.equal(await b.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(b.opens.length, 0);
  await b.commands.get('rdh.signIn')();
  assert.equal(b.opens.length, 1);
});

test('malformed saved credentials are retained and never treated as a fresh installation', async (t) => {
  const h = harness(t, { shared: { stored: '{broken-json' } });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.shared.stored, '{broken-json');
  assert.equal(h.opens.length, 0);
  assert.ok(h.logs.some((line) => line.includes('Saved credentials could not be read')));
});

function recoverableServer() {
  const results = new Map();
  const proofs = [];
  let rotations = 0;
  let loseNextResponse = false;
  return {
    results,
    proofs,
    get rotations() {
      return rotations;
    },
    loseResponse() {
      loseNextResponse = true;
    },
    async refresh(_url, init) {
      const body = new URLSearchParams(init.body);
      const old = body.get('refresh_token');
      const proof = body.get('rdh_refresh_id');
      assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
      proofs.push(proof);
      if (results.has(old)) {
        const previous = results.get(old);
        assert.equal(proof, previous.proof, 'the same token pair must use the same recovery proof');
        return Response.json(previous.tokens, { headers: { 'RDH-Refresh-Recovered': '1' } });
      }
      rotations++;
      const tokens = { ...freshToken(), refresh_token: `rotated-refresh-${rotations}` };
      results.set(old, { proof, tokens });
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new DOMException('response lost after the rotation committed', 'TimeoutError');
      }
      return Response.json(tokens);
    },
  };
}

test('a committed refresh with a lost response is recovered silently on retry', async (t) => {
  const server = recoverableServer();
  server.loseResponse();
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: server.refresh,
  });
  await until(() => h.logs.some((line) => line.includes('token refresh failed')));
  assert.equal(h.token._refresh_state, 'pending');
  assert.match(h.token._refresh_request_id, /^[A-Za-z0-9_-]{43}$/);
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(server.rotations, 1);
  assert.equal(server.proofs.length, 2);
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.token._refresh_request_id, undefined);
  assert.equal(h.opens.length, 0);
  assert.ok(h.logs.some((line) => line.includes('recovered the result of an earlier refresh')));
});

test('a reload on a different host can recover a lost refresh response', async (t) => {
  const server = recoverableServer();
  server.loseResponse();
  const a = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: server.refresh,
  });
  await until(() => a.logs.some((line) => line.includes('token refresh failed')));
  const b = harness(t, { shared: a.shared, recovery: true, onRefresh: server.refresh });
  assertBridge(await b.provider.resolveMcpServerDefinition(), b, 'accepted');
  assert.equal(server.rotations, 1);
  assert.equal(server.proofs.length, 2);
  assert.equal(a.opens.length + b.opens.length, 0);
});

test('hosts without a shared lock derive the same proof and rotate only once', async (t) => {
  const server = recoverableServer();
  const shared = { stored: JSON.stringify({ ...freshToken(), _got_at: 0 }) };
  const a = harness(t, { shared, recovery: true, onRefresh: server.refresh });
  const b = harness(t, { shared, recovery: true, onRefresh: server.refresh });
  await Promise.all([
    a.provider.resolveMcpServerDefinition(),
    b.provider.resolveMcpServerDefinition(),
  ]);
  assert.equal(server.rotations, 1);
  assert.equal(new Set(server.proofs).size, 1);
  assert.equal(shared.stored && JSON.parse(shared.stored).refresh_token, 'rotated-refresh-1');
  assert.equal(a.opens.length + b.opens.length, 0);
});

test('background refresh retries the same recovery operation after a timeout', async (t) => {
  const clock = { now: Date.now() };
  const server = recoverableServer();
  server.loseResponse();
  const h = harness(t, {
    clock,
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: server.refresh,
  });
  await until(
    () => h.logs.some((line) => line.includes('token refresh failed')) && h.timers.size === 1,
  );
  await h.advance(60 * 1000);
  await until(() =>
    h.logs.some((line) => line.includes('recovered the result of an earlier refresh')),
  );
  assert.equal(server.rotations, 1);
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.opens.length, 0);
});

test('a stalled refresh stops waiting and recovers the same committed rotation', async (t) => {
  const clock = { now: Date.now() };
  const server = recoverableServer();
  let firstSignal;
  const h = harness(t, {
    clock,
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    async onRefresh(url, init) {
      const response = await server.refresh(url, init);
      if (!firstSignal) {
        firstSignal = init.signal;
        return new Promise(() => {});
      }
      return response;
    },
  });
  await until(() => firstSignal);
  await h.advance(30_000);
  await until(() => h.logs.some((line) => line.includes('Token refresh timed out')));
  assert.equal(firstSignal.aborted, true);
  assert.equal(h.token._refresh_state, 'pending');
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(server.rotations, 1);
  assert.equal(server.proofs.length, 2);
  assert.equal(server.proofs[0], server.proofs[1]);
  assert.equal(h.opens.length, 0);
});

test('recovery follows an expired cached rotation before sending MCP requests', async (t) => {
  let calls = 0;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: async () => {
      calls++;
      return Response.json({
        ...freshToken(),
        refresh_token: `next-${calls}`,
        expires_in: calls === 1 ? 1 : 3600,
      });
    },
  });
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(calls, 2);
  assert.equal(h.token.refresh_token, 'next-2');
  assert.equal(h.opens.length, 0);
});

test('an indeterminate recovery request never falls back to /token refresh', async (t) => {
  let calls = 0;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: async () => {
      if (++calls === 1) {
        throw new Error('response lost');
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });
  await until(() => h.logs.some((line) => line.includes('token refresh failed')));
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 0);
  assert.match(h.token._refresh_request_id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(h.opens.length, 0);
});

test('a definitive first-attempt 404 permits one /token refresh without a proof', async (t) => {
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: async (url, init) => {
      if (url.endsWith('/token/refresh')) {
        return Response.json({}, { status: 404 });
      }
      assert.equal(new URLSearchParams(init.body).has('rdh_refresh_id'), false);
      return Response.json(freshToken());
    },
  });
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token/refresh')).length, 1);
  assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 1);
  assert.equal(h.token._refresh_request_id, undefined);
  assert.equal(h.opens.length, 0);
});

test('a copied token record without its separate key cannot start recovery', async (t) => {
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    noRecoveryKey: true,
  });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.requests.length, 0);
  assert.equal(h.opens.length, 0);
  assert.ok(h.logs.some((line) => line.includes('refresh_key_missing')));
});

test('recovery keys and proofs are never logged or sent as raw keys', async (t) => {
  const server = recoverableServer();
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: server.refresh,
  });
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  const privateKey = h.shared.extraSecrets.get(REFRESH_KEY_PREFIX + h.token.client_id);
  assert.ok(privateKey);
  assert.ok(!JSON.stringify(h.requests).includes(privateKey));
  assert.ok(!h.logs.join('\n').includes(privateKey));
  for (const proof of server.proofs) {
    assert.ok(!h.logs.join('\n').includes(proof));
  }
});

test('sign-out removes the private recovery key created by sign-in', async (t) => {
  const h = harness(t);
  await until(() => h.token);
  const key = REFRESH_KEY_PREFIX + h.token.client_id;
  assert.ok(h.shared.extraSecrets.has(key));
  await h.commands.get('rdh.signOut')();
  assert.equal(h.shared.extraSecrets.has(key), false);
  assert.equal(h.token, undefined);
});

test('sign-out clears local secrets and revokes the saved refresh grant', async (t) => {
  const token = freshToken();
  const h = harness(t, {
    token,
    recovery: true,
    onRevoke: async (url, init) => {
      assert.equal(h.token, undefined);
      assert.equal(h.shared.extraSecrets.has(REFRESH_KEY_PREFIX + token.client_id), false);
      assert.equal(url, MCP_PUBLIC_URL + '/revoke');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
        client_id: token.client_id,
        token: token.refresh_token,
        token_type_hint: 'refresh_token',
      });
      return new Response(null, { status: 200 });
    },
  });
  await h.provider.resolveMcpServerDefinition();
  await h.commands.get('rdh.signOut')();
  assert.equal(h.requests.filter((r) => r.url.endsWith('/revoke')).length, 1);
  assert.equal(
    h.requests.filter((r) => r.url.endsWith('/token') || r.url.endsWith('/token/refresh')).length,
    0,
  );
  assert.equal(h.token, undefined);
  assert.equal(h.shared.extraSecrets.has(REFRESH_KEY_PREFIX + token.client_id), false);
  assert.ok(h.logs.some((line) => line.includes('token revocation: HTTP 200')));
});

test('sign-out can revoke an access token when no refresh token is saved', async (t) => {
  const h = harness(t, { token: { ...freshToken(), refresh_token: undefined } });
  await h.provider.resolveMcpServerDefinition();
  await h.commands.get('rdh.signOut')();
  const revoke = h.requests.find((r) => r.url.endsWith('/revoke'));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(revoke.init.body)), {
    client_id: 'client',
    token: 'accepted',
    token_type_hint: 'access_token',
  });
  assert.equal(h.token, undefined);
});

test('sign-out revokes an interrupted refresh without replaying its rotation', async (t) => {
  const token = { ...freshToken(), _got_at: 0, _refresh_state: 'pending' };
  const h = harness(t, { token });
  await until(() => h.logs.some((line) => line.includes('old refresh token will not be replayed')));
  await h.commands.get('rdh.signOut')();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, MCP_PUBLIC_URL + '/revoke');
  assert.equal(new URLSearchParams(h.requests[0].init.body).get('token'), token.refresh_token);
  assert.equal(h.token, undefined);
});

test('sign-out waits for an in-flight rotation and revokes its latest credentials', async (t) => {
  let finish;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    onRefresh: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await until(() => finish);
  const signingOut = h.commands.get('rdh.signOut')();
  await tick();
  assert.equal(h.requests.filter((r) => r.url.endsWith('/revoke')).length, 0);
  finish(Response.json({ ...freshToken(), refresh_token: 'latest-refresh' }));
  await signingOut;
  const revoke = h.requests.find((r) => r.url.endsWith('/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'latest-refresh');
  assert.equal(h.token, undefined);
});

for (const status of [401, 503]) {
  test(`sign-out clears local secrets and reports unconfirmed revocation on HTTP ${status}`, async (t) => {
    const h = harness(t, { token: freshToken(), recovery: true, revokeStatus: status });
    await h.provider.resolveMcpServerDefinition();
    await h.commands.get('rdh.signOut')();
    assert.equal(h.token, undefined);
    assert.equal(h.shared.extraSecrets.has(REFRESH_KEY_PREFIX + 'client'), false);
    assert.ok(
      h.messages.some(
        (message) =>
          message.includes('signed out locally') && message.includes('could not be confirmed'),
      ),
    );
    assert.ok(!h.messages.includes('Remote Device Hub: signed out'));
    const reloaded = harness(t, { shared: h.shared, scope: h.scope });
    assert.equal(await reloaded.provider.resolveMcpServerDefinition(), undefined);
    assert.equal(reloaded.opens.length, 0);
  });
}

test('a revocation timeout never leaks the request or reports a confirmed server sign-out', async (t) => {
  const privateToken = 'private-refresh-value';
  const h = harness(t, {
    token: { ...freshToken(), refresh_token: privateToken },
    recovery: true,
    onRevoke: () => {
      throw new Error('timed out: ' + privateToken);
    },
  });
  await h.provider.resolveMcpServerDefinition();
  await h.commands.get('rdh.signOut')();
  assert.equal(h.token, undefined);
  assert.equal(h.shared.extraSecrets.has(REFRESH_KEY_PREFIX + 'client'), false);
  assert.ok(h.messages.some((message) => message.includes('could not be confirmed')));
  assert.ok(![...h.messages, ...h.logs].join('\n').includes(privateToken));
});

test('sign-out purges malformed local credentials and reports that revocation is unconfirmed', async (t) => {
  const h = harness(t, { shared: { stored: '{broken-json' } });
  await until(() => h.logs.some((line) => line.includes('Saved credentials could not be read')));
  await h.commands.get('rdh.signOut')();
  assert.equal(h.shared.stored, undefined);
  assert.equal(h.requests.length, 0);
  assert.ok(h.messages.some((message) => message.includes('could not be confirmed')));
});

test('sign-out preserves a newer account published while revocation is in flight', async (t) => {
  let finish;
  const h = harness(t, {
    token: freshToken(),
    recovery: true,
    onRevoke: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.provider.resolveMcpServerDefinition();
  const signingOut = h.commands.get('rdh.signOut')();
  await until(() => finish);
  const newer = { ...freshToken(), client_id: 'new-client', refresh_token: 'new-account-refresh' };
  h.shared.stored = JSON.stringify(newer);
  h.shared.extraSecrets.set(REFRESH_KEY_PREFIX + 'new-client', 'new-account-key');
  finish(new Response(null, { status: 200 }));
  await signingOut;
  assert.deepEqual(h.token, newer);
  assert.equal(h.shared.extraSecrets.has(REFRESH_KEY_PREFIX + 'client'), false);
  assert.equal(h.shared.extraSecrets.get(REFRESH_KEY_PREFIX + 'new-client'), 'new-account-key');
});

test('local sign-out survives reload while server revocation is still pending', async (t) => {
  let finish;
  const a = harness(t, {
    token: freshToken(),
    recovery: true,
    onRevoke: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await a.provider.resolveMcpServerDefinition();
  const signingOut = a.commands.get('rdh.signOut')();
  await until(() => finish);
  assert.equal(a.token, undefined);
  assert.equal(a.shared.extraSecrets.has(REFRESH_KEY_PREFIX + 'client'), false);
  const b = harness(t, { shared: a.shared, scope: a.scope });
  const resolving = b.provider.resolveMcpServerDefinition();
  await tick();
  assert.equal(b.token, undefined);
  assert.equal(b.opens.length, 0);
  finish(new Response(null, { status: 200 }));
  await signingOut;
  assert.equal(await resolving, undefined);
});

test('sign-out cancels background refresh in every window sharing the credentials', async (t) => {
  const clock = { now: Date.now() };
  const a = harness(t, { token: freshToken(), clock });
  const b = harness(t, { shared: a.shared, scope: a.scope, clock });
  await until(() => a.timers.size === 1 && b.timers.size === 1);
  await a.commands.get('rdh.signOut')();
  await until(() => a.timers.size === 0 && b.timers.size === 0);
  await a.advance(60 * 60 * 1000);
  await b.advance(60 * 60 * 1000);
  assert.equal(a.requests.filter((r) => r.url.endsWith('/revoke')).length, 1);
  assert.equal(
    a.requests
      .concat(b.requests)
      .filter((r) => r.url.endsWith('/token') || r.url.endsWith('/token/refresh')).length,
    0,
  );
  assert.equal(a.opens.length + b.opens.length, 0);
});

test('a delayed refresh response does not restore credentials removed by another host', async (t) => {
  let finish;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await until(() => finish);
  h.shared.stored = undefined;
  h.shared.authState = JSON.stringify({ signed_out_at: Date.now() });
  finish(Response.json({ ...freshToken(), refresh_token: 'rotated-after-sign-out' }));
  await until(() => h.logs.some((line) => line.includes('automatic sign-in suppressed')));
  assert.equal(h.token, undefined);
  assert.equal(h.opens.length, 0);
});

test('a delayed refresh response preserves a newer credential record', async (t) => {
  let finish;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await until(() => finish);
  h.shared.stored = JSON.stringify({
    ...freshToken(),
    client_id: 'new-client',
    refresh_token: 'newest-refresh',
  });
  finish(Response.json({ ...freshToken(), refresh_token: 'outdated-response' }));
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(h.token.client_id, 'new-client');
  assert.equal(h.token.refresh_token, 'newest-refresh');
});

for (const [label, value] of Object.entries({
  null: null,
  array: [],
  numericAccessToken: { ...freshToken(), access_token: 12 },
  emptyRefreshToken: { ...freshToken(), refresh_token: '' },
  stringExpiry: { ...freshToken(), expires_in: '3600' },
  invalidRecovery: { ...freshToken(), _refresh_recovery: 'true' },
  invalidRequestId: { ...freshToken(), _refresh_state: 'pending', _refresh_request_id: 'short' },
  requestIdWithoutPending: { ...freshToken(), _refresh_request_id: 'a'.repeat(43) },
})) {
  test(`malformed saved credentials (${label}) block use without clearing or replaying them`, async (t) => {
    const stored = JSON.stringify(value);
    const h = harness(t, { shared: { stored } });
    assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
    assert.equal(h.shared.stored, stored);
    assert.equal(h.requests.length, 0);
    assert.equal(h.opens.length, 0);
    assert.ok(h.logs.some((line) => line.includes('invalid_storage')));
  });
}

for (const [label, response] of Object.entries({
  null: null,
  numericToken: { access_token: 42 },
  invalidRefresh: { access_token: 'accepted', refresh_token: {} },
  invalidExpiry: { access_token: 'accepted', expires_in: '3600' },
  wrongClient: { access_token: 'accepted', client_id: 'different-client' },
})) {
  test(`malformed refresh response (${label}) retains pending state and is not replayed`, async (t) => {
    const token = { ...freshToken(), _got_at: 0 };
    const h = harness(t, { token, onRefresh: async () => Response.json(response) });
    assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
    assert.deepEqual(h.token, { ...token, _refresh_state: 'pending' });
    assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
    assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 1);
    assert.equal(h.opens.length, 0);
  });
}

test('refresh responses cannot replace local recovery metadata or timestamps', async (t) => {
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    recovery: true,
    onRefresh: async () =>
      Response.json({
        access_token: 'accepted',
        refresh_token: 'rotated',
        expires_in: 7200,
        _got_at: 1,
        _refresh_state: 'rejected',
        _refresh_request_id: 'forged',
        _refresh_recovery: false,
      }),
  });
  assertBridge(await h.provider.resolveMcpServerDefinition(), h, 'accepted');
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.token._refresh_request_id, undefined);
  assert.equal(h.token._refresh_recovery, true);
  assert.ok(h.token._got_at > 1);
  assert.equal(h.token.refresh_token, 'rotated');
});

test('a malformed OAuth error body leaves refresh outcome pending', async (t) => {
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    onRefresh: async () => Response.json(null, { status: 400 }),
  });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.token._refresh_state, 'pending');
  assert.ok(h.logs.some((line) => line.includes('token refresh HTTP 400')));
  assert.equal(h.opens.length, 0);
});

test('invalid client registration is rejected before opening the browser', async (t) => {
  const h = harness(t, {
    transport: async () => Response.json({ client_id: 123 }, { status: 201 }),
  });
  await until(() => h.messages.some((message) => message.includes('no valid client_id')));
  assert.equal(h.opens.length, 0);
  assert.equal(h.token, undefined);
});

test('invalid authorization-code token response is never persisted', async (t) => {
  const h = harness(t, {
    transport: async (url) =>
      url.endsWith('/register')
        ? Response.json({ client_id: 'client' }, { status: 201 })
        : Response.json({ access_token: ['invalid'] }),
  });
  await until(() =>
    h.messages.some((message) => message.includes('token response has an invalid format')),
  );
  assert.equal(h.token, undefined);
  assert.equal(h.shared.extraSecrets.size, 0);
});

test('disposing the auth session before activation settles prevents browser startup', async (t) => {
  const h = harness(t, { clock: { now: Date.now() } });
  h.disposeSession();
  await tick();
  await tick();
  assert.equal(h.opens.length, 0);
  assert.equal(h.progressCount, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.shared.secretListeners.size, 0);
  assert.equal(h.requests.length, 0);
});

test('disposing the auth session cancels its browser callback and releases storage listeners', async (t) => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  const signIn = h.commands.get('rdh.signIn')();
  h.disposeSession();
  await signIn;
  assert.equal(h.token, undefined);
  assert.equal(h.shared.secretListeners.size, 0);
  await assert.rejects(realFetch(h.callbackUris[0]));
  await h.commands.get('rdh.signIn')();
  assert.equal(h.opens.length, 1);
});

test('disposing the auth session removes its scheduled refresh', async (t) => {
  const h = harness(t, { token: freshToken(), clock: { now: Date.now() } });
  await until(() => h.timers.size === 1);
  h.disposeSession();
  assert.equal(h.timers.size, 0);
  await h.advance(4_000_000);
  assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 0);
  assert.equal(h.shared.secretListeners.size, 0);
});

test('a dispatched rotation persists after disposal without rescheduling or replay', async (t) => {
  let finishRefresh;
  const h = harness(t, {
    token: { ...freshToken(), _got_at: 0 },
    clock: { now: Date.now() },
    onRefresh: () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  });
  await until(() => finishRefresh);
  assert.equal(h.token._refresh_state, 'pending');
  h.disposeSession();
  finishRefresh(Response.json({ ...freshToken(), refresh_token: 'rotated-after-disposal' }));
  await until(() => h.token.refresh_token === 'rotated-after-disposal');
  await tick();
  await tick();
  assert.equal(h.token._refresh_state, undefined);
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 1);
  assert.equal(h.opens.length, 0);
});

test('a transient discovery failure does not end background refresh', async (t) => {
  // Both the first schedule and the one after the failed credential check fail.
  let attempts = 0;
  const h = harness(t, {
    token: freshToken(),
    clock: { now: Date.now() },
    beforeAuthMetadata: async () => {
      if (++attempts <= 2) {
        throw new Error('network down');
      }
    },
  });
  await h.startup;
  await until(() => attempts === 2 && h.timers.size === 1);
  await h.advance(60_000);
  await until(() => attempts === 3 && h.timers.size === 1);
  await h.advance(4_000_000);
  await until(() => h.requests.some((request) => request.url.includes('/token')));
});
