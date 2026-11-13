const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { McpProxy } = require('../out/mcpProxy');
const { resolveDeployment } = require('../out/authConfig');
const { harness, freshToken } = require('./helpers/authHarness.cjs');
const { assertBridge } = require('./helpers/assertBridge.cjs');

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' },
  },
};

async function fixture(t, handler) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const message = body ? JSON.parse(body) : undefined;
    requests.push({ method: req.method, headers: req.headers, message });
    if (handler && handler(req, res, message, requests.length)) {
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(405).end();
    } else if (!message?.id) {
      res.writeHead(202).end();
    } else if (message.method === 'initialize') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'session-fixture',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: {} } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
    }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  let token = freshToken('access-sentinel-not-for-disk');
  token.refresh_token = 'refresh-sentinel-not-for-disk';
  const listeners = new Set();
  const logs = [];
  let validations = 0;
  const proxy = new McpProxy(
    {
      getToken: async () => token,
      getAcceptedToken: async () => {
        validations += 1;
        return token;
      },
      onDidChange: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    { warn: (line) => logs.push(line) },
    resolveDeployment({ mcpPublicUrl: `http://127.0.0.1:${upstream.address().port}` }),
  );
  t.after(() => proxy.dispose());
  const launch = await proxy.launch();
  const call = (message, extra = {}, init = {}) =>
    fetch(launch.uri, {
      method: 'POST',
      headers: {
        ...launch.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...extra,
      },
      body: JSON.stringify(message),
      ...init,
    });
  return {
    proxy,
    launch,
    requests,
    logs,
    call,
    get validations() {
      return validations;
    },
    async change(value) {
      token = value;
      for (const listener of listeners) {
        listener();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('both provider paths publish a loopback definition without OAuth credentials', async (t) => {
  const h = harness(t, { token: freshToken('accepted') });
  await h.startup;
  const discovered = (await h.provider.provideMcpServerDefinitions())[0];
  assertBridge(discovered, h, 'accepted');
  const resolved = await h.provider.resolveMcpServerDefinition();
  assertBridge(resolved, h, 'accepted');
  // Token renewal must not change what the editor cached.
  assert.equal(String(resolved.uri), String(discovered.uri));
  assert.deepEqual(resolved.headers, discovered.headers);
});

test('forwards JSON and SSE with the current token and never the local key', async (t) => {
  const f = await fixture(t, (req, res, message) => {
    if (message?.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\n\n');
      setTimeout(() => {
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n\n`,
        );
      }, 50);
      return true;
    }
  });
  const init = await f.call(INIT);
  assert.equal(init.status, 200);
  assert.equal(init.headers.get('mcp-session-id'), 'session-fixture');
  assert.equal((await init.json()).id, 1);
  assert.equal(f.requests[0].headers.authorization, 'Bearer access-sentinel-not-for-disk');

  await f.change({ ...freshToken('rotated-memory-only') });
  const stream = await f.call(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} },
    { 'mcp-session-id': 'session-fixture', 'mcp-protocol-version': '2025-03-26', cookie: 'a=b' },
  );
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.match(await stream.text(), /"ok":true/);
  const forwarded = f.requests[1].headers;
  assert.equal(forwarded.authorization, 'Bearer rotated-memory-only');
  assert.equal(forwarded['mcp-session-id'], 'session-fixture');
  assert.equal(forwarded['mcp-protocol-version'], '2025-03-26');
  assert.equal(forwarded.cookie, undefined);
  for (const secret of ['access-sentinel', 'refresh-sentinel', 'rotated-memory-only']) {
    assert.equal(JSON.stringify(f.launch).includes(secret), false);
    assert.equal(f.logs.join('\n').includes(secret), false);
  }
  assert.equal(JSON.stringify(f.requests).includes('rdh-local-'), false);
});

test("only this window's key, host, and a non-browser caller get through", async (t) => {
  const f = await fixture(t);
  const port = new URL(f.launch.uri).port;
  const attempts = [
    { headers: { Authorization: 'Bearer rdh-local-guess' } },
    { headers: {} },
    { headers: { ...f.launch.headers, origin: 'https://example.com' } },
    { headers: f.launch.headers, path: '/other' },
  ];
  for (const attempt of attempts) {
    const response = await fetch(`http://127.0.0.1:${port}${attempt.path ?? '/mcp'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attempt.headers },
      body: JSON.stringify(INIT),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('www-authenticate'), null);
  }
  // A rebound hostname reaches the socket with a foreign Host header.
  const rebound = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { ...f.launch.headers, host: 'evil.example' },
      },
      (response) => resolve(response.statusCode),
    );
    request.on('error', reject);
    request.end(JSON.stringify(INIT));
  });
  assert.equal(rebound, 403);
  assert.equal(f.requests.length, 0);
});

test('an upstream 401 is never replayed, never passed on as 401, and its body stays private', async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' });
    res.end('access-sentinel-not-for-disk');
    return true;
  });
  const response = await f.call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('www-authenticate'), null);
  const text = await response.text();
  assert.equal(text.includes('access-sentinel'), false);
  assert.equal(JSON.parse(text).id, 7);
  assert.equal(f.requests.length, 1);
  assert.equal(f.validations, 1);
  assert.equal(f.logs.join('\n').includes('access-sentinel'), false);
});

test('a redirect cannot carry the bearer token elsewhere', async (t) => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(307, { location: '/other' }).end();
    return true;
  });
  assert.equal((await f.call(INIT)).status, 502);
  assert.equal(f.requests.length, 1);
});

test('a failed request is answered as an error and the next one works', async (t) => {
  const f = await fixture(t, (req, res, message, count) => {
    if (count === 2) {
      req.socket.destroy();
      return true;
    }
    if (count === 3) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('upstream detail');
      return true;
    }
  });
  await f.call(INIT);
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const dropped = await f.call(list);
  assert.equal(dropped.status, 502);
  assert.equal((await dropped.json()).error.code, -32000);
  const unavailable = await f.call(list);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes('upstream detail'), false);
  const ok = await f.call(list);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).result.tools, []);
});

for (const action of ['signout', 'account-change']) {
  test(`${action} ends open streams and retires sessions of the old sign-in`, async (t) => {
    const f = await fixture(t, (req, res, message) => {
      if (message?.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        return true;
      }
    });
    await f.call(INIT);
    const open = await f.call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    const ended = open.text().then(
      () => 'ended',
      () => 'ended',
    );
    await f.change(
      action === 'signout' ? undefined : { ...freshToken(), client_id: 'other-account' },
    );
    assert.equal(await ended, 'ended');
    const before = f.requests.length;
    const stale = await f.call(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { 'mcp-session-id': 'session-fixture' },
    );
    // Signed out: nothing to send. Other account: a fresh session, not the old one.
    assert.equal(stale.status, action === 'signout' ? 503 : 200);
    assert.equal(f.requests.length, action === 'signout' ? before : before + 1);
  });
}

test('a session opened by one account is refused to another while both are known', async (t) => {
  const f = await fixture(t);
  await f.call(INIT);
  // Swap the token without the change event, as a race would.
  f.proxy.auth.getToken = async () => ({ ...freshToken(), client_id: 'other-account' });
  const response = await f.call(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { 'mcp-session-id': 'session-fixture' },
  );
  assert.equal(response.status, 404);
  assert.equal(f.requests.length, 1);
});

test('a cached definition is dead once the owning window stops', async (t) => {
  const f = await fixture(t);
  await f.call(INIT);
  f.proxy.dispose();
  await assert.rejects(f.call(INIT));
  await assert.rejects(f.proxy.launch(), /stopped/);
});
