const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const realFetch = global.fetch;
const source = fs.readFileSync(require.resolve('../out/extension.js'), 'utf8');
const freshToken = (access_token = 'accepted') => ({ access_token, refresh_token: 'refresh', client_id: 'client', _got_at: Date.now() / 1000, expires_in: 3600 });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) { throw new Error('condition timed out'); }
    await tick();
  }
}
function harness(t, options = {}) {
  let stored = options.token && JSON.stringify(options.token);
  const commands = new Map(), listeners = new Set(), messages = [], opens = [], requests = [], logs = [];
  const relays = [], callbackUris = [], controllers = [];
  let provider, progressCount = 0, clipboard;
  const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
  };
  const cancel = () => { cancellation.isCancellationRequested = true; for (const fn of listeners) { fn(); } };
  const dispose = () => ({ dispose() {} });
  const vscode = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    Disposable: class { constructor(fn) { this.dispose = fn; } },
    ProgressLocation: { Notification: 15 },
    McpHttpServerDefinition: class { constructor(label, uri, headers) { Object.assign(this, { label, uri, headers }); } },
    Uri: { parse: value => new URL(value) },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return dispose(); } },
    lm: { registerMcpServerDefinitionProvider(id, value) { provider = value; return dispose(); } },
    window: {
      createOutputChannel: () => ({ info: s => logs.push(s), debug: s => logs.push(s), warn: s => logs.push(s), error: s => logs.push(s), show() {}, dispose() {} }),
      withProgress(_options, fn) { progressCount++; const p = fn({ report() {} }, cancellation); controllers.push(p); return p; },
      async showInformationMessage(text) { messages.push(text); },
      async showWarningMessage(text) { messages.push(text); return options.copy ? 'Copy Link' : undefined; },
      async showErrorMessage(text) { messages.push(text); },
    },
    env: {
      async asExternalUri(uri) {
        callbackUris.push(uri.toString());
        if (options.tunnelError) { throw new Error('forwarding unavailable'); }
        if (!options.ssh) { return uri; }
        // Different client port, forwarding the actual callback to the extension host.
        const relay = http.createServer((req, res) => {
          const upstream = http.request(new URL(req.url, uri), { method: req.method }, incoming => {
            res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
          });
          upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
        });
        relays.push(relay);
        await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
        return new URL(`http://127.0.0.1:${relay.address().port}/callback`);
      },
      async openExternal(uri) {
        opens.push(uri);
        if (options.openFalse) { return false; }
        if (!options.hold) { await callback(uri); }
        return true;
      },
      clipboard: { async writeText(value) { clipboard = value; await callback(new URL(value)); } },
    },
  };
  async function callback(uri) {
    const target = new URL(uri.searchParams.get('redirect_uri'));
    target.searchParams.set('code', 'test-code');
    target.searchParams.set('state', uri.searchParams.get('state'));
    const res = await realFetch(target); assert.equal(res.status, 200); await res.text();
  }
  const context = { subscriptions: [], secrets: {
    async get() { return stored; }, async store(_key, value) { stored = value; }, async delete() { stored = undefined; },
  } };
  const exports = {};
  vm.runInNewContext(source, {
    exports, require: name => name === 'vscode' ? vscode : name === './chat' ? { registerChat() {} } : require(name),
    URL, URLSearchParams, Buffer, AbortSignal, AbortController, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/register')) { return Response.json({ client_id: 'client' }, { status: 201 }); }
      if (url.endsWith('/token')) {
        if (init.body.includes('grant_type=refresh_token')) {
          return options.refreshOk ? Response.json(freshToken()) : Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return Response.json(freshToken());
      }
      if (url.endsWith('/mcp')) {
        const status = options.mcpStatus || (init.headers.Authorization === 'Bearer accepted' ? 200 : 401);
        return Response.json({}, { status });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  }, { filename: 'extension.js' });
  exports.activate(context);
  t.after(async () => {
    for (const item of context.subscriptions) { item.dispose(); }
    await Promise.all(controllers);
    for (const relay of relays) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
  });
  return { commands, provider, messages, opens, requests, logs, callbackUris, callback, cancel,
    get token() { return stored && JSON.parse(stored); },
    get progressCount() { return progressCount; }, get clipboard() { return clipboard; },
  };
}

for (const ssh of [false, true]) {
  test(`activation automatically authorizes via ${ssh ? 'forwarded SSH callback' : 'local callback'}`, async t => {
    const h = harness(t, { ssh });
    await until(() => h.token);
    assert.equal(h.opens.length, 1);
    const browserRedirect = h.opens[0].searchParams.get('redirect_uri');
    assert.equal(browserRedirect === h.callbackUris[0], !ssh);
    const registration = h.requests.find(r => r.url.endsWith('/register'));
    assert.equal(JSON.parse(registration.init.body).redirect_uris[0], browserRedirect);
    const exchange = h.requests.find(r => r.url.endsWith('/token'));
    const body = new URLSearchParams(exchange.init.body);
    assert.equal(body.get('redirect_uri'), browserRedirect);
    const challenge = require('node:crypto').createHash('sha256').update(body.get('code_verifier')).digest('base64url');
    assert.equal(challenge, h.opens[0].searchParams.get('code_challenge'));
    assert.equal((await h.provider.resolveMcpServerDefinition()).headers.Authorization, 'Bearer accepted');
    assert.ok(!h.messages.some(m => m.includes('sign in to use')));
  });
}
test('activation, MCP startup and Sign In share one browser flow', async t => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  const resolving = h.provider.resolveMcpServerDefinition();
  const manual = h.commands.get('rdh.signIn')();
  await tick();
  assert.equal(h.progressCount, 1);
  await h.callback(h.opens[0]); await manual;
  assert.equal((await resolving).headers.Authorization, 'Bearer accepted');
  assert.equal(h.opens.length, 1);
});
test('accepted stored credentials do not open a browser', async t => {
  const h = harness(t, { token: freshToken() });
  assert.equal((await h.provider.resolveMcpServerDefinition()).headers.Authorization, 'Bearer accepted');
  assert.equal(h.opens.length, 0);
});
test('MCP startup automatically signs in when unexpired token is rejected', async t => {
  const h = harness(t, { token: freshToken('revoked') });
  assert.equal((await h.provider.resolveMcpServerDefinition()).headers.Authorization, 'Bearer accepted');
  assert.equal(h.opens.length, 1);
  assert.equal(h.requests.filter(r => r.url.endsWith('/mcp')).length, 2);
});
test('rejected credentials refresh before invoking browser', async t => {
  const h = harness(t, { token: freshToken('revoked'), refreshOk: true });
  assert.equal((await h.provider.resolveMcpServerDefinition()).headers.Authorization, 'Bearer accepted');
  assert.equal(h.opens.length, 0);
});
test('MCP outage stops startup without starting OAuth', async t => {
  const h = harness(t, { token: freshToken(), mcpStatus: 503 });
  assert.equal(await h.provider.resolveMcpServerDefinition(), undefined);
  assert.equal(h.opens.length, 0);
});
test('browser open false allows copying the same authorization URL', async t => {
  const h = harness(t, { openFalse: true, copy: true, ssh: true });
  await until(() => h.token);
  assert.equal(h.clipboard, h.opens[0].toString());
});
test('cancellation stops waiting, closes callback and prevents MCP startup', async t => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  const resolving = h.provider.resolveMcpServerDefinition();
  await tick(); h.cancel();
  assert.equal(await resolving, undefined);
  assert.equal(h.token, undefined);
  await assert.rejects(realFetch(h.callbackUris[0]));
});
test('SSH forwarding failure is reported and callback is closed', async t => {
  const h = harness(t, { tunnelError: true });
  await until(() => h.messages.some(m => m.includes('forwarding unavailable')));
  assert.equal(h.opens.length, 0);
  await assert.rejects(realFetch(h.callbackUris[0]));
});
test('sign-out cancels an in-flight login before clearing credentials', async t => {
  const h = harness(t, { hold: true });
  await until(() => h.opens.length);
  await h.commands.get('rdh.signOut')();
  assert.equal(h.token, undefined);
  await assert.rejects(realFetch(h.callbackUris[0]));
});
test('reload automatically authorizes when saved unexpired credentials were revoked', async t => {
  const h = harness(t, { token: freshToken('revoked') });
  await until(() => h.token?.access_token === 'accepted');
  assert.equal(h.opens.length, 1);
  assert.equal(h.progressCount, 1);
});
test('reload retains server-accepted credentials and explains why no browser opens', async t => {
  const h = harness(t, { token: freshToken() });
  await until(() => h.logs.some(line => line.includes('browser sign-in is not needed')));
  assert.equal(h.opens.length, 0);
  assert.equal(h.requests.filter(r => r.url.endsWith('/mcp')).length, 1);
});
