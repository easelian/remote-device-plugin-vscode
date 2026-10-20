/**
 * Remote Device Hub for VS Code (MVP).
 *
 * Install the extension, authorize it in your browser, and use device tools
 * through Copilot Chat or the MCP server provided by this extension.
 *
 * Authentication uses a temporary loopback callback server on the extension
 * host. asExternalUri makes the callback reachable from the client browser,
 * including through a tunnel when the extension runs remotely.
 * The deployment accepted http://127.0.0.1:<port>/callback during DCR testing
 * on October 12, 2026 (HTTP 201).
 *
 * SecretStorage holds the tokens. The extension owns token refresh to avoid
 * competing refresh requests under the server's rotation and replay protection.
 * The MCP provider supplies the current Authorization header and fires
 * onDidChangeMcpServerDefinitions when credentials change.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as http from 'http';
import { withCredentialLock } from './credentialLock';
import { registerChat } from './chat';

// ================= Deployment settings =================
const AUTH_BASE = 'https://mcp.xdistribute.site';       // Browser authorization and client registration
const MCP_URI = 'https://xdistribute.site:8090/mcp';    // MCP endpoint; connects directly to the origin
const TOKEN_URI = new URL('/token', MCP_URI).toString(); // The same trusted Hub, without the proxy hop
const REFRESH_URI = new URL('/token/refresh', MCP_URI).toString();
const REVOKE_URI = new URL('/revoke', MCP_URI).toString();
const RESOURCE = 'https://mcp.xdistribute.site/mcp';
const SCOPE = 'devices:control';

const PROVIDER_ID = 'xdistribute.remote-device-hub';
const SERVER_LABEL = 'Remote Device Hub';
const SECRET_KEY = 'rdh.tokens.v1';
const AUTH_STATE_KEY = 'rdh.authState.v1';
const REFRESH_KEY_PREFIX = 'rdh.refreshKey.v1.';
const REFRESH_MARGIN_S = 180;               // Refresh 180 seconds before expiration
const REFRESH_RETRY_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;      // Maximum time allowed for sign-in
const REQUEST_TIMEOUT_MS = 30 * 1000;

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  _got_at?: number;   // Time received, in Unix epoch seconds
  client_id: string;
  // Written before refresh is sent. A surviving marker means the response may
  // have been lost; replaying that refresh token can revoke the entire grant.
  _refresh_state?: 'pending' | 'rejected';
  _refresh_request_id?: string;
  _refresh_recovery?: true;
}

class CredentialError extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
}

let changeEmitter: vscode.EventEmitter<void>;
let refreshInflight: Promise<TokenSet | undefined> | undefined;
let log: vscode.LogOutputChannel;
let signInInflight: Promise<void> | undefined;
let signInAbort: AbortController | undefined;
let credentialCheckInflight: Promise<TokenSet | undefined> | undefined;
let signInNoticeShown = false;
let pendingTokenSave: { previousRefreshToken: string; next: TokenSet } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  changeEmitter = new vscode.EventEmitter<void>();
  log = vscode.window.createOutputChannel('Remote Device Hub', { log: true });
  log.info(`Remote Device Hub ${context.extension?.packageJSON?.version ?? 'development'} activated`);

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('rdh.signIn', () => signIn(context, true)),
    vscode.commands.registerCommand('rdh.signOut', () => signOut(context)),
    vscode.commands.registerCommand('rdh.showStatus', () => showStatus(context)),
    vscode.commands.registerCommand('rdh.showLogs', () => log.show(true)),
    new vscode.Disposable(() => signInAbort?.abort()),
    changeEmitter,
  );

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let scheduleGeneration = 0;
  const scheduleRefresh = async () => {
    const generation = ++scheduleGeneration;
    clearTimeout(refreshTimer);
    try {
      const t = await readStoredToken(context);
      if (disposed || generation !== scheduleGeneration || !t) { return; }
      const canSaveResponse = t._refresh_state === 'pending'
        && pendingTokenSave && pendingTokenSave.previousRefreshToken === t.refresh_token;
      const canRecover = t._refresh_state === 'pending' && Boolean(t._refresh_request_id);
      if (t._refresh_state && !canSaveResponse && !canRecover) { return; }
      const due = canSaveResponse || canRecover ? 0 : tokenExpiresAt(t) - REFRESH_MARGIN_S * 1000 - Date.now();
      refreshTimer = setTimeout(() => {
        void getToken(context)
          .catch(e => log.warn(`scheduled refresh deferred: ${msg(e)}`))
          .finally(() => { void scheduleRefresh(); });
      }, Math.max(REFRESH_RETRY_MS, due));
    } catch (e) {
      log.warn(`refresh scheduling deferred: ${msg(e)}`);
    }
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(refreshTimer);
  }));
  context.subscriptions.push(context.secrets.onDidChange(event => {
    if (event.key === SECRET_KEY) {
      changeEmitter.fire();
      void scheduleRefresh();
    }
  }));

  registerChat(context, {
    endpoint: MCP_URI,
    ensureSignedIn: async () => {
      try {
        if (await getAcceptedToken(context)) { return true; }
        await signIn(context);
        if (await getAcceptedToken(context)) { return true; }
        offerSignIn(context, 'No usable saved credentials.');
      } catch (e) {
        if (!(e instanceof CredentialError)) { throw e; }
        offerSignIn(context, e.message);
      }
      return false;
    },
    accessToken: async () => (await getToken(context))?.access_token,
  });

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: async () => {
      // VS Code requests definitions during chat autostart scans or from the MCP view.
      // Advertise the server before sign-in; resolve handles authentication when it starts.
      try {
        const t = await readStoredToken(context);
        log.debug(t
          ? 'definition provided with saved credentials (validated before startup)'
          : 'definition provided without a token (sign-in will be requested when the server starts)');
        return [makeServer(t)];
      } catch (e) {
        log.error(`provideMcpServerDefinitions failed: ${msg(e)}`);
        return [makeServer()];
      }
    },
    resolveMcpServerDefinition: async () => {
      // Validate credentials before VS Code starts the server; sign in if needed.
      try {
        let t = await getAcceptedToken(context);
        if (!t) {
          log.info('server start: no saved credentials; checking whether first-time sign-in is allowed');
          await signIn(context);
          t = await getToken(context);
          if (!t) {
            offerSignIn(context, 'No usable saved credentials.');
            return undefined;
          }
          if (!await acceptsToken(t)) {
            throw new Error('MCP rejected the new token. Check the account permissions and server configuration.');
          }
        }
        log.info('MCP server start approved; resolving definition with fresh credentials');
        return makeServer(t);
      } catch (e) {
        log.error(`resolveMcpServerDefinition failed: ${msg(e)}`);
        if (e instanceof CredentialError) { offerSignIn(context, e.message); }
        return undefined;
      }
    },
  };
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
  log.info('MCP server definition provider registered; VS Code starts the server on demand (chat / MCP view).');

  // Renew saved credentials silently. Only a first installation may open the
  // browser without an explicit Sign In action; reloads must not restart OAuth.
  log.info('activation: checking saved credentials with the MCP server');
  void getAcceptedToken(context).then(async (t) => {
    if (!t) {
      log.info('activation: no saved credentials; checking whether first-time sign-in is allowed');
      return signIn(context);
    } else {
      if (!await context.secrets.get(AUTH_STATE_KEY)) {
        await context.secrets.store(AUTH_STATE_KEY, JSON.stringify({ previously_signed_in: true }));
      }
      log.info('activation: server accepted saved credentials; browser sign-in is not needed');
    }
  }).catch((e) => {
    log.error(`automatic sign-in check failed: ${msg(e)}`);
  }).finally(() => { void scheduleRefresh(); });
}

export function deactivate(): void { /* noop */ }

function makeServer(t?: TokenSet): vscode.McpHttpServerDefinition {
  return new vscode.McpHttpServerDefinition(
    SERVER_LABEL,
    vscode.Uri.parse(MCP_URI),
    t ? { Authorization: `Bearer ${t.access_token}` } : undefined,
  );
}

// ---------------------------------------------------------------- Token management

async function getToken(context: vscode.ExtensionContext): Promise<TokenSet | undefined> {
  let t = await readStoredToken(context);
  // Recovery may return an older rotation whose access token has expired. Walk
  // a bounded number of saved rotations before handing a token to MCP.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!t) { return undefined; }
    const recoverable = t._refresh_state === 'pending' && (t._refresh_request_id
      || (pendingTokenSave && pendingTokenSave.previousRefreshToken === t.refresh_token));
    if (!recoverable && !isExpiring(t)) { return t; }
    t = await refreshToken(context, t);
    if (t && !isExpiring(t)) { return t; }
  }
  throw new Error('Credential recovery is still in progress; retry after the next scheduled refresh.');
}

async function readStoredToken(context: vscode.ExtensionContext): Promise<TokenSet | undefined> {
  const raw = await context.secrets.get(SECRET_KEY);
  if (!raw) { return undefined; }
  let t: TokenSet;
  try { t = JSON.parse(raw) as TokenSet; } catch {
    throw new CredentialError('invalid_storage', 'Saved credentials could not be read. Use Remote Device Hub: Sign In to reconnect.');
  }
  if (!t || typeof t.access_token !== 'string' || !t.access_token
      || typeof t.client_id !== 'string' || !t.client_id
      || (t.refresh_token !== undefined && typeof t.refresh_token !== 'string')
      || (t._got_at !== undefined && (!Number.isFinite(t._got_at) || t._got_at < 0))
      || (t.expires_in !== undefined && (!Number.isFinite(t.expires_in) || t.expires_in <= 0))
      || (t._refresh_state !== undefined && !['pending', 'rejected'].includes(t._refresh_state))
      || (t._refresh_recovery !== undefined && t._refresh_recovery !== true)
      || (t._refresh_request_id !== undefined && (typeof t._refresh_request_id !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/.test(t._refresh_request_id) || t._refresh_state !== 'pending'))) {
    throw new CredentialError('invalid_storage', 'Saved credentials have an invalid format. Use Remote Device Hub: Sign In to reconnect.');
  }
  return t;
}

function refreshToken(context: vscode.ExtensionContext, t: TokenSet): Promise<TokenSet | undefined> {
  refreshInflight = refreshInflight ?? withCredentialLock(context.globalStorageUri.fsPath, async () => {
    // Another extension host may have rotated the token while we waited.
    const current = await readStoredToken(context);
    if (!current) { pendingTokenSave = undefined; return undefined; }
    if (JSON.stringify(current) !== JSON.stringify(t) && !isExpiring(current)) { return current; }
    return doRefresh(context, current);
  }).finally(() => { refreshInflight = undefined; });
  return refreshInflight;
}

function getAcceptedToken(context: vscode.ExtensionContext): Promise<TokenSet | undefined> {
  credentialCheckInflight ??= (async () => {
    let t = await getToken(context);
    if (t && !await acceptsToken(t)) {
      log.warn('MCP rejected saved credentials; trying token refresh');
      t = await refreshToken(context, t);
      if (t && !await acceptsToken(t)) {
        throw new CredentialError('mcp_rejected', 'The service rejected the renewed credentials. Use Remote Device Hub: Sign In to reconnect.');
      }
    }
    if (t) { signInNoticeShown = false; }
    return t;
  })().finally(() => { credentialCheckInflight = undefined; });
  return credentialCheckInflight;
}

async function getAcceptedTokenUnlocked(context: vscode.ExtensionContext): Promise<TokenSet | undefined> {
  const t = await readStoredToken(context);
  if (!t) { return undefined; }
  if (!t._refresh_state && !isExpiring(t) && await acceptsToken(t)) { return t; }
  const fresh = await doRefresh(context, t);
  if (fresh && !await acceptsToken(fresh)) {
    throw new CredentialError('mcp_rejected', 'The service rejected the renewed credentials. Use Remote Device Hub: Sign In to reconnect.');
  }
  return fresh;
}

// A locally unexpired token may have been revoked. Check it with an MCP ping
// so this extension can recover before VS Code starts its own OAuth flow.
async function acceptsToken(t: TokenSet): Promise<boolean> {
  const resp = await fetch(MCP_URI, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rdh-auth-check', method: 'ping' }),
  });
  await resp.body?.cancel();
  log.info(`MCP credential check: HTTP ${resp.status}`);
  if (resp.status === 401) { return false; }
  if (!resp.ok) { throw new Error(`MCP credential check failed: HTTP ${resp.status}`); }
  return true;
}

function isExpiring(t: TokenSet): boolean {
  return Date.now() >= tokenExpiresAt(t) - REFRESH_MARGIN_S * 1000;
}

function tokenExpiresAt(t: TokenSet): number {
  return ((t._got_at ?? 0) + (t.expires_in ?? 3600)) * 1000;
}

async function doRefresh(context: vscode.ExtensionContext, t: TokenSet): Promise<TokenSet | undefined> {
  // If only SecretStorage failed, save the response already held in memory.
  // This retries persistence without making another rotation request.
  if (pendingTokenSave && pendingTokenSave.previousRefreshToken === t.refresh_token && t._refresh_state === 'pending') {
    const next = pendingTokenSave.next;
    await context.secrets.store(SECRET_KEY, JSON.stringify(next));
    pendingTokenSave = undefined;
    changeEmitter.fire();
    log.info('recovered rotated credentials after a secret storage failure');
    return next;
  }
  pendingTokenSave = undefined;
  if (t._refresh_state === 'pending' && !t._refresh_request_id) {
    throw new CredentialError('refresh_outcome_unknown', 'A previous token refresh did not finish saving its result. The old refresh token will not be replayed. Use Remote Device Hub: Sign In to reconnect.');
  }
  if (t._refresh_state === 'rejected') {
    throw new CredentialError('refresh_rejected', 'The service rejected the saved refresh token. Use Remote Device Hub: Sign In to reconnect.');
  }
  if (!t.refresh_token) {
    throw new CredentialError('missing_refresh_token', 'Saved credentials have no refresh token. Use Remote Device Hub: Sign In to reconnect.');
  }
  // The client-only recovery key is stored separately from OAuth responses and
  // token records. A stolen token pair cannot derive a future recovery proof.
  // New grants create this key before publishing their credentials to hosts.
  let requestId = t._refresh_request_id;
  if (t._refresh_recovery && !requestId) {
    const recoveryKey = await context.secrets.get(REFRESH_KEY_PREFIX + t.client_id);
    if (!recoveryKey || !/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) {
      throw new CredentialError('refresh_key_missing', 'The saved sign-in recovery key is unavailable. Use Remote Device Hub: Sign In to reconnect.');
    }
    requestId = base64url(crypto.createHmac('sha256', recoveryKey)
      .update('rdh-refresh-recovery-v1\0').update(t.client_id).update('\0').update(t.refresh_token).digest());
  }
  const pending: TokenSet = { ...t, _refresh_state: 'pending' };
  if (requestId) { pending._refresh_request_id = requestId; }
  await context.secrets.store(SECRET_KEY, JSON.stringify(pending));
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.client_id,
      resource: RESOURCE,
    });
    if (requestId) { body.set('rdh_refresh_id', requestId); }
    const send = (uri: string) => fetch(uri, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    let resp = await send(requestId ? REFRESH_URI : TOKEN_URI);
    if (requestId && resp.status === 404 && t._refresh_state !== 'pending') {
      // Older servers have no recovery endpoint. A definitive 404 on the first
      // request permits legacy fallback; an indeterminate request never does.
      await resp.body?.cancel();
      delete pending._refresh_request_id;
      await context.secrets.store(SECRET_KEY, JSON.stringify(pending));
      body.delete('rdh_refresh_id');
      resp = await send(TOKEN_URI);
      log.debug('server has no refresh recovery endpoint; used legacy refresh');
    }
    const responseRequestId = resp.headers.get('x-request-id');
    log.info(`token refresh: HTTP ${resp.status}${responseRequestId && /^[A-Za-z0-9_-]{1,128}$/.test(responseRequestId) ? `; request=${responseRequestId}` : ''}`);
    if (!resp.ok) {
      const error = await resp.json().catch(() => ({})) as { error?: string };
      if (resp.status === 400 && error.error === 'invalid_grant') {
        const current = await readStoredToken(context);
        if (!current || current.client_id !== t.client_id || current.refresh_token !== t.refresh_token) { return current; }
        const rejected: TokenSet = { ...t, _refresh_state: 'rejected' };
        delete rejected._refresh_request_id;
        await context.secrets.store(SECRET_KEY, JSON.stringify(rejected));
        throw new CredentialError('refresh_rejected', 'The service rejected the saved refresh token (HTTP 400, invalid_grant). Use Remote Device Hub: Sign In to reconnect.');
      }
      // These OAuth validation errors occur before token issuance. A 5xx may
      // follow a committed rotation, even if it has a JSON error body.
      if ((resp.status === 400 || resp.status === 401)
          && ['invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope',
              'invalid_target', 'unsupported_grant_type'].includes(error.error ?? '')) {
        const restored = { ...t };
        delete restored._refresh_state;
        delete restored._refresh_request_id;
        await context.secrets.store(SECRET_KEY, JSON.stringify(restored));
      }
      throw new Error(`token refresh HTTP ${resp.status}; credentials retained`);
    }
    const data = await resp.json() as Partial<TokenSet>;
    if (!data.access_token) { throw new Error('token response has no access_token'); }
    const next: TokenSet = {
      ...t,
      ...data,
      refresh_token: data.refresh_token ?? t.refresh_token,
      _got_at: Date.now() / 1000,
    };
    delete next._refresh_state;
    delete next._refresh_request_id;
    const current = await readStoredToken(context);
    // A different host may have signed out, switched accounts, or published a
    // later rotation while this response was delayed. Never overwrite it.
    if (!current || current.client_id !== t.client_id || current.refresh_token !== t.refresh_token) { return current; }
    pendingTokenSave = { previousRefreshToken: t.refresh_token, next };
    await context.secrets.store(SECRET_KEY, JSON.stringify(next));
    pendingTokenSave = undefined;
    log.info('token refreshed; asked VS Code to pick up new credentials');
    if (resp.headers.get('rdh-refresh-recovered') === '1') {
      log.info('recovered the result of an earlier refresh without opening browser sign-in');
    }
    changeEmitter.fire();
    return next;
  } catch (e) {
    log.warn(`token refresh failed: ${msg(e)}`);
    throw e;
  }
}

// ---------------------------------------------------------------- Sign-in flow

function signIn(context: vscode.ExtensionContext, explicit = false): Promise<void> {
  if (!signInInflight) {
    signInInflight = (async () => {
      if (!explicit && await context.secrets.get(AUTH_STATE_KEY)) {
        // A different window may own an unfinished first-time sign-in. Wait
        // silently for it, then reuse its result without opening another flow.
        const controller = new AbortController();
        signInAbort = controller;
        const deadline = setTimeout(() => controller.abort(new Error('waiting for sign-in timed out')), AUTH_TIMEOUT_MS);
        log.debug('waiting for another window to finish sign-in');
        try {
          await withCredentialLock(context.globalStorageUri.fsPath, async () => {
            if (await getAcceptedTokenUnlocked(context)) { return; }
            log.info('automatic sign-in suppressed: a previous attempt or sign-out is recorded; use Sign In to retry');
          }, controller.signal);
        } catch (e) {
          if (controller.signal.aborted && controller.signal.reason?.name === 'AbortError') {
            log.info('sign-in wait cancelled');
            return;
          }
          throw e;
        } finally {
          clearTimeout(deadline);
          signInAbort = undefined;
        }
        return;
      }
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Remote Device Hub: signing in',
        cancellable: true,
      }, (progress, cancellation) => runSignIn(context, progress, cancellation, explicit));
    })().finally(() => { signInInflight = undefined; });
  }
  return signInInflight;
}

async function runSignIn(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string }>,
  cancellation: vscode.CancellationToken,
  explicit: boolean,
): Promise<void> {
  const controller = new AbortController();
  signInAbort = controller;
  const cancel = cancellation.onCancellationRequested(() => controller.abort());
  if (cancellation.isCancellationRequested) { controller.abort(); }
  const deadline = setTimeout(() => controller.abort(new Error('sign-in timed out')), AUTH_TIMEOUT_MS);
  const signal = controller.signal;
  try {
    await withCredentialLock(context.globalStorageUri.fsPath, async () => {
      signal.throwIfAborted();
      // Recheck after acquiring ownership: another window may have signed in.
      try {
        if (await getAcceptedTokenUnlocked(context)) { return; }
      } catch (e) {
        if (!(e instanceof CredentialError) || !explicit) { throw e; }
        log.info(`explicit sign-in will replace unusable saved credentials (${e.reason})`);
      }
      if (!explicit && await context.secrets.get(AUTH_STATE_KEY)) {
        log.info('automatic sign-in suppressed: a previous attempt or sign-out is recorded; use Sign In to retry');
        return;
      }
      // Keep this marker after cancellation, timeout, failure, and reload. A
      // waiting window must not start another browser flow after we release.
      await context.secrets.store(AUTH_STATE_KEY, JSON.stringify({ attempted_at: Date.now() }));
      progress.report({ message: 'Preparing browser callback…' });
      const cb = await startCallbackServer();
      log.info(`sign-in started; waiting for browser callback on 127.0.0.1:${cb.port}`);
      try {
        // asExternalUri forwards remote ports for the client browser. Do not cache the URI.
        const redirectUri = (await abortable(vscode.env.asExternalUri(
          vscode.Uri.parse(`http://127.0.0.1:${cb.port}/callback`)), signal, 'callback forwarding')).toString(true);

        // 1) Register the client dynamically (RFC 7591)
        progress.report({ message: 'Preparing authorization…' });
        const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        const reg = await fetch(`${AUTH_BASE}/register`, {
          method: 'POST',
          signal: requestSignal(),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'VS Code Remote Device Hub',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          }),
        });
        if (reg.status !== 200 && reg.status !== 201) {
          throw new Error(`register HTTP ${reg.status}: ${(await reg.text()).slice(0, 200)}`);
        }
        const { client_id: clientId } = await reg.json() as { client_id: string };
        if (!clientId) { throw new Error('registration response has no client_id'); }

        // 2) PKCE + state
        const verifier = base64url(crypto.randomBytes(48));
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
        const state = base64url(crypto.randomBytes(16));

        // 3) Open the browser for authorization
        const authUrl = new URL(`${AUTH_BASE}/authorize`);
        const params: Record<string, string> = {
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: SCOPE,
          state,
          resource: RESOURCE,
        };
        for (const [k, v] of Object.entries(params)) { authUrl.searchParams.set(k, v); }
        progress.report({ message: 'Opening authorization in your local browser…' });
        const opened = await abortable(vscode.env.openExternal(vscode.Uri.parse(authUrl.toString())), signal, 'browser opening');
        if (!opened) {
          const pick = await abortable(vscode.window.showWarningMessage(
            'Remote Device Hub: could not open the browser. Copy the authorization link and open it in your local browser.',
            'Copy Link'), signal, 'browser fallback', AUTH_TIMEOUT_MS);
          if (pick !== 'Copy Link') { return; }
          signal.throwIfAborted();
          await vscode.env.clipboard.writeText(authUrl.toString());
        }

        // 4) Wait for the callback
        progress.report({ message: 'Complete authorization in your browser…' });
        const result = await abortable(cb.waitForCode(state, AUTH_TIMEOUT_MS), signal, 'authorization', AUTH_TIMEOUT_MS);
        if (result.error) {
          throw new Error(`${result.error} ${result.errorDescription ?? ''}`);
        }

        // 5) Exchange the authorization code for tokens
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: result.code ?? '',
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource: RESOURCE,
        });
        const resp = await fetch(TOKEN_URI, {
          method: 'POST',
          redirect: 'error',
          signal: requestSignal(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (!resp.ok) { throw new Error(`token HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`); }
        const tok = await resp.json() as TokenSet;
        if (!tok.access_token) { throw new Error('token response has no access_token'); }
        signal.throwIfAborted();
        tok.client_id = clientId;
        tok._got_at = Date.now() / 1000;
        await context.secrets.store(REFRESH_KEY_PREFIX + clientId, base64url(crypto.randomBytes(32)));
        tok._refresh_recovery = true;
        await context.secrets.store(SECRET_KEY, JSON.stringify(tok));
        signInNoticeShown = false;
        log.info('signed in; token stored; asked VS Code to pick up new credentials');
        changeEmitter.fire();
        vscode.window.showInformationMessage('Remote Device Hub: signed in');
      } finally {
        cb.close();
      }
    }, signal);
  } catch (e) {
    if (signal.aborted && signal.reason?.name === 'AbortError') {
      log.info('sign-in cancelled');
      return;
    }
    log.error(`sign-in failed: ${msg(e)}`);
    vscode.window.showErrorMessage(`Remote Device Hub: sign-in failed - ${msg(e)}`);
  } finally {
    clearTimeout(deadline);
    cancel.dispose();
    signInAbort = undefined;
  }
}

async function signOut(context: vscode.ExtensionContext): Promise<void> {
  signInAbort?.abort();
  await signInInflight?.catch(e => log.debug(`previous sign-in ended: ${msg(e)}`));
  let revocationFailed = false;
  await withCredentialLock(context.globalStorageUri.fsPath, async () => {
    await context.secrets.store(AUTH_STATE_KEY, JSON.stringify({ signed_out_at: Date.now() }));
    let clientId: string | undefined;
    let revocation: { token: string; token_type_hint: string } | undefined;
    try {
      const raw = await context.secrets.get(SECRET_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as Partial<TokenSet> | null;
        if (!stored || typeof stored.client_id !== 'string' || !stored.client_id) {
          throw new Error('Saved credentials have no OAuth client');
        }
        clientId = stored.client_id;
        // Revoke directly, including an expired or pending refresh. Refreshing
        // first could rotate the very credentials that sign-out must revoke.
        const hasRefresh = typeof stored.refresh_token === 'string' && Boolean(stored.refresh_token);
        const token = hasRefresh ? stored.refresh_token : stored.access_token;
        if (typeof token !== 'string' || !token) { throw new Error('No saved token to revoke'); }
        revocation = { token, token_type_hint: hasRefresh ? 'refresh_token' : 'access_token' };
      }
    } catch {
      revocationFailed = true;
      // Errors and response bodies can contain credentials. Keep logs generic.
      log.warn('server authorization revocation was not confirmed');
    } finally {
      pendingTokenSave = undefined;
      // Persist local sign-out before waiting for the network, so closing VS
      // Code during a slow request cannot restore this account on the next run.
      const latest = await context.secrets.get(SECRET_KEY);
      let replaced = false;
      try {
        const latestClient = latest && JSON.parse(latest)?.client_id;
        replaced = Boolean(typeof latestClient === 'string' && latestClient && latestClient !== clientId);
      } catch { /* Malformed credentials still need local cleanup. */ }
      if (!replaced) { await context.secrets.delete(SECRET_KEY); }
      if (clientId) { await context.secrets.delete(REFRESH_KEY_PREFIX + clientId); }
      if (replaced) { log.info('sign-out preserved a newer sign-in from another host'); }
    }
    if (clientId && revocation) {
      try {
        const response = await fetch(REVOKE_URI, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, ...revocation }).toString(),
        });
        log.info(`token revocation: HTTP ${response.status}`);
        await response.body?.cancel();
        if (response.status !== 200) { throw new Error('Revocation was not acknowledged'); }
      } catch {
        revocationFailed = true;
        log.warn('server authorization revocation was not confirmed');
      }
    }
  });
  log.info(`signed out; ${revocationFailed ? 'server revocation unconfirmed' : 'server revocation complete or no saved credentials'}`);
  changeEmitter.fire();
  if (revocationFailed) {
    void vscode.window.showWarningMessage("Remote Device Hub: signed out locally, but server revocation could not be confirmed. Revoke this connection in the Hub's account settings if it may have been compromised.");
  } else {
    void vscode.window.showInformationMessage('Remote Device Hub: signed out');
  }
}

async function showStatus(context: vscode.ExtensionContext): Promise<void> {
  let t: TokenSet | undefined;
  try { t = await getAcceptedToken(context); } catch (e) {
    log.warn(`status check failed: ${msg(e)}`);
    if (e instanceof CredentialError) { offerSignIn(context, e.message); }
    else { void vscode.window.showWarningMessage(`Remote Device Hub: could not check sign-in status - ${msg(e)}`); }
    return;
  }
  if (!t) {
    const pick = await vscode.window.showWarningMessage(
      'Remote Device Hub: not signed in', 'Sign In');
    if (pick === 'Sign In') { await signIn(context, true); }
    return;
  }
  const secs = Math.max(0, Math.round((t._got_at ?? 0) + (t.expires_in ?? 0) - Date.now() / 1000));
  log.info(`status: signed in, token expires in ${secs}s`);
  vscode.window.showInformationMessage(
    `Remote Device Hub: signed in, token auto-refreshes (expires in ${secs}s)`);
}

function offerSignIn(context: vscode.ExtensionContext, reason: string): void {
  log.warn(`sign-in requires user action: ${reason}`);
  if (signInNoticeShown) { return; }
  signInNoticeShown = true;
  void Promise.resolve(vscode.window.showWarningMessage(`Remote Device Hub: ${reason}`, 'Sign In'))
    .then(pick => { if (pick === 'Sign In') { return signIn(context, true); } })
    .catch(e => log.error(`sign-in action failed: ${msg(e)}`));
}

// ---------------------------------------------------------------- Temporary callback server

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

function startCallbackServer(): Promise<{
  port: number;
  waitForCode: (expectedState: string, timeoutMs: number) => Promise<CallbackResult>;
  close: () => void;
}> {
  return new Promise((resolveServer, rejectServer) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (r: CallbackResult) => void = () => { /* noop */ };
    const resultPromise = new Promise<CallbackResult>((res) => { settle = res; });

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
      };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.error
        ? `<html><body><h2>Authorization failed</h2><p>${result.error}</p></body></html>`
        : '<html><body><h2>Authorization received - you can close this page</h2></body></html>');
      settle(result);
    });

    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { rejectServer(new Error('no port')); return; }
      resolveServer({
        port: addr.port,
        waitForCode: (expectedState, timeoutMs) => new Promise<CallbackResult>((res) => {
          timer = setTimeout(
            () => res({ error: 'timeout', errorDescription: 'no callback received' }), timeoutMs);
          void resultPromise.then((r) => {
            clearTimeout(timer);
            if (r.error || r.state === expectedState) { res(r); }
            else { res({ error: 'state_mismatch', errorDescription: 'state validation failed' }); }
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

// ---------------------------------------------------------------- Helpers

function abortable<T>(work: Thenable<T>, signal: AbortSignal, stage: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let cleanup = () => {};
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    const timer = setTimeout(() => reject(new Error(`${stage} timed out`)), timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); }
    Promise.resolve(work).then(resolve, reject);
  }).finally(() => cleanup());
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function msg(e: unknown): string {
  if (e instanceof CredentialError) { return `${e.reason}: ${e.message}`; }
  return e instanceof Error ? e.message : String(e);
}
