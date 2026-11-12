const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { harness, freshToken, tick, until, TOKEN_KEY } = require('./helpers/authHarness.cjs');

for (const stored of [undefined, freshToken(), { ...freshToken(), _got_at: 0 }, '{broken-json']) {
  test(`activation and discovery stay idle with ${typeof stored === 'object' ? 'saved credentials' : String(stored)}`, async (t) => {
    const h = harness(t, {
      activateOnly: true,
      clock: { now: Date.now() },
      shared: { stored: typeof stored === 'object' ? JSON.stringify(stored) : stored },
    });
    const definitions = await h.provider.provideMcpServerDefinitions();
    await tick();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].label, Object.keys(require('../mcp.json').mcpServers)[0]);
    assert.equal(definitions[0].headers, undefined);
    assert.equal(h.requests.length + h.discoveryRequests.length, 0);
    assert.equal(h.secretReads.length, 0);
    assert.equal(h.signInPrompts.length, 0);
    assert.equal(h.opens.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('three idle windows do not refresh credentials when another window changes them', async (t) => {
  const shared = { stored: JSON.stringify(freshToken()) };
  const scope = randomUUID();
  const windows = Array.from({ length: 3 }, () =>
    harness(t, { activateOnly: true, shared, scope, clock: { now: Date.now() } }),
  );
  let changes = 0;
  for (const h of windows) {
    h.provider.onDidChangeMcpServerDefinitions(() => changes++);
    await h.provider.provideMcpServerDefinitions();
  }
  shared.stored = JSON.stringify({ ...freshToken(), _got_at: 0 });
  for (const listener of shared.secretListeners) {
    listener({ key: TOKEN_KEY });
  }
  await tick();
  assert.equal(changes, windows.length);
  for (const h of windows) {
    assert.equal(h.requests.length + h.discoveryRequests.length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('simultaneous first use in three windows opens only one authorization', async (t) => {
  const shared = {};
  const scope = randomUUID();
  const windows = Array.from({ length: 3 }, () =>
    harness(t, { activateOnly: true, shared, scope, hold: true }),
  );
  const pending = windows.map((h) => h.provider.resolveMcpServerDefinition());
  await until(() => windows.some((h) => h.opens.length));
  const owner = windows.find((h) => h.opens.length);
  await owner.callback(owner.opens[0]);
  const definitions = await Promise.all(pending);
  assert.equal(windows.flatMap((h) => h.opens).length, 1);
  assert.equal(windows.flatMap((h) => h.signInPrompts).length, 1);
  assert.equal(
    windows.flatMap((h) => h.requests).filter((r) => r.url.endsWith('/register')).length,
    1,
  );
  for (const definition of definitions) {
    assert.equal(definition.headers.Authorization, 'Bearer accepted');
  }
});

test('concurrent explicit sign-in requests do not retry a declined authorization', async (t) => {
  let decline;
  const shared = {};
  const scope = randomUUID();
  const a = harness(t, {
    activateOnly: true,
    shared,
    scope,
    confirmSignIn: () =>
      new Promise((resolve) => {
        decline = resolve;
      }),
  });
  const b = harness(t, { activateOnly: true, shared, scope });
  const pending = [a.commands.get('rdh.signIn')(), b.commands.get('rdh.signIn')()];
  await until(() => decline);
  decline(undefined);
  await Promise.all(pending);
  assert.equal(a.signInPrompts.length + b.signInPrompts.length, 1);
  assert.equal(a.opens.length + b.opens.length, 0);
  await b.commands.get('rdh.signIn')();
  assert.equal(b.opens.length, 1);
});

test('a credential check delayed past another window signing out cannot restart that account', async (t) => {
  let releasePing;
  const shared = { stored: JSON.stringify(freshToken()) };
  const scope = randomUUID();
  const a = harness(t, {
    activateOnly: true,
    shared,
    scope,
    transport: () =>
      new Promise((resolve) => {
        releasePing = resolve;
      }),
  });
  const b = harness(t, { activateOnly: true, shared, scope });
  const resolving = a.provider.resolveMcpServerDefinition();
  await until(() => releasePing);
  await b.commands.get('rdh.signOut')();
  releasePing(Response.json({}));
  assert.equal(await resolving, undefined);
  assert.equal(shared.stored, undefined);
  assert.equal(a.opens.length + b.opens.length, 0);
  assert.equal(a.requests.filter((r) => r.url.endsWith('/token')).length, 0);
});

test('a delayed credential check switches to a newer account instead of returning the old token', async (t) => {
  let releasePing;
  let pings = 0;
  const shared = { stored: JSON.stringify(freshToken()) };
  const h = harness(t, {
    activateOnly: true,
    shared,
    transport: () =>
      ++pings === 1
        ? new Promise((resolve) => {
            releasePing = resolve;
          })
        : Response.json({}),
  });
  const resolving = h.provider.resolveMcpServerDefinition();
  await until(() => releasePing);
  shared.stored = JSON.stringify({ ...freshToken('new-account'), client_id: 'new-client' });
  for (const listener of shared.secretListeners) {
    listener({ key: TOKEN_KEY });
  }
  releasePing(Response.json({}));
  assert.equal((await resolving).headers.Authorization, 'Bearer new-account');
  assert.equal(h.opens.length, 0);
});

test('sign-out in another window also invalidates a delayed check after first sign-in', async (t) => {
  let releasePing;
  const shared = {};
  const scope = randomUUID();
  const a = harness(t, {
    activateOnly: true,
    shared,
    scope,
    transport(url) {
      if (url.endsWith('/register')) {
        return Response.json({ client_id: 'client' }, { status: 201 });
      }
      if (url.endsWith('/token')) {
        return Response.json(freshToken());
      }
      return new Promise((resolve) => {
        releasePing = resolve;
      });
    },
  });
  const b = harness(t, { activateOnly: true, shared, scope });
  const resolving = a.provider.resolveMcpServerDefinition();
  await until(() => releasePing);
  await b.commands.get('rdh.signOut')();
  releasePing(Response.json({}));
  assert.equal(await resolving, undefined);
  assert.equal(shared.stored, undefined);
  assert.equal(a.opens.length, 1);
  assert.equal(b.opens.length, 0);
});

test('an unused window stays idle when a used window signs out', async (t) => {
  const a = harness(t, { token: freshToken() });
  const b = harness(t, { activateOnly: true, shared: a.shared, scope: a.scope });
  await a.startup;
  await a.commands.get('rdh.signOut')();
  await b.provider.provideMcpServerDefinitions();
  await tick();
  assert.equal(b.requests.length + b.discoveryRequests.length, 0);
  assert.equal(await b.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(b.opens.length, 0);
});

test('the MCP server and account commands register without the chat participant API', (t) => {
  const h = harness(t, { activateOnly: true, chatUnavailable: true });
  assert.equal(h.provider.provideMcpServerDefinitions().length, 1);
  for (const command of ['rdh.signIn', 'rdh.signOut', 'rdh.showStatus', 'rdh.showLogs']) {
    assert.ok(h.commands.has(command), command);
  }
  assert.match(JSON.stringify(h.logs), /@remote-device-hub is unavailable in this editor/);
});
