const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const realFetch = global.fetch;
const source = fs.readFileSync(require.resolve('../../out/extension.js'), 'utf8');
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
  const shared = options.shared || { stored: options.token && JSON.stringify(options.token) };
  shared.secretListeners ||= new Set();
  shared.extraSecrets ||= new Map();
  if (options.recovery && shared.stored) {
    const token = JSON.parse(shared.stored);
    token._refresh_recovery = true;
    shared.stored = JSON.stringify(token);
    const key = 'rdh.refreshKey.v1.' + token.client_id;
    if (!options.noRecoveryKey && !shared.extraSecrets.has(key)) {
      shared.extraSecrets.set(key, options.recoveryKey || require('node:crypto').randomBytes(32).toString('base64url'));
    }
  }
  const scope = options.scope || require('node:crypto').randomUUID();
  const commands = new Map(), listeners = new Set(), messages = [], opens = [], requests = [], logs = [];
  const relays = [], callbackUris = [], controllers = [];
  let provider, chatDeps, progressCount = 0, clipboard;
  const clock = options.clock;
  const timers = new Map();
  let nextTimer = 0;
  class ClockDate extends Date { static now() { return clock ? clock.now : Date.now(); } }
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
  const context = { globalStorageUri: { fsPath: scope }, subscriptions: [], secrets: {
    onDidChange(fn) { shared.secretListeners.add(fn); return { dispose() { shared.secretListeners.delete(fn); } }; },
    async get(key) { return key === 'rdh.tokens.v1' ? shared.stored : key === 'rdh.authState.v1' ? shared.authState : shared.extraSecrets.get(key); },
    async store(key, value) {
      if (options.failStore?.(key, value)) { throw new Error('secret storage unavailable'); }
      if (key === 'rdh.tokens.v1') { shared.stored = value; }
      else if (key === 'rdh.authState.v1') { shared.authState = value; }
      else { shared.extraSecrets.set(key, value); }
      for (const fn of shared.secretListeners) { fn({ key }); }
    },
    async delete(key) {
      if (key === 'rdh.tokens.v1') { shared.stored = undefined; }
      else if (key === 'rdh.authState.v1') { shared.authState = undefined; }
      else { shared.extraSecrets.delete(key); }
      for (const fn of shared.secretListeners) { fn({ key }); }
    },
  } };
  const exports = {};
  vm.runInNewContext(source, {
    exports, require: name => name === 'vscode' ? vscode : name === './chat' ? { registerChat(_context, deps) { chatDeps = deps; } } : name === './credentialLock' ? require('../../out/credentialLock') : require(name),
    URL, URLSearchParams, Buffer, AbortSignal, AbortController, console, Date: ClockDate,
    setTimeout: clock ? (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock.now + delay }); return id; } : setTimeout,
    clearTimeout: clock ? id => timers.delete(id) : clearTimeout,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (options.transport) { return options.transport(url, init); }
      if (url.endsWith('/register')) { return Response.json({ client_id: 'client' }, { status: 201 }); }
      if (url.endsWith('/token/refresh')) {
        if (!options.recovery) { return Response.json({ error: 'not_found' }, { status: 404 }); }
        if (options.onRefresh) { return options.onRefresh(url, init); }
        if (options.refreshStatus) { return Response.json({ error: 'temporarily_unavailable' }, { status: options.refreshStatus }); }
        return options.refreshOk ? Response.json(freshToken()) : Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (url.endsWith('/token')) {
        if (init.body.includes('grant_type=refresh_token')) {
          if (options.onRefresh) { return options.onRefresh(url, init); }
          if (options.refreshStatus) { return Response.json({ error: 'temporarily_unavailable' }, { status: options.refreshStatus }); }
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
  return { commands, provider, chatDeps, messages, opens, requests, logs, callbackUris, callback, cancel, scope, shared,
    resetCancellation() { cancellation.isCancellationRequested = false; },
    async advance(ms) {
      clock.now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock.now) { timers.delete(id); timer.fn(); }
      }
      await tick(); await tick();
    },
    timers,
    get token() { return shared.stored && JSON.parse(shared.stored); },
    get progressCount() { return progressCount; }, get clipboard() { return clipboard; },
  };
}

module.exports = { harness, freshToken, tick, until };
