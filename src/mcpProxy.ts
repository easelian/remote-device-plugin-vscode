import * as http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type * as vscode from 'vscode';
import type { AuthSession } from './authSession';
import type { TokenSet } from './boundaries';
import type { DeploymentConfig } from './authConfig';
import { SafeAuthError } from './authErrors';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 256;
const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];
const RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

function identity(token: TokenSet): string {
  return JSON.stringify([token._issuer, token.client_id]);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export interface ProxyEndpoint {
  uri: string;
  headers: Record<string, string>;
}

// The editor may persist every field in a server definition. It gets a
// loopback address and a key that only this window's proxy accepts; the OAuth
// token is added here, in memory, on the way out.
export class McpProxy implements vscode.Disposable {
  private server: http.Server | undefined;
  private endpoint: Promise<ProxyEndpoint> | undefined;
  private disposed = false;
  private readonly key = `rdh-local-${randomBytes(32).toString('base64url')}`;
  private readonly expected = digest(`Bearer ${this.key}`);
  // MCP session id -> the sign-in that opened it.
  private readonly sessions = new Map<string, string>();
  private readonly inflight = new Map<AbortController, string>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly auth: Pick<AuthSession, 'getToken' | 'getAcceptedToken' | 'onDidChange'>,
    private readonly log: Pick<vscode.LogOutputChannel, 'warn'>,
    private readonly deployment: DeploymentConfig,
  ) {
    this.subscription = auth.onDidChange(() => void this.recheck());
  }

  async launch(): Promise<ProxyEndpoint> {
    this.endpoint ??= this.listen().catch(() => {
      this.endpoint = undefined;
      throw new SafeAuthError('Local MCP proxy unavailable: could not listen on 127.0.0.1.');
    });
    const endpoint = await this.endpoint;
    if (this.disposed) {
      throw new SafeAuthError('Local MCP proxy stopped. Reload the window and try again.');
    }
    return endpoint;
  }

  private async listen(): Promise<ProxyEndpoint> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.reject(response, 502, undefined, 'Remote Device Hub could not be reached.');
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only; never a wildcard or a routable address.
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.disposed) {
      server.close();
      throw new Error('disposed');
    }
    server.on('error', () => this.dispose());
    const { port } = server.address() as AddressInfo;
    return {
      uri: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${this.key}` },
    };
  }

  private reject(
    response: http.ServerResponse,
    status: number,
    id: string | number | undefined,
    message: string,
  ): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    // Never 401 and never WWW-Authenticate: either would send the editor into
    // its own OAuth flow against this proxy.
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } }),
    );
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const address = this.server?.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const presented = digest(request.headers.authorization ?? '');
    if (
      // A browser page cannot set the key, and a rebound hostname fails here.
      request.headers.host !== `127.0.0.1:${port}` ||
      request.headers.origin !== undefined ||
      request.url !== '/mcp' ||
      !timingSafeEqual(presented, this.expected)
    ) {
      request.resume();
      this.reject(response, 403, undefined, 'Forbidden.');
      return;
    }
    const method = request.method ?? '';
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      request.resume();
      this.reject(response, 405, undefined, 'Method not allowed.');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        this.reject(response, 413, undefined, 'Request too large.');
        request.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    let id: string | number | undefined;
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
        id = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : undefined;
      }
    } catch {
      // Not JSON (GET, DELETE): there is no request id to echo.
    }

    // Refresh happens here, before dispatch; the request is sent once.
    const token = await this.auth.getToken();
    if (!token || this.disposed) {
      this.reject(response, 503, id, 'Not signed in. Run "Remote Device Hub: Sign In".');
      return;
    }
    const owner = identity(token);
    const session = request.headers['mcp-session-id'];
    if (typeof session === 'string' && (this.sessions.get(session) ?? owner) !== owner) {
      // Opened under another sign-in: the client must start a new session.
      this.reject(response, 404, id, 'Session belongs to a previous sign-in.');
      return;
    }

    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') {
        headers.set(name, value);
      }
    }
    headers.set('Authorization', `Bearer ${token.access_token}`);
    const controller = new AbortController();
    this.inflight.set(controller, owner);
    response.on('close', () => {
      this.inflight.delete(controller);
      controller.abort();
    });
    let upstream: Response;
    try {
      upstream = await fetch(this.deployment.mcpUri, {
        method,
        headers,
        ...(method === 'POST' ? { body } : {}),
        // The bearer token never follows a redirect.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) {
        this.log.warn('MCP request did not reach RDH. Check connectivity.');
      }
      this.reject(response, 502, id, 'Remote Device Hub could not be reached. Try again.');
      return;
    }
    if (upstream.status === 401) {
      void upstream.body?.cancel().catch(() => {});
      this.log.warn('RDH rejected the saved sign-in.');
      // Let the session decide between a refresh and asking the user.
      void this.auth.getAcceptedToken().catch(() => {});
      this.reject(response, 503, id, 'Remote Device Hub rejected the saved sign-in.');
      return;
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      void upstream.body?.cancel().catch(() => {});
      this.reject(response, 502, id, 'Unexpected redirect from Remote Device Hub.');
      return;
    }
    if (!upstream.ok) {
      // Status only: an error body is not ours to pass on or log.
      void upstream.body?.cancel().catch(() => {});
      this.reject(
        response,
        upstream.status,
        id,
        `Remote Device Hub returned HTTP ${upstream.status}.`,
      );
      return;
    }
    const opened = upstream.headers.get('mcp-session-id');
    if (opened) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) {
          this.sessions.delete(oldest);
        }
      }
      this.sessions.set(opened, owner);
    }
    if (method === 'DELETE' && typeof session === 'string') {
      this.sessions.delete(session);
    }
    const forwarded: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) {
        forwarded[name] = value;
      }
    }
    response.writeHead(upstream.status, forwarded);
    if (!upstream.body) {
      response.end();
      return;
    }
    response.flushHeaders();
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  // A changed or removed sign-in ends every stream opened under the old one.
  private async recheck(): Promise<void> {
    let owner: string | undefined;
    try {
      const token = await this.auth.getToken();
      owner = token ? identity(token) : undefined;
    } catch {
      owner = undefined;
    }
    for (const [controller, opener] of this.inflight) {
      if (opener !== owner) {
        controller.abort();
      }
    }
    for (const [session, opener] of this.sessions) {
      if (opener !== owner) {
        this.sessions.delete(session);
      }
    }
  }

  disconnect(): void {
    for (const controller of this.inflight.keys()) {
      controller.abort();
    }
    this.sessions.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    this.disconnect();
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
