const assert = require('node:assert/strict');

// The published definition points at this window's loopback proxy and carries
// only the proxy's own key, never an OAuth token.
function assertBridge(definition, h, expectedToken) {
  assert.ok(definition);
  assert.equal(definition.command, undefined);
  assert.match(String(definition.uri), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.deepEqual(Object.keys(definition.headers), ['Authorization']);
  assert.match(definition.headers.Authorization, /^Bearer rdh-local-[A-Za-z0-9_-]{43}$/);
  assert.equal(h.token.access_token, expectedToken);
  const persisted = JSON.stringify({ ...definition, uri: String(definition.uri) });
  for (const key of ['access_token', 'refresh_token']) {
    assert.equal(persisted.includes(h.token[key]), false, key);
  }
}

module.exports = { assertBridge };
