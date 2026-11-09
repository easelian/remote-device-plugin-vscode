import * as http from 'http';

interface CallbackResult {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
  errorDescription?: string | undefined;
  issuer?: string | undefined;
}

export function startCallbackServer(): Promise<{
  port: number;
  waitForCode: (
    expectedState: string,
    timeoutMs: number,
    expectedIssuer?: string,
    requireIssuer?: boolean,
  ) => Promise<CallbackResult>;
  close: () => void;
}> {
  return new Promise((resolveServer, rejectServer) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (r: CallbackResult) => void = () => {
      /* noop */
    };
    const resultPromise = new Promise<CallbackResult>((res) => {
      settle = res;
    });

    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const q = u.searchParams;
      const result: CallbackResult = {
        code: q.get('code') ?? undefined,
        state: q.get('state') ?? undefined,
        error: q.get('error') ?? undefined,
        errorDescription: q.get('error_description') ?? undefined,
        issuer: q.get('iss') ?? undefined,
      };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        result.error === 'access_denied'
          ? '<html><body><h2>Authorization cancelled</h2><p>You can close this page and return to VS Code.</p></body></html>'
          : result.error
            ? '<html><body><h2>Authorization failed</h2><p>Return to VS Code for details.</p></body></html>'
            : '<html><body><h2>Authorization received - you can close this page</h2></body></html>',
      );
      settle(result);
    });

    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectServer(new Error('no port'));
        return;
      }
      resolveServer({
        port: addr.port,
        waitForCode: (expectedState, timeoutMs, expectedIssuer, requireIssuer = false) =>
          new Promise<CallbackResult>((res) => {
            timer = setTimeout(
              () => res({ error: 'timeout', errorDescription: 'no callback received' }),
              timeoutMs,
            );
            void resultPromise.then((r) => {
              clearTimeout(timer);
              if (r.state !== expectedState) {
                res({ error: 'state_mismatch', errorDescription: 'state validation failed' });
              } else if (
                (!r.error || r.error === 'access_denied') &&
                expectedIssuer &&
                ((r.issuer !== undefined && r.issuer !== expectedIssuer) ||
                  (requireIssuer && r.issuer === undefined))
              ) {
                res({ error: 'issuer_mismatch', errorDescription: 'issuer validation failed' });
              } else {
                res(r);
              }
            });
          }),
        close: () => {
          clearTimeout(timer);
          settle({ error: 'cancelled' });
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
