const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { harness, freshToken, tick, until, TOKEN_KEY } = require('./helpers/authHarness.cjs');

test('first discovery asks to connect once, then publishes the signed-in definition', async (t) => {
  const h = harness(t, { activateOnly: true });
  let changes = 0;
  h.provider.onDidChangeMcpServerDefinitions(() => changes++);
  // No definition without credentials: the editor must never start its own OAuth.
  assert.equal((await h.provider.provideMcpServerDefinitions()).length, 0);
  await until(() => h.token);
  assert.equal(h.signInPrompts.length, 1);
  assert.equal(h.opens.length, 1);
  assert.ok(changes > 0);
  const definitions = await h.provider.provideMcpServerDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].label, Object.keys(require('../mcp.json').mcpServers)[0]);
  assert.equal(definitions[0].headers.Authorization, 'Bearer accepted');
  assert.equal(h.signInPrompts.length, 1);
});

test('a declined first connection is not offered again by later discovery or reloads', async (t) => {
  const shared = {};
  const scope = randomUUID();
  const a = harness(t, { activateOnly: true, shared, scope, confirmSignIn: () => undefined });
  assert.equal((await a.provider.provideMcpServerDefinitions()).length, 0);
  await until(() => a.signInPrompts.length === 1 && shared.authState);
  assert.equal((await a.provider.provideMcpServerDefinitions()).length, 0);
  // A reloaded window sees the recorded attempt and stays quiet.
  const b = harness(t, { activateOnly: true, shared, scope, clock: { now: Date.now() } });
  assert.equal((await b.provider.provideMcpServerDefinitions()).length, 0);
  await tick();
  assert.equal(a.signInPrompts.length + b.signInPrompts.length, 1);
  assert.equal(a.opens.length + b.opens.length, 0);
  assert.equal(b.requests.length + b.discoveryRequests.length, 0);
  assert.equal(b.timers.size, 0);
});

test('unreadable saved credentials withhold the definition and offer Sign In', async (t) => {
  const h = harness(t, {
    activateOnly: true,
    clock: { now: Date.now() },
    shared: { stored: '{broken-json' },
  });
  assert.equal((await h.provider.provideMcpServerDefinitions()).length, 0);
  await tick();
  assert.equal(h.messages.filter((message) => message.includes('Sign In')).length, 1);
  assert.equal(h.requests.length + h.discoveryRequests.length, 0);
  assert.equal(h.signInPrompts.length, 0);
  assert.equal(h.opens.length, 0);
  assert.equal(h.timers.size, 0);
});

test('discovery publishes saved credentials without resolving, prompting, or validating', async (t) => {
  const h = harness(t, {
    activateOnly: true,
    clock: { now: Date.now() },
    shared: { stored: JSON.stringify(freshToken()) },
  });
  const definitions = await h.provider.provideMcpServerDefinitions();
  assert.equal(definitions[0].headers.Authorization, 'Bearer accepted');
  assert.equal(h.requests.length, 0);
  assert.equal(h.signInPrompts.length, 0);
  assert.equal(h.opens.length, 0);
  // Saved credentials make this window keep them fresh.
  await until(() => h.timers.size === 1);
});

test('discovery refreshes expired saved credentials before publishing them', async (t) => {
  const h = harness(t, {
    activateOnly: true,
    shared: { stored: JSON.stringify({ ...freshToken(), _got_at: 0 }) },
    onRefresh: () => Response.json({ ...freshToken('rotated'), refresh_token: 'next' }),
  });
  const definitions = await h.provider.provideMcpServerDefinitions();
  assert.equal(definitions[0].headers.Authorization, 'Bearer rotated');
  assert.equal(h.requests.filter((request) => request.url.endsWith('/token')).length, 1);
  assert.equal(h.signInPrompts.length, 0);
  assert.equal(h.opens.length, 0);
});

test('three discovering windows rotate expired credentials once and all publish the result', async (t) => {
  const shared = { stored: JSON.stringify({ ...freshToken(), _got_at: 0 }) };
  const scope = randomUUID();
  const windows = Array.from({ length: 3 }, () =>
    harness(t, {
      activateOnly: true,
      shared,
      scope,
      onRefresh: () => Response.json({ ...freshToken('rotated'), refresh_token: 'next' }),
    }),
  );
  const published = await Promise.all(windows.map((h) => h.provider.provideMcpServerDefinitions()));
  for (const definitions of published) {
    assert.equal(definitions[0].headers.Authorization, 'Bearer rotated');
  }
  assert.equal(
    windows.flatMap((h) => h.requests).filter((request) => request.url.endsWith('/token')).length,
    1,
  );
  assert.equal(windows.flatMap((h) => h.opens).length, 0);
});

test('a signed-out window withdraws the definition and is not signed back in', async (t) => {
  const h = harness(t, { token: freshToken() });
  await h.startup;
  assert.equal(
    (await h.provider.provideMcpServerDefinitions())[0].headers.Authorization,
    'Bearer accepted',
  );
  let changes = 0;
  h.provider.onDidChangeMcpServerDefinitions(() => changes++);
  await h.commands.get('rdh.signOut')();
  assert.ok(changes > 0);
  assert.equal((await h.provider.provideMcpServerDefinitions()).length, 0);
  await tick();
  // Signing out is remembered: discovery does not sign the account back in.
  assert.equal(h.opens.length, 0);
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
