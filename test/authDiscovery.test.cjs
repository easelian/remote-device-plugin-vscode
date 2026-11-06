const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverAuth } = require('../out/authDiscovery');
const { resolveDeployment } = require('../out/authConfig');

const deployment = resolveDeployment({ mcpPublicUrl: 'https://mcp.example' });
const issuer = 'https://auth.example/';
const resource = {
  resource: deployment.resource,
  authorization_servers: [issuer],
  scopes_supported: ['devices:control'],
};
const auth = {
  issuer,
  authorization_endpoint: 'https://auth.example/authorize',
  registration_endpoint: 'https://auth.example/register',
  token_endpoint: 'https://auth.example/token',
  rdh_refresh_endpoint: 'https://auth.example/token/refresh',
  revocation_endpoint: 'https://auth.example/revoke',
  scopes_supported: ['devices:control'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true,
};

test('discovers and validates a separate authorization server without credentials', async (t) => {
  const oldFetch = global.fetch;
  const calls = [];
  t.after(() => {
    global.fetch = oldFetch;
  });
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? resource : auth);
  };
  const endpoints = await discoverAuth(deployment);
  assert.deepEqual(endpoints, {
    issuer,
    authorizationUri: 'https://auth.example/authorize',
    registrationUri: 'https://auth.example/register',
    tokenUri: 'https://auth.example/token',
    refreshUri: 'https://auth.example/token/refresh',
    revokeUri: 'https://auth.example/revoke',
    responseIssuerRequired: true,
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://mcp.example/.well-known/oauth-protected-resource/mcp',
      'https://auth.example/.well-known/oauth-authorization-server',
    ],
  );
  assert.ok(calls.every(({ init }) => init.redirect === 'error' && !init.headers.Authorization));
});

test('rejects inconsistent or unsafe discovery metadata before credential requests', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => {
    global.fetch = oldFetch;
  });
  const cases = [
    [{ ...resource, resource: 'https://other.example/mcp' }, auth],
    [{ ...resource, authorization_servers: [] }, auth],
    [{ ...resource, authorization_servers: [issuer, 'https://other.example/'] }, auth],
    [{ ...resource, authorization_servers: ['http://auth.example/'] }, auth],
    [{ ...resource, authorization_servers: ['https://auth.example'] }, auth],
    [{ ...resource, authorization_servers: ['https://user:pass@auth.example/'] }, auth],
    [resource, { ...auth, issuer: 'https://other.example/' }],
    [resource, { ...auth, token_endpoint: 'https://other.example/token' }],
    [resource, { ...auth, authorization_endpoint: 'https://auth.example/authorize?next=x' }],
    [resource, { ...auth, code_challenge_methods_supported: ['plain'] }],
    [resource, { ...auth, token_endpoint_auth_methods_supported: ['client_secret_basic'] }],
    [resource, { ...auth, scopes_supported: ['wrong'] }],
  ];
  for (const [r, a] of cases) {
    let count = 0;
    global.fetch = async () => Response.json(++count === 1 ? r : a);
    await assert.rejects(discoverAuth(deployment));
    assert.ok(count <= 2);
  }
});

test('rejects oversized discovery documents', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => {
    global.fetch = oldFetch;
  });
  global.fetch = async () => Response.json({ ...resource, padding: 'x'.repeat(65536) });
  await assert.rejects(discoverAuth(deployment), /too large/);
});

test('allows a distinct loopback issuer for an isolated development server', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => {
    global.fetch = oldFetch;
  });
  const loopbackIssuer = 'http://127.0.0.2:18888/';
  let count = 0;
  global.fetch = async () =>
    Response.json(
      ++count === 1
        ? { ...resource, authorization_servers: [loopbackIssuer] }
        : {
            issuer: loopbackIssuer,
            authorization_endpoint: `${loopbackIssuer}authorize`,
            registration_endpoint: `${loopbackIssuer}register`,
            token_endpoint: `${loopbackIssuer}token`,
          },
    );
  assert.equal((await discoverAuth(deployment)).issuer, loopbackIssuer);
});
