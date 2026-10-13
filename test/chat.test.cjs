const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(options = {}) {
  const calls = [], text = [], confirmations = [], modelRequests = [];
  const listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; } };
  const cancel = () => { token.isCancellationRequested = true; for (const fn of listeners) fn(); };
  class Text { constructor(value) { this.value = value; } }
  class Call { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class Result { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class RequestTurn { constructor(prompt, participant) { Object.assign(this, { prompt, participant }); } }
  class ResponseTurn {}
  class Markdown {}
  let participant;
  const vscode = {
    CancellationError: class extends Error {}, LanguageModelTextPart: Text, LanguageModelToolCallPart: Call,
    LanguageModelToolResultPart: Result, ChatRequestTurn: RequestTurn, ChatResponseTurn: ResponseTurn,
    ChatResponseMarkdownPart: Markdown,
    LanguageModelChatMessage: { User: content => ({ role: 'user', content }), Assistant: content => ({ role: 'assistant', content }) },
    ThemeIcon: class {}, chat: { createChatParticipant(id, handler) { participant = { id, handler, dispose() {} }; return participant; } },
    window: { async showWarningMessage(...args) { confirmations.push(args); if (options.cancelOnConfirm) cancel(); return options.confirm; } },
  };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../out/chat.js'), 'utf8'), {
    exports, require: name => { assert.equal(name, 'vscode'); return vscode; },
    Buffer, AbortController, setTimeout, clearTimeout,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push({ ...body, headers: init.headers });
      if (options.httpStatus) return new Response('', { status: options.httpStatus });
      if (options.cancelOnFetch) { cancel(); throw new Error('aborted'); }
      let result;
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26' };
      else if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      else if (body.method === 'tools/list') result = { tools: (options.tools || ['list_devices', 'start_process']).map(name => ({ name, description: name, inputSchema: { type: 'object' } })) };
      else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: 'device-result' }], isError: !!options.toolError };
      else throw new Error('unknown method');
      return Response.json({ jsonrpc: '2.0', id: options.badId ? 900 : body.id, result });
    },
  });
  const deps = { endpoint: 'https://hub.test/mcp', ensureSignedIn: async () => options.signedIn !== false, accessToken: async () => 'secret-test' };
  let round = 0;
  const model = { async sendRequest(messages, requestOptions, cancellation) {
    modelRequests.push({ messages: structuredClone(messages), requestOptions, cancellation });
    const parts = options.responses?.[round++] || [new Text('Done')];
    return { stream: (async function* () { yield* parts; })() };
  } };
  const stream = { markdown: value => text.push(value), progress() {} };
  return { exports, deps, calls, text, confirmations, modelRequests, token, listeners, Call, Text, RequestTurn,
    get participant() { return participant; },
    async run(extra = {}, history = []) { return exports.createChatHandler(deps)({ prompt: 'List devices', model, ...extra }, { history }, stream, token); },
  };
}
test('manifest and participant register the same @ entry', () => {
  const h = setup(), context = { subscriptions: [] };
  h.exports.registerChat(context, h.deps);
  const m = require('../package.json');
  assert.equal(m.contributes.chatParticipants[0].id, h.participant.id);
  assert.equal(m.contributes.chatParticipants[0].name, 'remote-device-hub');
  assert.equal(m.contributes.chatParticipants.length, 1);
  assert.equal(m.contributes.chatParticipants[0].commands, undefined);
  assert.equal(h.participant.followupProvider, undefined);
  assert.equal(context.subscriptions[0], h.participant);
});
test('natural language performs tool loop using the selected model and returns results', async () => {
  const options = {}; const h = setup(options);
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
  const options = {}; const h = setup(options);
  options.responses = [[new h.Call('c1', 'start_process', { device_id: 'device', command: 'echo test' })]];
  await h.run();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0][1].detail, /device/);
  assert.equal(h.calls.filter(c => c.method === 'tools/call').length, 0);
});
test('confirmed shell call is dispatched once and cancellation before dispatch prevents it', async () => {
  for (const cancelled of [false, true]) {
    const options = { confirm: 'Run', cancelOnConfirm: cancelled }; const h = setup(options);
    options.responses = [[new h.Call('c1', 'start_process', { device_id: 'device', command: 'echo test' })]];
    await h.run();
    assert.equal(h.calls.filter(c => c.method === 'tools/call').length, cancelled ? 0 : 1);
  }
});
test('unadvertised tool is rejected before invocation', async () => {
  const options = {}; const h = setup(options);
  options.responses = [[new h.Call('c1', 'local_shell', {})]];
  const result = await h.run();
  assert.match(result.errorDetails.message, /tool that was not provided/);
  assert.equal(h.calls.filter(c => c.method === 'tools/call').length, 0);
});
test('cancelled sign-in does not send MCP or model requests', async () => {
  const h = setup({ signedIn: false }); await h.run();
  assert.equal(h.calls.length, 0); assert.equal(h.modelRequests.length, 0);
});
test('HTTP rejection and malformed RPC response surface errors without replay', async () => {
  for (const options of [{ httpStatus: 401 }, { badId: true }]) {
    const h = setup(options); const result = await h.run();
    assert.ok(result.errorDetails.message); assert.equal(h.calls.length, 1);
    assert.equal(h.listeners.size, 0);
  }
});
test('tool errors stay marked as errors in model results', async () => {
  const options = { toolError: true }; const h = setup(options);
  options.responses = [[new h.Call('c1', 'list_devices', {})], [new h.Text('Query failed')]];
  await h.run();
  assert.equal(JSON.parse(h.modelRequests[1].messages.at(-1).content[0].content[0].value).isError, true);
});
test('history from other participants is excluded', async () => {
  const h = setup();
  await h.run({}, [new h.RequestTurn('unrelated secret', 'other'), new h.RequestTurn('device-a', h.exports.CHAT_ID)]);
  const data = JSON.stringify(h.modelRequests[0].messages);
  assert.ok(!data.includes('unrelated secret')); assert.ok(data.includes('device-a'));
});
test('empty requests show a natural-language hint without network or model calls', async () => {
  const h = setup();
  h.deps.ensureSignedIn = async () => { throw new Error('empty request must not authenticate'); };
  await h.run({ prompt: '   ' });
  assert.match(h.text.join(''), /List my authorized devices/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.modelRequests.length, 0);
});
