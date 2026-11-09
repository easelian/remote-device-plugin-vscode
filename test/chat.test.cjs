const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup(options = {}) {
  const calls = [];
  const text = [];
  const confirmations = [];
  const modelRequests = [];
  const logs = [];
  const sources = [];
  const configurationListeners = new Set();
  const timers = new Map();
  const commands = new Map();
  const permissionPickers = [];
  const settingsUpdates = [];
  const errors = [];
  function tokenSource() {
    const listeners = new Set();
    const token = {
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
    return {
      token,
      listeners,
      cancel() {
        token.isCancellationRequested = true;
        for (const fn of [...listeners]) {
          fn();
        }
      },
      dispose() {
        listeners.clear();
      },
    };
  }
  const parent = tokenSource();
  const { token, listeners } = parent;
  const cancel = () => parent.cancel();
  class Text {
    constructor(value) {
      this.value = value;
    }
  }
  class Call {
    constructor(callId, name, input) {
      Object.assign(this, { callId, name, input });
    }
  }
  class Result {
    constructor(callId, content) {
      Object.assign(this, { callId, content });
    }
  }
  class RequestTurn {
    constructor(prompt, participant) {
      Object.assign(this, { prompt, participant });
    }
  }
  class ResponseTurn {}
  class Markdown {}
  let participant;
  class LanguageModelError extends Error {
    constructor(message, code = '') {
      super(message);
      this.code = code;
    }
  }
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    l10n: require('./helpers/localization.cjs').localization(options.language),
    CancellationTokenSource: class {
      constructor() {
        const source = tokenSource();
        sources.push(source);
        return source;
      }
    },
    CancellationError: class extends Error {},
    LanguageModelError,
    LanguageModelTextPart: Text,
    LanguageModelToolCallPart: Call,
    LanguageModelToolResultPart: Result,
    ChatRequestTurn: RequestTurn,
    ChatResponseTurn: ResponseTurn,
    ChatResponseMarkdownPart: Markdown,
    LanguageModelChatMessage: {
      User: (content) => ({ role: 'user', content }),
      Assistant: (content) => ({ role: 'assistant', content }),
    },
    ThemeIcon: class {},
    chat: {
      createChatParticipant(id, handler) {
        participant = { id, handler, dispose() {} };
        return participant;
      },
    },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
        return { dispose: () => commands.delete(name) };
      },
    },
    window: {
      async showQuickPick(items, pickerOptions, cancellation) {
        permissionPickers.push({
          items: structuredClone(items),
          options: pickerOptions,
          cancellation,
        });
        if (options.onQuickPick) {
          return options.onQuickPick(items, pickerOptions, cancellation);
        }
        return items.find((item) => item.value === options.pickPermission);
      },
      async showErrorMessage(message) {
        errors.push(message);
      },
      async showWarningMessage(...args) {
        confirmations.push(args);
        if (options.cancelOnConfirm) {
          cancel();
        }
        return options.onConfirm ? options.onConfirm() : options.confirm;
      },
    },
    workspace: {
      isTrusted: options.trusted !== false,
      getConfiguration(section) {
        assert.equal(section, 'remoteDeviceHub.chat');
        return {
          inspect(key) {
            return {
              globalValue: options.config?.[key],
              workspaceValue: options.workspaceConfig?.[key],
            };
          },
          async update(key, value, target) {
            if (options.updateError) {
              throw new Error('settings cannot be written');
            }
            settingsUpdates.push({ key, value, target });
            options.config = { ...options.config, [key]: value };
            if (!options.deferConfigurationEvent) {
              for (const fn of [...configurationListeners]) {
                fn({ affectsConfiguration: (name) => name === `remoteDeviceHub.chat.${key}` });
              }
            }
            if (options.afterUpdate) {
              await options.afterUpdate();
            }
          },
        };
      },
      onDidChangeConfiguration(fn) {
        configurationListeners.add(fn);
        return {
          dispose() {
            configurationListeners.delete(fn);
          },
        };
      },
    },
  };
  const runtime = {
    Buffer,
    AbortController,
    Date: class extends Date {
      static now() {
        return options.now ?? Date.now();
      }
    },
    setTimeout(fn, ms) {
      let id;
      const callback = () => {
        timers.delete(id);
        fn();
      };
      id = options.manualTimers ? {} : setTimeout(callback, ms);
      timers.set(id, { fn: callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
      if (!options.manualTimers) {
        clearTimeout(id);
      }
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ ...body, headers: init.headers });
      if (options.onFetch) {
        const response = await options.onFetch(body, init);
        if (response) {
          return response;
        }
      }
      if (options.httpStatus) {
        return new Response('', { status: options.httpStatus });
      }
      if (options.cancelOnFetch) {
        cancel();
        throw new Error('aborted');
      }
      let result;
      if (body.method === 'initialize') {
        result = { protocolVersion: '2025-03-26' };
      } else if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      } else if (body.method === 'tools/list') {
        result = {
          tools: (options.tools || ['list_devices', 'start_process']).map((tool) =>
            typeof tool === 'object'
              ? tool
              : {
                  name: tool,
                  description: tool,
                  inputSchema: ['list_devices', 'get_billing_status'].includes(tool)
                    ? { type: 'object' }
                    : {
                        type: 'object',
                        properties: { device_id: { type: 'string' } },
                        required: ['device_id'],
                      },
                },
          ),
        };
      } else if (body.method === 'tools/call') {
        result = options.toolResult?.(body.params) ?? {
          content: [{ type: 'text', text: 'device-result' }],
          isError: !!options.toolError,
        };
      } else {
        throw new Error('unknown method');
      }
      return Response.json({ jsonrpc: '2.0', id: options.badId ? 900 : body.id, result });
    },
  };
  const modules = new Map();
  const load = (filename) => {
    if (modules.has(filename)) {
      return modules.get(filename);
    }
    const exports = {};
    modules.set(filename, exports);
    vm.runInNewContext(
      fs.readFileSync(filename, 'utf8'),
      {
        ...runtime,
        exports,
        require: (name) =>
          name === 'vscode'
            ? vscode
            : name.startsWith('node:')
              ? require(name)
              : load(require.resolve(path.resolve(path.dirname(filename), name))),
      },
      { filename },
    );
    return exports;
  };
  const exports = load(require.resolve('../out/chat.js'));
  const deps = {
    endpoint: 'https://hub.test/mcp',
    ensureSignedIn: async () => options.signedIn !== false,
    accessToken: async () => 'secret-test',
    log: (message) => logs.push(message),
  };
  let round = 0;
  const model = {
    maxInputTokens: options.maxInputTokens ?? 16_384,
    async countTokens(value, cancellation) {
      if (options.countTokens) {
        return options.countTokens(value, cancellation);
      }
      return Math.ceil((typeof value === 'string' ? value : JSON.stringify(value)).length / 4);
    },
    async sendRequest(messages, requestOptions, cancellation) {
      if (options.modelError) {
        throw options.modelError;
      }
      modelRequests.push({ messages: structuredClone(messages), requestOptions, cancellation });
      const index = round++;
      if (options.sendRequest) {
        return options.sendRequest({ messages, index, cancellation });
      }
      const parts = options.responses?.[index] || [new Text('Done')];
      return {
        stream: (async function* () {
          yield* parts;
        })(),
      };
    },
  };
  const stream = { markdown: (value) => text.push(value), progress() {} };
  return {
    exports,
    deps,
    calls,
    text,
    confirmations,
    modelRequests,
    token,
    listeners,
    Call,
    Text,
    RequestTurn,
    LanguageModelError,
    cancel,
    logs,
    model,
    sources,
    configurationListeners,
    timers,
    commands,
    permissionPickers,
    settingsUpdates,
    errors,
    vscode,
    changeConfiguration(key = 'permissions') {
      for (const fn of [...configurationListeners]) {
        fn({ affectsConfiguration: (name) => name === `remoteDeviceHub.chat.${key}` });
      }
    },
    fireTimers() {
      for (const timer of [...timers.values()]) {
        timer.fn();
      }
    },
    get participant() {
      return participant;
    },
    async run(extra = {}, history = []) {
      return exports.createChatHandler(deps)(
        { prompt: 'List devices', model, ...extra },
        { history },
        stream,
        token,
      );
    },
  };
}
test('manifest and participant register the same @ entry', () => {
  const h = setup();
  const context = { subscriptions: [] };
  h.exports.registerChat(context, h.deps);
  const m = require('../package.json');
  assert.equal(m.contributes.chatParticipants[0].id, h.participant.id);
  assert.equal(m.contributes.chatParticipants[0].name, 'remote-device-hub');
  assert.equal(m.contributes.chatParticipants.length, 1);
  assert.equal(m.contributes.chatParticipants[0].commands, undefined);
  assert.equal(h.participant.followupProvider, undefined);
  assert.equal(context.subscriptions[0], h.participant);
  assert.ok(h.commands.has('rdh.setChatPermissions'));
  assert.ok(m.contributes.commands.some((command) => command.command === 'rdh.setChatPermissions'));
});

test('permissions picker writes the selected mode to User or Remote settings', async () => {
  const options = { pickPermission: 'full-access' };
  const h = setup(options);
  h.exports.registerChat({ subscriptions: [] }, h.deps);
  await h.commands.get('rdh.setChatPermissions')();
  assert.deepEqual(h.settingsUpdates, [{ key: 'permissions', value: 'full-access', target: 1 }]);
  assert.match(h.permissionPickers[0].options.placeHolder, /Copilot Agent uses VS Code/);
  assert.deepEqual(
    h.permissionPickers[0].items.map((item) => item.value),
    ['read-only', 'ask', 'full-access'],
  );
  assert.match(h.permissionPickers[0].items[1].description, /^Current:/);
  options.responses = [[new h.Call('c1', 'start_process', { device_id: 'device' })]];
  await h.run();
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
});

test('canceling the picker, reselecting the current mode, and untrusted full access do not change permissions', async () => {
  for (const options of [
    {},
    { pickPermission: 'ask' },
    { pickPermission: 'full-access', trusted: false },
  ]) {
    const h = setup(options);
    h.exports.registerChat({ subscriptions: [] }, h.deps);
    await h.commands.get('rdh.setChatPermissions')();
    assert.deepEqual(h.settingsUpdates, []);
    if (options.trusted === false) {
      assert.match(h.errors[0], /Trust this workspace/);
    }
  }
});

test('stateless discovery is reused only for the same endpoint and credential', async () => {
  const h = setup();
  const make = () => new h.exports.HubClient(h.deps, h.token);
  await make().discoverTools();
  const first = h.calls.length;
  assert.equal(first, 3);
  await make().discoverTools();
  assert.equal(h.calls.length, first);
  h.deps.accessToken = async () => 'different-account-token';
  await make().discoverTools();
  assert.equal(h.calls.length, first + 3);
  h.deps.endpoint = 'https://other.test/mcp';
  await make().discoverTools();
  assert.equal(h.calls.length, first + 6);
  assert.equal(JSON.stringify(h.logs).includes('different-account-token'), false);
});

test('discovery expires and an authentication failure invalidates it without retry', async () => {
  const options = { now: 1000 };
  const h = setup(options);
  const make = () => new h.exports.HubClient(h.deps, h.token);
  await make().discoverTools();
  options.now += 30001;
  await make().discoverTools();
  assert.equal(h.calls.length, 6);
  options.httpStatus = 401;
  await assert.rejects(make().request('tools/call', { name: 'start_process' }), /HTTP 401/);
  assert.equal(h.calls.length, 7);
  delete options.httpStatus;
  await make().discoverTools();
  assert.equal(h.calls.length, 10);
});

test('stateful initialization is never cached across chat clients', async () => {
  const options = {
    onFetch(body) {
      if (body.method === 'initialize') {
        return Response.json(
          { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } },
          { headers: { 'Mcp-Session-Id': 'session' } },
        );
      }
    },
  };
  const h = setup(options);
  await new h.exports.HubClient(h.deps, h.token).discoverTools();
  await new h.exports.HubClient(h.deps, h.token).discoverTools();
  assert.equal(h.calls.length, 6);
});
test('natural language performs tool loop using the selected model and returns results', async () => {
  const options = {};
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'list_devices', {})], [new h.Text('Found devices')]];
  await h.run();
  assert.equal(h.modelRequests.length, 2);
  const messages = h.modelRequests[1].messages;
  assert.equal(messages.at(-1).content[0].callId, 'c1');
  assert.match(messages.at(-1).content[0].content[0].value, /device-result/);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.text.at(-1), 'Found devices');
});
test('write and shell calls are not dispatched when confirmation is declined', async () => {
  const options = {};
  const h = setup(options);
  options.responses = [
    [new h.Call('c1', 'start_process', { device_id: 'device', command: 'echo test' })],
  ];
  await h.run();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0][1].detail, /device/);
  assert.equal(h.calls.filter((c) => c.method === 'tools/call').length, 0);
});
test('confirmed shell call is dispatched once and cancellation before dispatch prevents it', async () => {
  for (const cancelled of [false, true]) {
    const options = { confirm: 'Run Once', cancelOnConfirm: cancelled };
    const h = setup(options);
    options.responses = [
      [new h.Call('c1', 'start_process', { device_id: 'device', command: 'echo test' })],
    ];
    await h.run();
    assert.equal(h.calls.filter((c) => c.method === 'tools/call').length, cancelled ? 0 : 1);
  }
});
test('unadvertised tool is rejected before invocation', async () => {
  const options = {};
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'local_shell', {})]];
  const result = await h.run();
  assert.match(result.errorDetails.message, /tool that was not provided/);
  assert.equal(h.calls.filter((c) => c.method === 'tools/call').length, 0);
});
test('cancelled sign-in does not send MCP or model requests', async () => {
  const h = setup({ signedIn: false });
  await h.run();
  assert.equal(h.calls.length, 0);
  assert.equal(h.modelRequests.length, 0);
});
test('HTTP rejection and malformed RPC response surface errors without replay', async () => {
  for (const options of [{ httpStatus: 401 }, { badId: true }]) {
    const h = setup(options);
    const result = await h.run();
    assert.ok(result.errorDetails.message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.listeners.size, 0);
  }
});
test('unavailable chat model surfaces a select-a-different-model hint', async () => {
  const options = {};
  const h = setup(options);
  options.modelError = new h.LanguageModelError('The selected model is not available.', 'NotFound');
  const result = await h.run();
  assert.match(h.text.at(-1), /Select a different model for this chat and try again/);
  assert.match(result.errorDetails.message, /not available/);
  assert.equal(h.modelRequests.length, 0);
});
test('tool errors stay marked as errors in model results', async () => {
  const options = { toolError: true };
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'list_devices', {})], [new h.Text('Query failed')]];
  await h.run();
  assert.equal(
    JSON.parse(h.modelRequests[1].messages.at(-1).content[0].content[0].value).isError,
    true,
  );
});
test('history from other participants is excluded', async () => {
  const h = setup();
  await h.run({}, [
    new h.RequestTurn('unrelated secret', 'other'),
    new h.RequestTurn('device-a', h.exports.CHAT_ID),
  ]);
  const data = JSON.stringify(h.modelRequests[0].messages);
  assert.ok(!data.includes('unrelated secret'));
  assert.ok(data.includes('device-a'));
});
test('empty requests show a natural-language hint without network or model calls', async () => {
  const h = setup();
  h.deps.ensureSignedIn = async () => {
    throw new Error('empty request must not authenticate');
  };
  await h.run({ prompt: '   ' });
  assert.match(h.text.join(''), /List my authorized devices/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.modelRequests.length, 0);
});

const fullAccess = (overrides = {}) => ({
  permissions: 'full-access',
  ...overrides,
});
function assertClean(h) {
  assert.equal(h.listeners.size, 0, 'parent cancellation listeners');
  assert.equal(h.configurationListeners.size, 0, 'configuration listeners');
  assert.equal(h.timers.size, 0, 'request and run timers');
  for (const source of h.sources) {
    assert.equal(source.listeners.size, 0, 'child cancellation listeners');
  }
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settles(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('run did not stop promptly')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function assertCompleteExchanges(messages) {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const ids = message.content.filter((part) => part.name).map((part) => part.callId);
      if (!ids.length) {
        continue;
      }
      assert.equal(messages[index + 1]?.role, 'user');
      assert.deepEqual(
        messages[index + 1].content.map((part) => part.callId),
        ids,
      );
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      assert.equal(messages[index - 1]?.role, 'assistant', 'no orphan tool results');
    }
  }
}

test('Full access completes 35 iterations without confirmation prompts', async () => {
  const options = { config: fullAccess() };
  const h = setup(options);
  options.responses = Array.from({ length: 35 }, (_, i) => [
    new h.Call(`c${i}`, 'start_process', { device_id: 'device', command: `echo ${i}` }),
  ]);
  options.responses.push([new h.Text('Acceptance checks passed')]);
  await h.run({ prompt: 'Keep repairing until all acceptance checks pass' });
  assert.equal(h.modelRequests.length, 36);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 35);
  assert.equal(h.confirmations.length, 0);
  for (const request of h.modelRequests) {
    assert.equal(
      request.cancellation,
      h.sources[0].token,
      'selected model receives run cancellation',
    );
    assert.ok(
      request.messages.some(
        (message) => message.content === 'Keep repairing until all acceptance checks pass',
      ),
    );
    assert.ok(request.messages.length <= 35, 'retained context stays bounded');
    assertCompleteExchanges(request.messages);
  }
  const finalContext = JSON.stringify(h.modelRequests.at(-1).messages);
  assert.match(finalContext, /Historical tool data/);
  assert.match(finalContext, /untrusted data/);
  assert.equal(h.text.at(-1), 'Acceptance checks passed');
  assert.match(h.logs.at(-1), /reason=completed turns=36 calls=35/);
  assert.ok(h.logs.some((line) => line.includes('context compacted=')));
  assertClean(h);
});

test('Full access permits advertised device and global tools without maintaining allowlists', async () => {
  const options = {
    config: fullAccess(),
    tools: [
      'write_file',
      'prepare_operation',
      {
        name: 'activate_account',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
  const h = setup(options);
  options.responses = [
    [
      new h.Call('a', 'prepare_operation', { device_id: 'first-device' }),
      new h.Call('b', 'write_file', { device_id: 'second-device', path: 'x', content: 'ok' }),
      new h.Call('c', 'activate_account', {}),
    ],
  ];
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 3);
  assert.equal(h.confirmations.length, 0);
  assertClean(h);
});

test('Read only exposes inspection and recovery tools and never prompts for them', async () => {
  const tools = [
    'list_devices',
    'device_info',
    'read_file',
    'get_call_status',
    'list_calls',
    'get_operation_status',
    'list_operations',
  ];
  const options = {
    config: { permissions: 'read-only' },
    tools: [...tools, 'write_file', 'start_process', 'prepare_operation'],
  };
  const h = setup(options);
  options.responses = tools.map((name, i) => [new h.Call(`r${i}`, name, { device_id: 'device' })]);
  await h.run();
  assert.deepEqual(
    Array.from(h.modelRequests[0].requestOptions.tools, (tool) => tool.name),
    tools,
  );
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, tools.length);
  assert.equal(h.confirmations.length, 0);
  assertClean(h);
});

test('Read only blocks side effects even when a model requests a tool it was not offered', async () => {
  for (const name of [
    'start_process',
    'write_file',
    'prepare_operation',
    'activate_account',
    'unknown_tool',
  ]) {
    const options = { config: { permissions: 'read-only' }, tools: [name] };
    const h = setup(options);
    options.responses = [[new h.Call('a', name, { device_id: 'device' })]];
    await h.run();
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
    assert.equal(h.confirmations.length, 0);
    assert.match(h.text.join(''), /Read only permissions/);
    assertClean(h);
  }
});

test('Run Once approves only the displayed call', async () => {
  const options = { confirm: 'Run Once' };
  const h = setup(options);
  options.responses = [
    [
      new h.Call('a', 'start_process', { device_id: 'device', command: 'first' }),
      new h.Call('b', 'start_process', { device_id: 'device', command: 'second' }),
    ],
  ];
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 2);
  assert.equal(h.confirmations.length, 2);
  assertClean(h);
});

test('choosing Full access in the approval picker saves permissions and continues this and later requests', async () => {
  for (const deferConfigurationEvent of [false, true]) {
    const options = {
      confirm: 'Approval Options…',
      pickPermission: 'full-access',
      deferConfigurationEvent,
    };
    const h = setup(options);
    options.responses = [
      [new h.Call('a', 'start_process', { device_id: 'device' })],
      [new h.Call('b', 'start_process', { device_id: 'device' })],
      [new h.Text('done')],
      [new h.Call('c', 'start_process', { device_id: 'device' })],
    ];
    options.onFetch = (body) => {
      if (body.method === 'tools/call' && deferConfigurationEvent) {
        h.changeConfiguration();
      }
    };
    await h.run();
    await h.run();
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 3);
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.permissionPickers.length, 1);
    assert.deepEqual(h.settingsUpdates, [{ key: 'permissions', value: 'full-access', target: 1 }]);
    assertClean(h);
  }
});

test('choosing Read only persists it and blocks the pending change', async () => {
  const options = { confirm: 'Approval Options…', pickPermission: 'read-only' };
  const h = setup(options);
  options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
  await h.run();
  assert.equal(options.config.permissions, 'read-only');
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assert.match(h.text.join(''), /Operation canceled/);
  assertClean(h);
});

test('Ask for approval in the picker runs once without granting future calls', async () => {
  const options = { confirm: 'Approval Options…', pickPermission: 'ask' };
  const h = setup(options);
  options.responses = [
    [
      new h.Call('a', 'start_process', { device_id: 'device' }),
      new h.Call('b', 'start_process', { device_id: 'device' }),
    ],
  ];
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 2);
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.permissionPickers.length, 2);
  assert.equal(h.settingsUpdates.length, 0);
  assertClean(h);
});

test('canceling the options list or failing to save Full access sends no operation', async () => {
  for (const extra of [
    {},
    { pickPermission: 'full-access', updateError: true },
    { pickPermission: 'full-access', trusted: false },
  ]) {
    const options = { confirm: 'Approval Options…', ...extra };
    const h = setup(options);
    options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
    await h.run();
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
    assert.equal(h.settingsUpdates.length, 0);
    if (extra.updateError) {
      assert.match(h.text.join(''), /Could not save/);
    }
    assertClean(h);
  }
});

test('a concurrent permission reduction while saving a mode prevents dispatch', async () => {
  const options = { confirm: 'Approval Options…', pickPermission: 'full-access' };
  const h = setup(options);
  options.afterUpdate = () => {
    options.config.permissions = 'read-only';
    h.changeConfiguration();
  };
  options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assert.match(h.text.join(''), /settings changed/);
  assertClean(h);
});

test('approval prompts, future permission choices and settings guidance follow the VS Code language', async () => {
  for (const [language, optionsLabel, runLabel, fullLabel] of [
    ['en', 'Approval Options…', 'Run Once', 'Full access'],
    ['zh-cn', '选择后续审批方式…', '仅运行一次', '完全访问'],
    ['zh-tw', '選擇後續核准方式…', '僅執行一次', '完整存取'],
  ]) {
    const options = { language, confirm: optionsLabel, pickPermission: 'full-access' };
    const h = setup(options);
    options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
    await h.run();
    assert.deepEqual(Array.from(h.confirmations[0].slice(2)), [runLabel, optionsLabel]);
    assert.match(h.confirmations[0][1].detail, /Settings/);
    assert.match(h.confirmations[0][1].detail, /remoteDeviceHub\.chat\.permissions/);
    assert.equal(
      h.permissionPickers[0].items.find((item) => item.value === 'full-access').label,
      fullLabel,
    );
    assert.equal(h.permissionPickers[0].cancellation, h.sources[0].token);
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
    if (language !== 'en') {
      assert.match(h.confirmations[0][0], /允许|允許/);
    }
    assertClean(h);
  }
});

test('a task grant covers subsequent operations on that device and asks again for another device', async () => {
  let prompts = 0;
  const options = {
    tools: ['prepare_operation', 'start_process', 'write_file'],
    pickPermission: 'device-task',
    onConfirm: () => (++prompts === 1 ? 'Approval Options…' : undefined),
  };
  const h = setup(options);
  options.responses = [
    [new h.Call('a', 'prepare_operation', { device_id: 'first' })],
    [
      new h.Call('b', 'start_process', { device_id: 'first' }),
      new h.Call('c', 'write_file', { device_id: 'first' }),
    ],
    [new h.Call('d', 'start_process', { device_id: 'second' })],
  ];
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 3);
  assert.equal(h.confirmations.length, 2);
  assert.match(h.permissionPickers[0].items[0].description, /first until this request ends/);
  assert.match(h.confirmations[1][1].detail, /second/);
  assertClean(h);
});

test('task grants expire when the request ends', async () => {
  let prompts = 0;
  const options = {
    pickPermission: 'device-task',
    onConfirm: () => (++prompts === 1 ? 'Approval Options…' : undefined),
  };
  const h = setup(options);
  options.responses = [
    [new h.Call('first', 'start_process', { device_id: 'device' })],
    [new h.Text('done')],
    [new h.Call('second', 'start_process', { device_id: 'device' })],
  ];
  await h.run();
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
  assert.equal(h.confirmations.length, 2);
  assertClean(h);
});

test('overlapping requests do not share a task device grant', async () => {
  const dispatched = deferred();
  const response = deferred();
  let prompts = 0;
  const options = {
    pickPermission: 'device-task',
    onConfirm: () => (++prompts === 1 ? 'Approval Options…' : undefined),
    onFetch(body) {
      if (body.method === 'tools/call') {
        dispatched.resolve();
        return response.promise.then(() =>
          Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [] },
          }),
        );
      }
    },
  };
  const h = setup(options);
  options.responses = [
    [new h.Call('first', 'start_process', { device_id: 'device' })],
    [new h.Call('second', 'start_process', { device_id: 'device' })],
    [new h.Text('done')],
  ];
  const first = h.run();
  await dispatched.promise;
  await h.run();
  response.resolve();
  await first;
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
  assertClean(h);
});

test('a task device grant cannot authorize a global operation with a fabricated device argument', async () => {
  const options = {
    confirm: 'Approval Options…',
    pickPermission: 'device-task',
    tools: [
      'start_process',
      {
        name: 'activate_account',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
  const h = setup(options);
  options.responses = [
    [
      new h.Call('a', 'start_process', { device_id: 'device' }),
      new h.Call('b', 'activate_account', { device_id: 'device' }),
    ],
  ];
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
  assert.equal(h.confirmations.length, 2);
  assert.ok(h.permissionPickers[1].items.every((item) => item.value !== 'device-task'));
  assertClean(h);
});

test('untrusted workspaces and ambiguous device schemas offer only single-call approval', async () => {
  for (const extra of [
    { trusted: false },
    {
      tools: [
        {
          name: 'start_process',
          inputSchema: { type: 'object', properties: { device_id: { type: 'string' } } },
        },
      ],
    },
    {
      tools: [
        {
          name: 'start_process',
          inputSchema: {
            type: 'object',
            properties: { device_id: { type: 'number' } },
            required: ['device_id'],
          },
        },
      ],
    },
  ]) {
    const options = { confirm: 'Approval Options…', pickPermission: 'device-task', ...extra };
    const h = setup(options);
    options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
    await h.run();
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
    assert.ok(h.permissionPickers[0].items.every((item) => item.value !== 'device-task'));
    assertClean(h);
  }
});

test('workspace settings cannot grant Full access or disable the user time limit', async () => {
  const options = {
    workspaceConfig: fullAccess({ maxDurationMinutes: 0 }),
    config: { maxDurationMinutes: 1 },
    manualTimers: true,
    confirm: 'Run Once',
  };
  const h = setup(options);
  options.onConfirm = () => {
    assert.ok([...h.timers.values()].some((timer) => timer.ms === 60_000));
    return 'Run Once';
  };
  options.responses = [
    [
      new h.Call('a', 'start_process', { device_id: 'device' }),
      new h.Call('b', 'start_process', { device_id: 'device' }),
    ],
  ];
  await h.run();
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 2);
  const properties = require('../package.json').contributes.configuration.properties;
  assert.deepEqual(Object.keys(properties), [
    'remoteDeviceHub.chat.permissions',
    'remoteDeviceHub.chat.maxDurationMinutes',
  ]);
  for (const property of Object.values(properties)) {
    assert.equal(property.scope, 'machine');
  }
  assertClean(h);
});

test('obsolete automatic settings do not implicitly enable Full access', async () => {
  const options = {
    config: {
      executionMode: 'automatic',
      automaticDevices: ['device'],
      automaticTools: ['start_process'],
    },
  };
  const h = setup(options);
  options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
  await h.run();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assertClean(h);
});

test('Full access fails closed for untrusted workspaces and invalid settings', async () => {
  for (const options of [
    { config: fullAccess(), trusted: false },
    { config: { permissions: 'typo' } },
    ...[-1, 1.5, 1441, Infinity, '60'].map((value) => ({ config: { maxDurationMinutes: value } })),
  ]) {
    const h = setup(options);
    await h.run();
    assert.match(h.text.join(''), /Stopped:/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.modelRequests.length, 0);
    assertClean(h);
  }
});

test('cancellation interrupts an uncooperative model and ignores its late tool response', async () => {
  const entered = deferred();
  const late = deferred();
  const options = {
    config: fullAccess(),
    sendRequest() {
      entered.resolve();
      return late.promise;
    },
  };
  const h = setup(options);
  const running = h.run();
  await entered.promise;
  h.cancel();
  await settles(running);
  late.resolve({
    stream: (async function* () {
      yield new h.Call('late', 'start_process', { device_id: 'device' });
    })(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assertClean(h);
});

test('cancellation interrupts a stalled model stream and releases run resources', async () => {
  const entered = deferred();
  const options = {
    sendRequest: async () => ({
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              entered.resolve();
              return new Promise(() => {});
            },
            return() {
              return new Promise(() => {});
            },
          };
        },
      },
    }),
  };
  const h = setup(options);
  const running = h.run();
  await entered.promise;
  h.cancel();
  await settles(running);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assertClean(h);
});

test('cancellation stops waiting for confirmation without dispatching a late approval', async () => {
  const entered = deferred();
  const late = deferred();
  const options = {
    onConfirm() {
      entered.resolve();
      return late.promise;
    },
  };
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'start_process', { device_id: 'device' })]];
  const running = h.run();
  await entered.promise;
  h.cancel();
  await settles(running);
  late.resolve('Approval Options…');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assertClean(h);
});

test('cancellation dismisses the permission picker and ignores its late Full access choice', async () => {
  const entered = deferred();
  const late = deferred();
  const options = {
    confirm: 'Approval Options…',
    onQuickPick(items) {
      entered.resolve(items.find((item) => item.value === 'full-access'));
      return late.promise;
    },
  };
  const h = setup(options);
  options.responses = [[new h.Call('a', 'start_process', { device_id: 'device' })]];
  const running = h.run();
  const decision = await entered.promise;
  h.cancel();
  await settles(running);
  late.resolve(decision);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.permissionPickers[0].cancellation.isCancellationRequested, true);
  assert.equal(h.settingsUpdates.length, 0);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assertClean(h);
});

test('deadline and configuration changes stop a pending model instead of waiting for interaction', async () => {
  for (const stop of ['deadline', 'configuration']) {
    const entered = deferred();
    const options = {
      config: fullAccess({ maxDurationMinutes: 1 }),
      manualTimers: true,
      sendRequest() {
        entered.resolve();
        return new Promise(() => {});
      },
    };
    const h = setup(options);
    const running = h.run();
    await entered.promise;
    if (stop === 'deadline') {
      h.fireTimers();
    } else {
      options.config.permissions = 'read-only';
      h.changeConfiguration();
    }
    await settles(running);
    assert.match(h.text.join(''), stop === 'deadline' ? /time budget/ : /settings changed/);
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
    assertClean(h);
  }
});

test('changing permissions through the picker cancels a pending run before its late tool call', async () => {
  const entered = deferred();
  const late = deferred();
  const options = {
    config: fullAccess(),
    pickPermission: 'read-only',
    sendRequest() {
      entered.resolve();
      return late.promise;
    },
  };
  const h = setup(options);
  h.exports.registerChat({ subscriptions: [] }, h.deps);
  const running = h.run();
  await entered.promise;
  await h.commands.get('rdh.setChatPermissions')();
  await settles(running);
  late.resolve({
    stream: (async function* () {
      yield new h.Call('late', 'start_process', { device_id: 'device' });
    })(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.text.join(''), /settings changed/);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assertClean(h);
});

test('deadline is checked again before a model tool call can be dispatched', async () => {
  const options = { config: fullAccess({ maxDurationMinutes: 1 }), now: 1000 };
  const h = setup(options);
  options.sendRequest = async () => {
    options.now += 60_001;
    return {
      stream: (async function* () {
        yield new h.Call('late', 'start_process', { device_id: 'device' });
      })(),
    };
  };
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
  assert.match(h.text.join(''), /time budget/);
  assertClean(h);
});

test('cancellation aborts an in-flight RPC, never retries it, and stops the loop', async () => {
  const entered = deferred();
  let signal;
  const options = {
    config: fullAccess(),
    onFetch(body, init) {
      if (body.method !== 'tools/call') {
        return;
      }
      signal = init.signal;
      entered.resolve();
      return new Promise(() => {});
    },
  };
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'start_process', { device_id: 'device' })]];
  const running = h.run();
  await entered.promise;
  h.cancel();
  await settles(running);
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
  assert.equal(h.modelRequests.length, 1);
  assertClean(h);
});

test('cancellation while retrieving credentials prevents a late HTTP dispatch', async () => {
  const entered = deferred();
  const late = deferred();
  const h = setup();
  h.deps.accessToken = () => {
    entered.resolve();
    return late.promise;
  };
  const running = h.run();
  await entered.promise;
  h.cancel();
  await settles(running);
  late.resolve('late-secret');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
  assertClean(h);
});

test('an RPC deadline stops waiting for uncooperative headers or body without replay', async () => {
  for (const phase of ['headers', 'body']) {
    const entered = deferred();
    const late = deferred();
    let signal;
    const options = {
      manualTimers: true,
      config: fullAccess(),
      onFetch(body, init) {
        if (body.method !== 'tools/call') {
          return;
        }
        signal = init.signal;
        if (phase === 'headers') {
          entered.resolve();
          return late.promise;
        }
        return new Response(
          new ReadableStream({
            async pull(stream) {
              entered.resolve();
              await late.promise;
              stream.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    };
    const h = setup(options);
    const operationId = 'a'.repeat(32);
    options.responses = [
      [new h.Call('c1', 'start_process', { device_id: 'device', operation_id: operationId })],
    ];
    const running = h.run();
    await entered.promise;
    const deadline = [...h.timers.values()].find((timer) => timer.ms === 60_000);
    assert.ok(deadline);
    deadline.fn();
    await settles(running);
    assert.equal(signal.aborted, true);
    assert.match(h.text.join(''), /tools\/call timed out.*check its status/);
    assert.ok(h.logs.some((line) => line.includes(`outcome=unconfirmed operation=${operationId}`)));
    late.resolve(Response.json({ jsonrpc: '2.0', result: {}, id: 4 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
    assert.equal(h.modelRequests.length, 1);
    assertClean(h);
  }
});

test('large results are explicitly partial, preserve errors, and fit model input', async () => {
  const options = {
    maxInputTokens: 4096,
    toolResult: () => ({
      isError: true,
      content: [{ type: 'text', text: 'HEAD' + 'x'.repeat(30_000) + 'TAIL' }],
    }),
  };
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'list_devices', {})]];
  await h.run();
  const result = JSON.parse(h.modelRequests[1].messages.at(-1).content[0].content[0].value);
  assert.equal(result.rdh_context_truncated, true);
  assert.equal(result.isError, true);
  assert.match(result.preview, /HEAD/);
  assert.match(result.preview, /TAIL/);
  assert.match(result.instruction, /partial tool result/);
  for (const request of h.modelRequests) {
    let size = await h.model.countTokens(JSON.stringify(request.requestOptions.tools));
    for (const message of request.messages) {
      size += await h.model.countTokens(message);
    }
    assert.ok(size <= Math.floor(h.model.maxInputTokens * 0.85));
  }
  assertClean(h);
});

test('token-driven compaction preserves the original task and complete recent exchanges', async () => {
  const options = {
    maxInputTokens: 2200,
    tools: ['read_process'],
    toolResult: () => ({
      content: [{ type: 'text', text: 'job-id-123: ' + 'output '.repeat(200) }],
    }),
  };
  const h = setup(options);
  options.responses = Array.from({ length: 10 }, (_, i) => [
    new h.Call(`c${i}`, 'read_process', { device_id: 'device', job_id: 'job-id-123' }),
  ]);
  const task = 'Preserve this acceptance criterion';
  await h.run({ prompt: task }, [new h.RequestTurn('Old context '.repeat(500), h.exports.CHAT_ID)]);
  assert.equal(h.modelRequests.length, 11);
  assert.match(JSON.stringify(h.modelRequests.at(-1).messages), /Historical tool data/);
  for (const request of h.modelRequests) {
    assert.ok(request.messages.some((message) => message.content === task));
    assertCompleteExchanges(request.messages);
    if (request !== h.modelRequests[0]) {
      assert.ok(
        request.messages.some(
          (message) => message.role === 'assistant' && Array.isArray(message.content),
        ),
        'retain a recent complete exchange',
      );
    }
    let tokens = await h.model.countTokens(JSON.stringify(request.requestOptions.tools));
    for (const message of request.messages) {
      tokens += await h.model.countTokens(message);
    }
    assert.ok(tokens <= Math.floor(h.model.maxInputTokens * 0.85));
  }
  assertClean(h);
});

test('an oversized task is rejected before model dispatch rather than silently deleted', async () => {
  const h = setup({ maxInputTokens: 1024 });
  const result = await h.run({ prompt: 'Essential acceptance criterion '.repeat(2000) });
  assert.match(result.errorDetails.message, /input limit/);
  assert.equal(h.modelRequests.length, 0);
  assertClean(h);
});

test('run logs contain outcomes and counts without commands, file data, or credentials', async () => {
  const options = {
    config: fullAccess(),
    toolResult: () => ({ content: [{ type: 'text', text: 'private-result' }] }),
  };
  const h = setup(options);
  options.responses = [
    [
      new h.Call('c1', 'start_process', {
        device_id: 'device',
        command: 'private-command',
        env: { SECRET: 'private-env' },
      }),
    ],
  ];
  await h.run({ prompt: 'private-task' });
  const logs = h.logs.join('\n');
  assert.match(logs, /tool=start_process device=device call=1 dispatched/);
  assert.match(logs, /outcome=ok/);
  assert.match(logs, /reason=completed turns=2 calls=1/);
  for (const secret of [
    'private-command',
    'private-env',
    'private-result',
    'private-task',
    'secret-test',
  ]) {
    assert.ok(!logs.includes(secret));
  }
  assertClean(h);
});

test('a second request does not inherit the earlier run permission snapshot', async () => {
  const options = { config: fullAccess() };
  const h = setup(options);
  options.responses = [
    [new h.Call('first', 'start_process', { device_id: 'device' })],
    [new h.Text('done')],
    [new h.Call('second', 'start_process', { device_id: 'device' })],
  ];
  await h.run();
  options.config = { permissions: 'ask' };
  await h.run();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
  assertClean(h);
});

test('token counting can be canceled before any model request is sent', async () => {
  const entered = deferred();
  const options = {
    countTokens() {
      entered.resolve();
      return new Promise(() => {});
    },
  };
  const h = setup(options);
  const running = h.run();
  await entered.promise;
  h.cancel();
  await settles(running);
  assert.equal(h.modelRequests.length, 0);
  assertClean(h);
});

test('extension disposal cancels an active request', async () => {
  const entered = deferred();
  const options = {
    sendRequest() {
      entered.resolve();
      return new Promise(() => {});
    },
  };
  const h = setup(options);
  const context = { subscriptions: [] };
  h.exports.registerChat(context, h.deps);
  const running = h.participant.handler(
    { prompt: 'Keep working', model: h.model },
    { history: [] },
    { markdown() {}, progress() {} },
    h.token,
  );
  await entered.promise;
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
  await settles(running);
  assertClean(h);
});

test('an indeterminate mutation response stops with an unconfirmed outcome and no replay', async () => {
  const options = {
    config: fullAccess(),
    onFetch(body) {
      if (body.method === 'tools/call') {
        throw new Error('connection dropped');
      }
    },
  };
  const h = setup(options);
  options.responses = [[new h.Call('c1', 'start_process', { device_id: 'device' })]];
  const result = await h.run();
  assert.match(result.errorDetails.message, /connection dropped/);
  assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 1);
  assert.equal(h.modelRequests.length, 1);
  assert.ok(h.logs.some((line) => /outcome=unconfirmed/.test(line)));
  assertClean(h);
});

for (const [label, payload] of Object.entries({
  null: null,
  array: [],
  arrayResult: { jsonrpc: '2.0', id: 1, result: [] },
  errorWithResult: { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'error' }, result: {} },
  nullError: { jsonrpc: '2.0', id: 1, error: null },
  stringErrorCode: { jsonrpc: '2.0', id: 1, error: { code: '-1', message: 'error' } },
  objectErrorMessage: { jsonrpc: '2.0', id: 1, error: { code: -1, message: {} } },
})) {
  test(`malformed RPC envelope (${label}) stops before model use without retry`, async () => {
    const h = setup({ onFetch: async () => Response.json(payload) });
    const result = await h.run();
    assert.ok(result.errorDetails.message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.modelRequests.length, 0);
    assertClean(h);
  });
}

for (const [label, tool] of Object.entries({
  emptyName: { name: '', inputSchema: { type: 'object' } },
  numericDescription: { name: 'read_file', description: 7, inputSchema: { type: 'object' } },
  arraySchema: { name: 'read_file', inputSchema: [] },
  nonObjectSchema: { name: 'read_file', inputSchema: { type: 'string' } },
  arrayProperties: { name: 'read_file', inputSchema: { type: 'object', properties: [] } },
  numericPropertySchema: {
    name: 'read_file',
    inputSchema: { type: 'object', properties: { device_id: 1 } },
  },
  numericRequired: { name: 'read_file', inputSchema: { type: 'object', required: [3] } },
})) {
  test(`malformed tool definition (${label}) never reaches the model`, async () => {
    const h = setup({ tools: [tool] });
    const result = await h.run();
    assert.match(result.errorDetails.message, /tool definition is malformed/);
    assert.equal(h.modelRequests.length, 0);
    assert.equal(h.calls.filter((call) => call.method === 'tools/call').length, 0);
    assertClean(h);
  });
}

test('false pagination cursor is rejected instead of silently truncating tools', async () => {
  const h = setup({
    onFetch: async (body) =>
      body.method === 'tools/list'
        ? Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: false } })
        : undefined,
  });
  const result = await h.run();
  assert.match(result.errorDetails.message, /pagination cursor is invalid/);
  assert.equal(h.modelRequests.length, 0);
  assertClean(h);
});

test('valid RPC errors retain the server code and message', async () => {
  const h = setup({
    onFetch: async (body) =>
      Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Method not found', data: { reason: 'unsupported' } },
      }),
  });
  const result = await h.run();
  assert.match(result.errorDetails.message, /MCP error -32601: Method not found/);
  assert.equal(h.calls.length, 1);
  assertClean(h);
});
