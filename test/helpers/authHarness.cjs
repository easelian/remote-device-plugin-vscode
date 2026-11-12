const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const path = require('node:path');
const realFetch = global.fetch;
const { resolveDeployment } = require('../../out/authConfig');
const { MCP_PUBLIC_URL } = require('../../out/deploymentDefaults');
const DEFAULT_NAMESPACE = resolveDeployment().credentialNamespace;
const TOKEN_KEY = `${DEFAULT_NAMESPACE}.tokens.v1`;
const AUTH_STATE_KEY = `${DEFAULT_NAMESPACE}.authState.v1`;
const REFRESH_KEY_PREFIX = `${DEFAULT_NAMESPACE}.refreshKey.v1.`;
const freshToken = (access_token = 'accepted') => ({
  access_token,
  refresh_token: 'refresh',
  client_id: 'client',
  _issuer: `${MCP_PUBLIC_URL}/`,
  _got_at: Date.now() / 1000,
  expires_in: 3600,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error('condition timed out');
    }
    await tick();
  }
}
function harness(t, options = {}) {
  const configuration = options.configuration || {};
  const deployment = resolveDeployment(options.deployment);
  const tokenKey = `${deployment.credentialNamespace}.tokens.v1`;
  const authStateKey = `${deployment.credentialNamespace}.authState.v1`;
  const refreshKeyPrefix = `${deployment.credentialNamespace}.refreshKey.v1.`;
  const issuer = options.issuer || `${deployment.mcpOrigin}/`;
  const configurationListeners = new Set();
  const shared = options.shared || { stored: options.token && JSON.stringify(options.token) };
  shared.secretListeners ||= new Set();
  shared.extraSecrets ||= new Map();
  if (options.recovery && shared.stored) {
    const token = JSON.parse(shared.stored);
    token._refresh_recovery = true;
    shared.stored = JSON.stringify(token);
    const key = refreshKeyPrefix + token.client_id;
    if (!options.noRecoveryKey && !shared.extraSecrets.has(key)) {
      shared.extraSecrets.set(
        key,
        options.recoveryKey || require('node:crypto').randomBytes(32).toString('base64url'),
      );
    }
  }
  const scope = options.scope || require('node:crypto').randomUUID();
  const commands = new Map();
  const listeners = new Set();
  const messages = [];
  const signInPrompts = [];
  const opens = [];
  const requests = [];
  const discoveryRequests = [];
  const secretReads = [];
  const logs = [];
  const relays = [];
  const callbackUris = [];
  const controllers = [];
  let provider;
  let chatDeps;
  let progressCount = 0;
  let clipboard;
  const clock = options.clock;
  const timers = new Map();
  let nextTimer = 0;
  class ClockDate extends Date {
    static now() {
      return clock ? clock.now : Date.now();
    }
  }
  const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested(fn) {
      listeners.add(fn);
      return {
        dispose() {
          listeners.delete(fn);
        },
      };
    },
  };
  const cancel = () => {
    cancellation.isCancellationRequested = true;
    for (const fn of listeners) {
      fn();
    }
  };
  const dispose = () => ({ dispose() {} });
  const vscode = {
    workspace: {
      getConfiguration: () => ({ inspect: (key) => configuration[key] }),
      onDidChangeConfiguration(fn) {
        configurationListeners.add(fn);
        return { dispose: () => configurationListeners.delete(fn) };
      },
    },
    EventEmitter: class {
      listeners = new Set();
      event = (fn) => {
        this.listeners.add(fn);
        return { dispose: () => this.listeners.delete(fn) };
      };
      fire() {
        for (const fn of this.listeners) {
          fn();
        }
      }
      dispose() {
        this.listeners.clear();
      }
    },
    Disposable: class {
      constructor(fn) {
        this.dispose = fn;
      }
    },
    ProgressLocation: { Notification: 15 },
    McpHttpServerDefinition: class {
      constructor(label, uri, headers) {
        Object.assign(this, { label, uri, headers });
      }
    },
    Uri: { parse: (value) => new URL(value) },
    commands: {
      registerCommand(name, fn) {
        commands.set(name, fn);
        return dispose();
      },
    },
    lm: {
      registerMcpServerDefinitionProvider(id, value) {
        provider = value;
        return dispose();
      },
    },
    window: {
      createOutputChannel: () => ({
        info: (s) => logs.push(s),
        debug: (s) => logs.push(s),
        warn: (s) => logs.push(s),
        error: (s) => logs.push(s),
        show() {},
        dispose() {},
      }),
      withProgress(_options, fn) {
        progressCount++;
        const p = fn({ report() {} }, cancellation);
        controllers.push(p);
        return p;
      },
      async showInformationMessage(text, messageOptions, ...items) {
        messages.push(text);
        if (messageOptions?.modal) {
          const prompt = { text, options: messageOptions, items };
          signInPrompts.push(prompt);
          return options.confirmSignIn ? options.confirmSignIn(prompt) : items[0];
        }
      },
      async showWarningMessage(text) {
        messages.push(text);
        return options.copy ? 'Copy Link' : undefined;
      },
      async showErrorMessage(text) {
        messages.push(text);
      },
    },
    env: {
      language: options.language || 'en',
      async asExternalUri(uri) {
        callbackUris.push(uri.toString());
        if (options.tunnelError) {
          throw new Error('forwarding unavailable');
        }
        if (!options.ssh) {
          return uri;
        }
        // Different client port, forwarding the actual callback to the extension host.
        const relay = http.createServer((req, res) => {
          const upstream = http.request(
            new URL(req.url, uri),
            { method: req.method },
            (incoming) => {
              res.writeHead(incoming.statusCode, incoming.headers);
              incoming.pipe(res);
            },
          );
          upstream.on('error', () => {
            res.writeHead(502);
            res.end();
          });
          req.pipe(upstream);
        });
        relays.push(relay);
        await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
        return new URL(`http://127.0.0.1:${relay.address().port}/callback`);
      },
      async openExternal(uri) {
        opens.push(uri);
        if (options.openFalse) {
          return false;
        }
        if (options.browserFlow) {
          await options.browserFlow(uri);
        } else if (!options.hold) {
          await callback(uri);
        }
        return true;
      },
      clipboard: {
        async writeText(value) {
          clipboard = value;
          await callback(new URL(value));
        },
      },
    },
  };
  async function callback(uri) {
    const target = new URL(uri.searchParams.get('redirect_uri'));
    if (options.callbackError) {
      target.searchParams.set('error', options.callbackError);
    } else {
      target.searchParams.set('code', 'test-code');
    }
    target.searchParams.set('state', uri.searchParams.get('state'));
    if (options.callbackIssuer !== null) {
      target.searchParams.set('iss', options.callbackIssuer || issuer);
    }
    const res = await realFetch(target);
    assert.equal(res.status, 200);
    await res.text();
  }
  const context = {
    globalStorageUri: { fsPath: scope },
    subscriptions: [],
    secrets: {
      onDidChange(fn) {
        shared.secretListeners.add(fn);
        return {
          dispose() {
            shared.secretListeners.delete(fn);
          },
        };
      },
      async get(key) {
        secretReads.push(key);
        return key === tokenKey
          ? shared.stored
          : key === authStateKey
            ? shared.authState
            : shared.extraSecrets.get(key);
      },
      async store(key, value) {
        if (options.failStore?.(key, value)) {
          throw new Error('secret storage unavailable');
        }
        if (key === tokenKey) {
          shared.stored = value;
        } else if (key === authStateKey) {
          shared.authState = value;
        } else {
          shared.extraSecrets.set(key, value);
        }
        for (const fn of shared.secretListeners) {
          fn({ key });
        }
      },
      async delete(key) {
        if (key === tokenKey) {
          shared.stored = undefined;
        } else if (key === authStateKey) {
          shared.authState = undefined;
        } else {
          shared.extraSecrets.delete(key);
        }
        for (const fn of shared.secretListeners) {
          fn({ key });
        }
      },
    },
  };
  const runtime = vm.createContext({
    URL,
    URLSearchParams,
    Buffer,
    AbortSignal,
    AbortController,
    console,
    Date: ClockDate,
    setTimeout: clock
      ? (fn, delay) => {
          const id = ++nextTimer;
          timers.set(id, { fn, at: clock.now + delay });
          return id;
        }
      : setTimeout,
    clearTimeout: clock ? (id) => timers.delete(id) : clearTimeout,
    fetch: async (url, init) => {
      if (url === `${deployment.mcpOrigin}/.well-known/oauth-protected-resource/mcp`) {
        discoveryRequests.push({ url, init });
        if (options.realDiscovery) {
          return realFetch(url, init);
        }
        return Response.json(
          options.resourceMetadata || {
            resource: deployment.resource,
            authorization_servers: [issuer],
            scopes_supported: ['devices:control'],
          },
        );
      }
      if (url === `${new URL(issuer).origin}/.well-known/oauth-authorization-server`) {
        discoveryRequests.push({ url, init });
        if (options.realDiscovery) {
          return realFetch(url, init);
        }
        if (options.beforeAuthMetadata) {
          await options.beforeAuthMetadata();
        }
        const base = new URL(issuer).origin;
        return Response.json(
          options.authMetadata || {
            issuer,
            authorization_endpoint: `${base}/authorize`,
            registration_endpoint: `${base}/register`,
            token_endpoint: `${base}/token`,
            rdh_refresh_endpoint: `${base}/token/refresh`,
            revocation_endpoint: `${base}/revoke`,
            scopes_supported: ['devices:control'],
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            authorization_response_iss_parameter_supported: true,
          },
        );
      }
      requests.push({ url, init });
      if (options.transport) {
        return options.transport(url, init);
      }
      if (url.endsWith('/register')) {
        return Response.json({ client_id: 'client' }, { status: 201 });
      }
      if (url.endsWith('/revoke')) {
        if (options.onRevoke) {
          return options.onRevoke(url, init);
        }
        return new Response(null, { status: options.revokeStatus || 200 });
      }
      if (url.endsWith('/token/refresh')) {
        if (!options.recovery) {
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        if (options.onRefresh) {
          return options.onRefresh(url, init);
        }
        if (options.refreshStatus) {
          return Response.json(
            { error: 'temporarily_unavailable' },
            { status: options.refreshStatus },
          );
        }
        return options.refreshOk
          ? Response.json(freshToken())
          : Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (url.endsWith('/token')) {
        if (init.body.includes('grant_type=refresh_token')) {
          if (options.onRefresh) {
            return options.onRefresh(url, init);
          }
          if (options.refreshStatus) {
            return Response.json(
              { error: 'temporarily_unavailable' },
              { status: options.refreshStatus },
            );
          }
          return options.refreshOk
            ? Response.json(freshToken())
            : Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return Response.json(freshToken());
      }
      if (url.endsWith('/mcp')) {
        const status =
          options.mcpStatus || (init.headers.Authorization === 'Bearer accepted' ? 200 : 401);
        return Response.json({}, { status });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  // Load every authentication module into the same host simulation.
  // Each harness gets an isolated CommonJS cache, while real loopback locks
  // continue coordinating independent hosts using their native timers.
  const modules = new Map();
  const load = (filename) => {
    if (modules.has(filename)) {
      return modules.get(filename);
    }
    const exports = {};
    modules.set(filename, exports);
    const localRequire = (name) => {
      if (name === 'vscode') {
        return vscode;
      }
      if (name === './chat') {
        return {
          registerChat(_context, deps) {
            chatDeps = deps;
          },
        };
      }
      if (name === './credentialLock') {
        return require('../../out/credentialLock');
      }
      if (name === './deploymentDefaults') {
        // Simulate a package built for a disposable deployment, without user settings.
        return { PUBLIC_URL: deployment.publicUrl, MCP_PUBLIC_URL: deployment.mcpOrigin };
      }
      return name.startsWith('.')
        ? load(require.resolve(path.resolve(path.dirname(filename), name)))
        : require(name);
    };
    const factory = vm.runInContext(
      '(function(exports, require) {\n' + fs.readFileSync(filename, 'utf8') + '\n})',
      runtime,
      { filename },
    );
    factory(exports, localRequire);
    return exports;
  };
  const extension = load(require.resolve('../../out/extension.js'));
  extension.activate(context);
  // Authentication tests exercise a requested connection. Activation-only tests
  // opt out so that discovery cannot accidentally trigger authentication.
  const startup = options.activateOnly
    ? Promise.resolve()
    : Promise.resolve().then(() => provider.resolveMcpServerDefinition());
  controllers.push(startup);
  const disposeSession = () => {
    for (const item of context.subscriptions) {
      item.dispose();
    }
  };
  t.after(async () => {
    disposeSession();
    await Promise.all(controllers);
    for (const relay of relays) {
      relay.closeAllConnections();
      await new Promise((resolve) => relay.close(resolve));
    }
  });
  return {
    startup,
    disposeSession,
    refreshKeyPrefix,
    changeConfiguration(key, value) {
      configuration[key] = value;
      for (const fn of configurationListeners) {
        fn({ affectsConfiguration: (name) => name === `remoteDeviceHub.${key}` });
      }
    },
    commands,
    provider,
    chatDeps,
    messages,
    signInPrompts,
    opens,
    requests,
    discoveryRequests,
    secretReads,
    logs,
    callbackUris,
    callback,
    cancel,
    scope,
    shared,
    resetCancellation() {
      cancellation.isCancellationRequested = false;
    },
    async advance(ms) {
      clock.now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock.now) {
          timers.delete(id);
          timer.fn();
        }
      }
      await tick();
      await tick();
    },
    timers,
    get token() {
      return shared.stored && JSON.parse(shared.stored);
    },
    get progressCount() {
      return progressCount;
    },
    get clipboard() {
      return clipboard;
    },
  };
}

module.exports = {
  harness,
  freshToken,
  tick,
  until,
  TOKEN_KEY,
  AUTH_STATE_KEY,
  REFRESH_KEY_PREFIX,
};
