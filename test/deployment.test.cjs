const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const {
  PUBLIC_URL: GUARD_PUBLIC_URL,
  MCP_PUBLIC_URL: GUARD_MCP_URL,
} = require('../out/deploymentDefaults');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDeployment, userDeploymentValue } = require('../out/authConfig');
const { PUBLIC_URL, MCP_PUBLIC_URL } = require('../out/deploymentDefaults');
const { CredentialStore } = require('../out/credentialStore');
const { harness, freshToken, until, tick } = require('./helpers/authHarness.cjs');

test('default deployment identifies the MCP resource without assuming its OAuth authority', () => {
  const config = resolveDeployment();
  assert.equal(config.publicUrl, PUBLIC_URL);
  assert.equal(config.mcpOrigin, MCP_PUBLIC_URL);
  for (const [key, path] of Object.entries({
    mcpUri: '/mcp',
    resource: '/mcp',
  })) {
    assert.equal(config[key], config.mcpOrigin + path);
  }
});

test('deployment identity is canonical and depends on the credential recipient only', () => {
  const a = resolveDeployment({ mcpPublicUrl: 'https://MCP.example:443/' });
  const b = resolveDeployment({
    mcpPublicUrl: 'https://mcp.example',
    publicUrl: 'https://web.example',
  });
  assert.equal(a.credentialNamespace, b.credentialNamespace);
  assert.notEqual(a.credentialNamespace, resolveDeployment().credentialNamespace);
  assert.notEqual(
    a.credentialNamespace,
    resolveDeployment({ mcpPublicUrl: 'https://mcp.example:9443' }).credentialNamespace,
  );
  assert.equal(resolveDeployment({ mcpPublicUrl: '' }).mcpOrigin, resolveDeployment().mcpOrigin);
});

test('deployment rejects ambiguous or unsafe credential destinations', () => {
  for (const value of [
    123,
    null,
    'not-url',
    'http://hub.example',
    'https://u:p@hub.example',
    'https://hub.example/api',
    'https://hub.example/?x=1',
    'https://hub.example/#frag',
    'file:///tmp',
  ]) {
    assert.throws(() => resolveDeployment({ mcpPublicUrl: value }));
    assert.throws(() => resolveDeployment({ publicUrl: value }));
  }
  for (const value of ['http://localhost:8090', 'http://127.0.0.1:8090', 'http://[::1]:8090']) {
    assert.equal(resolveDeployment({ mcpPublicUrl: value }).mcpOrigin, value);
  }
});

test('workspace and language overrides cannot select the credential destination', () => {
  assert.equal(
    userDeploymentValue({
      workspaceValue: 'https://evil.example',
      workspaceFolderValue: 'https://evil.example',
    }),
    undefined,
  );
  assert.equal(
    userDeploymentValue({
      globalValue: 'https://user.example',
      workspaceValue: 'https://evil.example',
      globalLanguageValue: 'https://evil.example',
    }),
    'https://user.example',
  );
});

test('tokens, history, recovery keys and notifications are isolated from other deployments and unscoped storage', async () => {
  const values = new Map([['rdh.tokens.v1', JSON.stringify(freshToken('unscoped'))]]);
  const listeners = new Set();
  const secrets = {
    async get(key) {
      return values.get(key);
    },
    async store(key, value) {
      values.set(key, value);
      for (const fn of listeners) {
        fn({ key });
      }
    },
    async delete(key) {
      values.delete(key);
      for (const fn of listeners) {
        fn({ key });
      }
    },
    onDidChange(fn) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
  };
  const a = new CredentialStore(secrets, resolveDeployment().credentialNamespace);
  const b = new CredentialStore(
    secrets,
    resolveDeployment({ mcpPublicUrl: 'https://other.example' }).credentialNamespace,
  );
  let changes = 0;
  a.onDidChange(() => changes++);
  assert.equal(await a.read(), undefined);
  await b.save(freshToken('other'));
  assert.equal(changes, 0);
  assert.equal(await a.read(), undefined);
  await a.save(freshToken());
  await a.recordAuthHistory({ signed_out_at: 1 });
  await a.saveRecoveryKey('client', 'secret-a');
  await b.saveRecoveryKey('client', 'secret-b');
  assert.equal(await b.hasAuthHistory(), undefined);
  assert.equal(await a.recoveryKey('client'), 'secret-a');
  assert.equal(await b.recoveryKey('client'), 'secret-b');
  await a.clearForClient('client');
  assert.equal(await a.read(), undefined);
  assert.equal((await b.read()).access_token, 'other');
  assert.equal(await b.recoveryKey('client'), 'secret-b');
  assert.equal(JSON.parse(values.get('rdh.tokens.v1')).access_token, 'unscoped');
  assert.equal(changes, 2);
});

test('User configuration governs browser authorization, token exchange, resource and MCP', async (t) => {
  const h = harness(t, {
    configuration: {
      publicUrl: { globalValue: 'https://website.example' },
      mcpPublicUrl: {
        globalValue: 'https://hub.example:9443',
        workspaceValue: 'https://evil.example',
      },
    },
  });
  await until(() => h.token);
  assert.equal(h.opens[0].origin, 'https://hub.example:9443');
  assert.equal(h.opens[0].pathname, '/authorize');
  assert.equal(h.opens[0].searchParams.get('resource'), 'https://hub.example:9443/mcp');
  assert.equal(h.chatDeps.endpoint, 'https://hub.example:9443/mcp');
  assert.equal(
    (await h.provider.resolveMcpServerDefinition()).uri.origin,
    'https://hub.example:9443',
  );
  await h.commands.get('rdh.signOut')();
  for (const request of h.requests) {
    assert.equal(new URL(request.url).origin, 'https://hub.example:9443');
  }
});

test('deployment edits remain pinned until reload and workspace-only changes are ignored', async (t) => {
  const h = harness(t, { token: freshToken() });
  await until(() => h.requests.length);
  h.changeConfiguration('mcpPublicUrl', { workspaceValue: 'https://evil.example' });
  await tick();
  assert.equal(
    h.messages.some((message) => message.includes('until you reload')),
    false,
  );
  h.changeConfiguration('mcpPublicUrl', { globalValue: 'https://next.example' });
  await tick();
  assert.ok(h.messages.some((message) => message.includes('until you reload')));
  await h.commands.get('rdh.signOut')();
  assert.equal(h.requests.at(-1).url, MCP_PUBLIC_URL + '/revoke');
  assert.equal(h.chatDeps.endpoint, MCP_PUBLIC_URL + '/mcp');
});

test('an in-flight refresh stays on its original deployment after settings change', async (t) => {
  let finish;
  const h = harness(t, {
    configuration: { mcpPublicUrl: { globalValue: 'https://first.example' } },
    token: { ...freshToken(), _issuer: 'https://first.example/', _got_at: 0 },
    recovery: true,
    onRefresh: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await until(() => finish);
  h.changeConfiguration('mcpPublicUrl', { globalValue: 'https://second.example' });
  finish(Response.json({ ...freshToken(), refresh_token: 'rotated-on-first' }));
  await until(() => h.token.refresh_token === 'rotated-on-first');
  assert.equal(
    h.requests.find((request) => request.url.endsWith('/token/refresh')).url,
    'https://first.example/token/refresh',
  );
  assert.equal((await h.provider.resolveMcpServerDefinition()).uri.origin, 'https://first.example');
  assert.ok(h.requests.every((request) => new URL(request.url).origin === 'https://first.example'));
});

test('runtime sources keep deployment hosts in generated defaults only', () => {
  const source = path.join(__dirname, '../src');
  const forbidden = [GUARD_PUBLIC_URL, GUARD_MCP_URL].map((url) => new URL(url).hostname);
  forbidden.push('xdistribute' + '.site');
  for (const file of readdirSync(source, { recursive: true })) {
    if (!/\.(?:ts|mts)$/.test(file) || file.replaceAll('\\', '/') === 'deploymentDefaults.ts') {
      continue;
    }
    const content = readFileSync(path.join(source, file), 'utf8');
    assert.equal(
      forbidden.some((host) => content.includes(host)),
      false,
      file,
    );
  }
});
