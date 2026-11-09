// Disposable browser simulation for the local split-Auth integration test.
const fs = require('node:fs');
const { harness, until } = require('./authHarness.cjs');

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const cleanups = [];
  const cookies = new Map(input.cookies.map(([name, value]) => [name, value]));
  const issuer = `${new URL(input.authServer).origin}/`;
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const capture = (response) => {
    for (const value of response.headers.getSetCookie()) {
      const first = value.split(';', 1)[0];
      const index = first.indexOf('=');
      if (index > 0) {
        cookies.set(first.slice(0, index), first.slice(index + 1));
      }
    }
  };
  const browserFlow = async (authorizationUrl) => {
    const response = await fetch(authorizationUrl, {
      redirect: 'manual',
      headers: { cookie: cookieHeader() },
    });
    capture(response);
    const location = response.headers.get('location');
    if (![302, 303].includes(response.status) || !location) {
      throw new Error(`authorization did not start (HTTP ${response.status})`);
    }
    const consent = new URL(location, issuer);
    if (consent.origin !== new URL(issuer).origin) {
      throw new Error('unexpected consent origin');
    }
    const page = await fetch(consent, { headers: { cookie: cookieHeader() } });
    capture(page);
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    const tx = consent.searchParams.get('tx');
    if (!page.ok || !csrf || !tx) {
      throw new Error('consent page is incomplete');
    }
    const approved = await fetch(new URL('/auth/oauth', issuer), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookieHeader(),
        origin: new URL(issuer).origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ tx, csrf }).toString(),
    });
    const callback = approved.headers.get('location');
    if (![302, 303].includes(approved.status) || !callback) {
      throw new Error(`consent was not accepted (HTTP ${approved.status})`);
    }
    const expected = new URL(authorizationUrl.searchParams.get('redirect_uri'));
    const target = new URL(callback);
    if (target.origin !== expected.origin || target.pathname !== expected.pathname) {
      throw new Error('unexpected callback');
    }
    const result = await fetch(target);
    if (!result.ok) {
      throw new Error('callback failed');
    }
    await result.text();
  };
  const h = harness(
    {
      after(fn) {
        cleanups.push(fn);
      },
    },
    {
      deployment: { mcpPublicUrl: input.server },
      issuer,
      realDiscovery: true,
      browserFlow,
      transport: (uri, init) => fetch(uri, init),
    },
  );
  try {
    try {
      await until(() => h.token);
    } catch (error) {
      const logs = h.logs.map((line) => line.replace(/https?:\/\/\S+/g, '[url]'));
      throw new Error(`${error.message}: ${JSON.stringify(logs)}`);
    }
    const token = h.token;
    const ready = Boolean(await h.provider.resolveMcpServerDefinition());
    await h.commands.get('rdh.signOut')();
    const response = await fetch(new URL('/token', issuer), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: token.client_id,
        refresh_token: token.refresh_token,
        resource: `${input.server}/mcp`,
      }).toString(),
    });
    const body = await response.json();
    process.stdout.write(
      JSON.stringify({
        ready,
        issuerMatched: token._issuer === issuer,
        signedOut: !h.token,
        revoked: response.status === 400 && body.error === 'invalid_grant',
        metadataReads: h.discoveryRequests.length,
      }),
    );
  } finally {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }
}

main().catch((error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
