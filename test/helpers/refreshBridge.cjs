// Invoked by the Hub's optional integration test with disposable credentials
// on stdin. Requests use the actual compiled extension and a real local Hub.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { harness, until } = require('./authHarness.cjs');

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const cleanups = [];
  let refreshRequests = 0;
  let issuedHashes;
  let revocationRequests = 0;
  const saved = input.saved
    ? JSON.parse(fs.readFileSync(input.saved, 'utf8'))
    : {
        token: input.token,
        recoveryKey: input.recoveryKey,
      };
  const h = harness(
    {
      after(fn) {
        cleanups.push(fn);
      },
    },
    {
      token: saved.token,
      recovery: true,
      recoveryKey: saved.recoveryKey,
      transport: async (uri, init) => {
        const path = new URL(uri).pathname;
        const response = await fetch(new URL(path, input.server), init);
        if (path === '/token/refresh' && response.ok && input.signOut) {
          const issued = await response.clone().json();
          issuedHashes = {
            access: crypto.createHash('sha256').update(issued.access_token).digest('hex'),
            refresh: crypto.createHash('sha256').update(issued.refresh_token).digest('hex'),
          };
        }
        if (path === '/revoke') {
          revocationRequests++;
          if (input.loseRevocationResponse) {
            await response.arrayBuffer();
            throw new DOMException(
              'injected revocation response loss after server commit',
              'TimeoutError',
            );
          }
        }
        if (path === '/token/refresh' && ++refreshRequests === 1 && input.loseResponse) {
          await response.arrayBuffer();
          throw new DOMException('injected response loss after server commit', 'TimeoutError');
        }
        return response;
      },
    },
  );
  try {
    if (input.loseResponse) {
      await until(() => h.logs.some((line) => line.includes('token refresh failed')));
    }
    if (input.exitAfterLoss) {
      fs.writeFileSync(
        input.save,
        JSON.stringify({
          token: h.token,
          recoveryKey: h.shared.extraSecrets.get('rdh.refreshKey.v1.' + h.token.client_id),
        }),
        { mode: 0o600 },
      );
      process.stdout.write(
        JSON.stringify({
          pending: h.token._refresh_state === 'pending',
          hasProof: Boolean(h.token._refresh_request_id),
          browserOpens: h.opens.length,
          refreshRequests,
        }),
      );
      return;
    }
    if (input.signOut) {
      if (!input.loseResponse) {
        await h.provider.resolveMcpServerDefinition();
      }
      await h.commands.get('rdh.signOut')();
      process.stdout.write(
        JSON.stringify({
          signedOut: !h.token,
          recoveryKeyRemoved: !h.shared.extraSecrets.has(
            'rdh.refreshKey.v1.' + saved.token.client_id,
          ),
          revocationConfirmed: h.logs.some((line) => line.includes('token revocation: HTTP 200')),
          warningShown: h.messages.some((message) =>
            message.includes('server revocation could not be confirmed'),
          ),
          browserOpens: h.opens.length,
          refreshRequests,
          revocationRequests,
          issuedHashes,
        }),
      );
      return;
    }
    const server = await h.provider.resolveMcpServerDefinition();
    process.stdout.write(
      JSON.stringify({
        ready: Boolean(server),
        browserOpens: h.opens.length,
        refreshRequests,
        accessHash: crypto.createHash('sha256').update(h.token.access_token).digest('hex'),
        recovered: h.logs.some((line) =>
          line.includes('recovered the result of an earlier refresh'),
        ),
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
