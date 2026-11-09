import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { withCredentialLock } from './credentialLock';
import { CredentialStore, type RevocationCredential } from './credentialStore';
import { CredentialError, msg } from './authErrors';
import { discoverAuth, type AuthEndpoints } from './authDiscovery';
import { abortable, startCallbackServer } from './authCallback';
import { isRecord, readClientId, readTokenResponse, type TokenSet } from './boundaries';
import {
  type DeploymentConfig,
  SCOPE,
  REFRESH_MARGIN_S,
  REFRESH_RETRY_MS,
  AUTH_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from './authConfig';

// One instance owns authentication work, timers, cancellation, and unsaved
// rotation responses. Cross-host ownership remains with withCredentialLock.
export class AuthSession implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly store: CredentialStore;
  private readonly storageSubscription: vscode.Disposable;
  private readonly scope: string;
  private refreshInflight: Promise<TokenSet | undefined> | undefined;
  private signInInflight: Promise<void> | undefined;
  private signInAbort: AbortController | undefined;
  private credentialCheckInflight: Promise<TokenSet | undefined> | undefined;
  private signInNoticeShown = false;
  private pendingTokenSave: { previousRefreshToken: string; next: TokenSet } | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private started = false;
  private scheduleGeneration = 0;
  private authDiscovery: Promise<AuthEndpoints> | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly deployment: DeploymentConfig,
  ) {
    this.store = new CredentialStore(context.secrets, deployment.credentialNamespace);
    this.scope = `${context.globalStorageUri.fsPath}:${deployment.credentialNamespace}`;
    this.storageSubscription = this.store.onDidChange(() => {
      this.changeEmitter.fire();
      void this.scheduleRefresh();
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.scheduleGeneration++;
    clearTimeout(this.refreshTimer);
    this.storageSubscription.dispose();
    this.signInAbort?.abort();
    this.changeEmitter.dispose();
    // A dispatched rotation may still need to persist its result. Never replay
    // or discard that result just because the extension is shutting down.
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    // Renew saved credentials silently. Only a first installation may open the
    // browser without an explicit Sign In action; reloads must not restart OAuth.
    this.log.info('activation: checking saved credentials with the MCP server');
    void this.getAcceptedToken()
      .then(async (t) => {
        if (this.disposed) {
          return;
        }
        if (!t) {
          this.log.info(
            'activation: no saved credentials; checking whether first-time sign-in is allowed',
          );
          return this.signIn();
        } else {
          if (!(await this.store.hasAuthHistory())) {
            await this.store.recordAuthHistory({ previously_signed_in: true });
          }
          this.log.info(
            'activation: server accepted saved credentials; browser sign-in is not needed',
          );
        }
      })
      .catch((e) => {
        this.log.error(`automatic sign-in check failed: ${msg(e)}`);
      })
      .finally(() => {
        void this.scheduleRefresh();
      });
  }

  private async scheduleRefresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.scheduleGeneration;
    clearTimeout(this.refreshTimer);
    try {
      const t = await this.readStoredToken();
      if (this.disposed || generation !== this.scheduleGeneration || !t) {
        return;
      }
      const canSaveResponse =
        t._refresh_state === 'pending' &&
        this.pendingTokenSave &&
        this.pendingTokenSave.previousRefreshToken === t.refresh_token;
      const canRecover = t._refresh_state === 'pending' && Boolean(t._refresh_request_id);
      if (t._refresh_state && !canSaveResponse && !canRecover) {
        return;
      }
      const due =
        canSaveResponse || canRecover
          ? 0
          : tokenExpiresAt(t) - REFRESH_MARGIN_S * 1000 - Date.now();
      this.refreshTimer = setTimeout(
        () => {
          void this.getToken()
            .catch((e) => this.log.warn(`scheduled refresh deferred: ${msg(e)}`))
            .finally(() => {
              void this.scheduleRefresh();
            });
        },
        Math.max(REFRESH_RETRY_MS, due),
      );
    } catch (e) {
      this.log.warn(`refresh scheduling deferred: ${msg(e)}`);
    }
  }

  async getToken(): Promise<TokenSet | undefined> {
    if (this.disposed) {
      return undefined;
    }
    let t = await this.readStoredToken();
    if (this.disposed) {
      return undefined;
    }
    // Recovery may return an older rotation whose access token has expired. Walk
    // a bounded number of saved rotations before handing a token to MCP.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!t) {
        return undefined;
      }
      const recoverable =
        t._refresh_state === 'pending' &&
        (t._refresh_request_id ||
          (this.pendingTokenSave &&
            this.pendingTokenSave.previousRefreshToken === t.refresh_token));
      if (!recoverable && !isExpiring(t)) {
        return t;
      }
      t = await this.refreshToken(t);
      if (t && !isExpiring(t)) {
        return t;
      }
    }
    throw new Error(
      'Credential recovery is still in progress; retry after the next scheduled refresh.',
    );
  }

  private getAuthEndpoints(): Promise<AuthEndpoints> {
    if (!this.authDiscovery) {
      const pending = discoverAuth(this.deployment);
      this.authDiscovery = pending;
      void pending.catch(() => {
        if (this.authDiscovery === pending) {
          this.authDiscovery = undefined;
        }
      });
    }
    return this.authDiscovery;
  }

  async readStoredToken(): Promise<TokenSet | undefined> {
    const first = await this.store.read();
    if (!first) {
      return undefined;
    }
    const endpoints = await this.getAuthEndpoints();
    // Discovery can take longer than a concurrent sign-out or account switch.
    const token = await this.store.read();
    if (token && token._issuer !== endpoints.issuer) {
      throw new CredentialError(
        'authorization_changed',
        'Saved credentials are not bound to the current authorization server. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    return token;
  }

  private refreshToken(t: TokenSet): Promise<TokenSet | undefined> {
    this.refreshInflight =
      this.refreshInflight ??
      withCredentialLock(this.scope, async () => {
        if (this.disposed) {
          return undefined;
        }
        // Another extension host may have rotated the token while we waited.
        const current = await this.readStoredToken();
        if (this.disposed) {
          return undefined;
        }
        if (!current) {
          this.pendingTokenSave = undefined;
          return undefined;
        }
        if (JSON.stringify(current) !== JSON.stringify(t) && !isExpiring(current)) {
          return current;
        }
        return this.doRefresh(current);
      }).finally(() => {
        this.refreshInflight = undefined;
      });
    return this.refreshInflight;
  }

  getAcceptedToken(): Promise<TokenSet | undefined> {
    this.credentialCheckInflight ??= (async () => {
      let t = await this.getToken();
      if (this.disposed) {
        return undefined;
      }
      if (t && !(await this.acceptsToken(t))) {
        this.log.warn('MCP rejected saved credentials; trying token refresh');
        t = await this.refreshToken(t);
        if (t && !(await this.acceptsToken(t))) {
          throw new CredentialError(
            'mcp_rejected',
            'The service rejected the renewed credentials. Use Remote Device Hub: Sign In to reconnect.',
          );
        }
      }
      if (t) {
        this.signInNoticeShown = false;
      }
      return t;
    })().finally(() => {
      this.credentialCheckInflight = undefined;
    });
    return this.credentialCheckInflight;
  }

  private async getAcceptedTokenUnlocked(): Promise<TokenSet | undefined> {
    const t = await this.readStoredToken();
    if (!t) {
      return undefined;
    }
    if (!t._refresh_state && !isExpiring(t) && (await this.acceptsToken(t))) {
      return t;
    }
    const fresh = await this.doRefresh(t);
    if (fresh && !(await this.acceptsToken(fresh))) {
      throw new CredentialError(
        'mcp_rejected',
        'The service rejected the renewed credentials. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    return fresh;
  }

  // A locally unexpired token may have been revoked. Check it with an MCP ping
  // so this extension can recover before VS Code starts its own OAuth flow.
  async acceptsToken(t: TokenSet): Promise<boolean> {
    const resp = await fetch(this.deployment.mcpUri, {
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
    this.log.info(`MCP credential check: HTTP ${resp.status}`);
    if (resp.status === 401) {
      return false;
    }
    if (!resp.ok) {
      throw new Error(`MCP credential check failed: HTTP ${resp.status}`);
    }
    return true;
  }

  private async doRefresh(t: TokenSet): Promise<TokenSet | undefined> {
    // If only SecretStorage failed, save the response already held in memory.
    // This retries persistence without making another rotation request.
    if (
      this.pendingTokenSave &&
      this.pendingTokenSave.previousRefreshToken === t.refresh_token &&
      t._refresh_state === 'pending'
    ) {
      const next = this.pendingTokenSave.next;
      await this.store.save(next);
      this.pendingTokenSave = undefined;
      this.changeEmitter.fire();
      this.log.info('recovered rotated credentials after a secret storage failure');
      return next;
    }
    this.pendingTokenSave = undefined;
    if (t._refresh_state === 'pending' && !t._refresh_request_id) {
      throw new CredentialError(
        'refresh_outcome_unknown',
        'A previous token refresh did not finish saving its result. The old refresh token will not be replayed. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    if (t._refresh_state === 'rejected') {
      throw new CredentialError(
        'refresh_rejected',
        'The service rejected the saved refresh token. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    if (!t.refresh_token) {
      throw new CredentialError(
        'missing_refresh_token',
        'Saved credentials have no refresh token. Use Remote Device Hub: Sign In to reconnect.',
      );
    }
    const endpoints = await this.getAuthEndpoints();
    if (t._issuer !== endpoints.issuer) {
      throw new CredentialError('authorization_changed', 'Use Sign In to reconnect.');
    }
    if (t._refresh_request_id && !endpoints.refreshUri) {
      throw new CredentialError(
        'refresh_outcome_unknown',
        'The previous refresh cannot be recovered with the current server metadata. Use Sign In to reconnect.',
      );
    }
    // The client-only recovery key is stored separately from OAuth responses and
    // token records. A stolen token pair cannot derive a future recovery proof.
    // New grants create this key before publishing their credentials to hosts.
    let requestId = t._refresh_request_id;
    if (t._refresh_recovery && endpoints.refreshUri && !requestId) {
      const recoveryKey = await this.store.recoveryKey(t.client_id);
      if (!recoveryKey || !/^[A-Za-z0-9_-]{43}$/.test(recoveryKey)) {
        throw new CredentialError(
          'refresh_key_missing',
          'The saved sign-in recovery key is unavailable. Use Remote Device Hub: Sign In to reconnect.',
        );
      }
      requestId = base64url(
        crypto
          .createHmac('sha256', recoveryKey)
          .update('rdh-refresh-recovery-v1\0')
          .update(t.client_id)
          .update('\0')
          .update(t.refresh_token)
          .digest(),
      );
    }
    const pending: TokenSet = { ...t, _refresh_state: 'pending' };
    if (requestId) {
      pending._refresh_request_id = requestId;
    }
    await this.store.save(pending);
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: t.client_id,
        resource: this.deployment.resource,
      });
      if (requestId) {
        body.set('rdh_refresh_id', requestId);
      }
      const send = (uri: string) =>
        fetch(uri, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
      let resp = await send(
        requestId && endpoints.refreshUri ? endpoints.refreshUri : endpoints.tokenUri,
      );
      if (requestId && resp.status === 404 && t._refresh_state !== 'pending') {
        // A definitive 404 on the first recovery request permits /token fallback;
        // an indeterminate request never does.
        await resp.body?.cancel();
        delete pending._refresh_request_id;
        await this.store.save(pending);
        body.delete('rdh_refresh_id');
        resp = await send(endpoints.tokenUri);
        this.log.debug('server has no refresh recovery endpoint; used /token refresh');
      }
      const responseRequestId = resp.headers.get('x-request-id');
      this.log.info(
        `token refresh: HTTP ${resp.status}${responseRequestId && /^[A-Za-z0-9_-]{1,128}$/.test(responseRequestId) ? `; request=${responseRequestId}` : ''}`,
      );
      if (!resp.ok) {
        const error: unknown = await resp.json().catch(() => undefined);
        const errorCode =
          isRecord(error) && typeof error.error === 'string' ? error.error : undefined;
        if (resp.status === 400 && errorCode === 'invalid_grant') {
          const current = await this.readStoredToken();
          if (
            !current ||
            current.client_id !== t.client_id ||
            current.refresh_token !== t.refresh_token
          ) {
            return current;
          }
          const rejected: TokenSet = { ...t, _refresh_state: 'rejected' };
          delete rejected._refresh_request_id;
          await this.store.save(rejected);
          throw new CredentialError(
            'refresh_rejected',
            'The service rejected the saved refresh token (HTTP 400, invalid_grant). Use Remote Device Hub: Sign In to reconnect.',
          );
        }
        // These OAuth validation errors occur before token issuance. A 5xx may
        // follow a committed rotation, even if it has a JSON error body.
        if (
          (resp.status === 400 || resp.status === 401) &&
          [
            'invalid_client',
            'unauthorized_client',
            'invalid_request',
            'invalid_scope',
            'invalid_target',
            'unsupported_grant_type',
          ].includes(errorCode ?? '')
        ) {
          const restored = { ...t };
          delete restored._refresh_state;
          delete restored._refresh_request_id;
          await this.store.save(restored);
        }
        throw new Error(`token refresh HTTP ${resp.status}; credentials retained`);
      }
      const data = readTokenResponse(await resp.json(), t.client_id);
      const next: TokenSet = {
        ...t,
        ...data,
        refresh_token: data.refresh_token ?? t.refresh_token,
        _got_at: Date.now() / 1000,
      };
      delete next._refresh_state;
      delete next._refresh_request_id;
      const current = await this.readStoredToken();
      // A different host may have signed out, switched accounts, or published a
      // later rotation while this response was delayed. Never overwrite it.
      if (
        !current ||
        current.client_id !== t.client_id ||
        current.refresh_token !== t.refresh_token
      ) {
        return current;
      }
      this.pendingTokenSave = { previousRefreshToken: t.refresh_token, next };
      await this.store.save(next);
      this.pendingTokenSave = undefined;
      this.log.info('token refreshed; asked VS Code to pick up new credentials');
      if (resp.headers.get('rdh-refresh-recovered') === '1') {
        this.log.info('recovered the result of an earlier refresh without opening browser sign-in');
      }
      this.changeEmitter.fire();
      return next;
    } catch (e) {
      this.log.warn(`token refresh failed: ${msg(e)}`);
      throw e;
    }
  }

  // ---------------------------------------------------------------- Sign-in flow

  signIn(explicit = false): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!this.signInInflight) {
      this.signInInflight = (async () => {
        const history = !explicit && (await this.store.hasAuthHistory());
        if (this.disposed) {
          return;
        }
        if (!explicit && history) {
          // A different window may own an unfinished first-time sign-in. Wait
          // silently for it, then reuse its result without opening another flow.
          const controller = new AbortController();
          this.signInAbort = controller;
          const deadline = setTimeout(
            () => controller.abort(new Error('waiting for sign-in timed out')),
            AUTH_TIMEOUT_MS,
          );
          this.log.debug('waiting for another window to finish sign-in');
          try {
            await withCredentialLock(
              this.scope,
              async () => {
                if (await this.getAcceptedTokenUnlocked()) {
                  return;
                }
                this.log.info(
                  'automatic sign-in suppressed: a previous attempt or sign-out is recorded; use Sign In to retry',
                );
              },
              controller.signal,
            );
          } catch (e) {
            if (controller.signal.aborted && isAbortError(controller.signal.reason)) {
              this.log.info('sign-in wait cancelled');
              return;
            }
            throw e;
          } finally {
            clearTimeout(deadline);
            this.signInAbort = undefined;
          }
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.env.language?.toLowerCase().startsWith('zh')
              ? 'Remote Device Hub：连接账户'
              : 'Remote Device Hub: connect your account',
            cancellable: true,
          },
          (progress, cancellation) => this.runSignIn(progress, cancellation, explicit),
        );
      })().finally(() => {
        this.signInInflight = undefined;
      });
    }
    return this.signInInflight;
  }

  private async runSignIn(
    progress: vscode.Progress<{ message?: string }>,
    cancellation: vscode.CancellationToken,
    explicit: boolean,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const controller = new AbortController();
    this.signInAbort = controller;
    const cancel = cancellation.onCancellationRequested(() => controller.abort());
    if (cancellation.isCancellationRequested) {
      controller.abort();
    }
    const deadline = setTimeout(
      () => controller.abort(new Error('sign-in timed out')),
      AUTH_TIMEOUT_MS,
    );
    const signal = controller.signal;
    try {
      await withCredentialLock(
        this.scope,
        async () => {
          signal.throwIfAborted();
          // Recheck after acquiring ownership: another window may have signed in.
          try {
            if (await this.getAcceptedTokenUnlocked()) {
              return;
            }
          } catch (e) {
            if (!(e instanceof CredentialError) || !explicit) {
              throw e;
            }
            this.log.info(`explicit sign-in will replace unusable saved credentials (${e.reason})`);
          }
          if (!explicit && (await this.store.hasAuthHistory())) {
            this.log.info(
              'automatic sign-in suppressed: a previous attempt or sign-out is recorded; use Sign In to retry',
            );
            return;
          }
          // Keep this marker after cancellation, timeout, failure, and reload. A
          // waiting window must not start another browser flow after we release.
          await this.store.recordAuthHistory({ attempted_at: Date.now() });
          signal.throwIfAborted();
          const chinese = vscode.env.language?.toLowerCase().startsWith('zh');
          const continueLabel = chinese ? '继续' : 'Continue';
          const consentDetail = chinese
            ? 'Remote Device Hub 是易连网（Easelian）的远程设备服务。登录后，此 VS Code 扩展会连接到你的账号，以列出你已授权的设备、读写允许访问的文件，以及运行已启用的命令和进程。设备的权限和限制仍然有效；登录不会自动配对新设备。\n\n' +
              '选择“继续”后，将打开浏览器供你登录并授权。你可以在浏览器中拒绝授权，也可以在此取消，不打开浏览器。'
            : 'Remote Device Hub is Easelian’s remote-device service. Signing in connects this VS Code extension to your account so it can list your authorized devices, read and write permitted files, and run enabled commands and processes. Device permissions and restrictions still apply; signing in does not pair any new device.\n\n' +
              'Choose Continue to open your browser for sign-in and authorization. You can decline authorization in the browser, or cancel here without opening it.';
          const consent = await abortable(
            vscode.window.showInformationMessage(
              chinese
                ? '将 VS Code 连接到 Remote Device Hub？'
                : 'Connect VS Code to Remote Device Hub?',
              {
                modal: true,
                detail: consentDetail,
              },
              continueLabel,
            ),
            signal,
            'sign-in confirmation',
            AUTH_TIMEOUT_MS,
          );
          signal.throwIfAborted();
          if (consent !== continueLabel) {
            return;
          }
          const endpoints = await abortable(this.getAuthEndpoints(), signal, 'OAuth discovery');
          progress.report({ message: 'Preparing browser callback…' });
          const cb = await startCallbackServer();
          this.log.info(`sign-in started; waiting for browser callback on 127.0.0.1:${cb.port}`);
          try {
            // asExternalUri forwards remote ports for the client browser. Do not cache the URI.
            const redirectUri = (
              await abortable(
                vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${cb.port}/callback`)),
                signal,
                'callback forwarding',
              )
            ).toString(true);

            // 1) Register the client dynamically (RFC 7591)
            progress.report({ message: 'Preparing authorization…' });
            const requestSignal = () =>
              AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
            const reg = await fetch(endpoints.registrationUri, {
              redirect: 'error',
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
            const clientId = readClientId(await reg.json());

            // 2) PKCE + state
            const verifier = base64url(crypto.randomBytes(48));
            const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
            const state = base64url(crypto.randomBytes(16));

            // 3) Open the browser for authorization
            const authUrl = new URL(endpoints.authorizationUri);
            const params: Record<string, string> = {
              response_type: 'code',
              client_id: clientId,
              redirect_uri: redirectUri,
              code_challenge: challenge,
              code_challenge_method: 'S256',
              scope: SCOPE,
              state,
              resource: this.deployment.resource,
            };
            for (const [k, v] of Object.entries(params)) {
              authUrl.searchParams.set(k, v);
            }
            progress.report({ message: 'Opening authorization in your local browser…' });
            const opened = await abortable(
              vscode.env.openExternal(vscode.Uri.parse(authUrl.toString())),
              signal,
              'browser opening',
            );
            if (!opened) {
              const pick = await abortable(
                vscode.window.showWarningMessage(
                  'Remote Device Hub: could not open the browser. Copy the authorization link and open it in your local browser.',
                  'Copy Link',
                ),
                signal,
                'browser fallback',
                AUTH_TIMEOUT_MS,
              );
              if (pick !== 'Copy Link') {
                return;
              }
              signal.throwIfAborted();
              await vscode.env.clipboard.writeText(authUrl.toString());
            }

            // 4) Wait for the callback
            progress.report({ message: 'Complete authorization in your browser…' });
            const result = await abortable(
              cb.waitForCode(
                state,
                AUTH_TIMEOUT_MS,
                endpoints.issuer,
                endpoints.responseIssuerRequired,
              ),
              signal,
              'authorization',
              AUTH_TIMEOUT_MS,
            );
            if (result.error === 'access_denied') {
              this.log.info('sign-in cancelled in browser');
              return;
            }
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
              resource: this.deployment.resource,
            });
            const resp = await fetch(endpoints.tokenUri, {
              method: 'POST',
              redirect: 'error',
              signal: requestSignal(),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            });
            if (!resp.ok) {
              throw new Error(`token HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
            }
            const tok: TokenSet = {
              ...readTokenResponse(await resp.json(), clientId),
              client_id: clientId,
              _issuer: endpoints.issuer,
            };
            signal.throwIfAborted();
            tok.client_id = clientId;
            tok._got_at = Date.now() / 1000;
            await this.store.saveRecoveryKey(clientId, base64url(crypto.randomBytes(32)));
            tok._refresh_recovery = true;
            await this.store.save(tok);
            this.signInNoticeShown = false;
            this.log.info('signed in; token stored; asked VS Code to pick up new credentials');
            this.changeEmitter.fire();
            vscode.window.showInformationMessage('Remote Device Hub: signed in');
          } finally {
            cb.close();
          }
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted && isAbortError(signal.reason)) {
        this.log.info('sign-in cancelled');
        return;
      }
      this.log.error(`sign-in failed: ${msg(e)}`);
      vscode.window.showErrorMessage(`Remote Device Hub: sign-in failed - ${msg(e)}`);
    } finally {
      clearTimeout(deadline);
      cancel.dispose();
      this.signInAbort = undefined;
    }
  }

  async signOut(): Promise<void> {
    this.signInAbort?.abort();
    await this.signInInflight?.catch((e) => this.log.debug(`previous sign-in ended: ${msg(e)}`));
    let revocationFailed = false;
    await withCredentialLock(this.scope, async () => {
      await this.store.recordAuthHistory({ signed_out_at: Date.now() });
      let clientId: string | undefined;
      let credentialIssuer: string | undefined;
      let revocation: RevocationCredential | undefined;
      try {
        const saved = await this.store.readRevocation();
        if (saved) {
          clientId = saved.clientId;
          credentialIssuer = saved.issuer;
          if (!saved.credential) {
            throw new Error('No saved token to revoke');
          }
          revocation = saved.credential;
        }
      } catch {
        revocationFailed = true;
        // Errors and response bodies can contain credentials. Keep logs generic.
        this.log.warn('server authorization revocation was not confirmed');
      } finally {
        this.pendingTokenSave = undefined;
        // Persist local sign-out before waiting for the network, so closing VS
        // Code during a slow request cannot restore this account on the next run.
        const replaced = await this.store.clearForClient(clientId);
        if (replaced) {
          this.log.info('sign-out preserved a newer sign-in from another host');
        }
      }
      if (clientId && revocation) {
        try {
          const endpoints = await this.getAuthEndpoints();
          if (!credentialIssuer || credentialIssuer !== endpoints.issuer || !endpoints.revokeUri) {
            throw new Error('The saved issuer cannot be safely revoked');
          }
          const response = await fetch(endpoints.revokeUri, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, ...revocation }).toString(),
          });
          this.log.info(`token revocation: HTTP ${response.status}`);
          await response.body?.cancel();
          if (response.status !== 200) {
            throw new Error('Revocation was not acknowledged');
          }
        } catch {
          revocationFailed = true;
          this.log.warn('server authorization revocation was not confirmed');
        }
      }
    });
    this.log.info(
      `signed out; ${revocationFailed ? 'server revocation unconfirmed' : 'server revocation complete or no saved credentials'}`,
    );
    this.changeEmitter.fire();
    if (revocationFailed) {
      void vscode.window.showWarningMessage(
        "Remote Device Hub: signed out locally, but server revocation could not be confirmed. Revoke this connection in the Hub's account settings if it may have been compromised.",
      );
    } else {
      void vscode.window.showInformationMessage('Remote Device Hub: signed out');
    }
  }

  async showStatus(): Promise<void> {
    let t: TokenSet | undefined;
    try {
      t = await this.getAcceptedToken();
    } catch (e) {
      this.log.warn(`status check failed: ${msg(e)}`);
      if (e instanceof CredentialError) {
        this.offerSignIn(e.message);
      } else {
        void vscode.window.showWarningMessage(
          `Remote Device Hub: could not check sign-in status - ${msg(e)}`,
        );
      }
      return;
    }
    if (!t) {
      const pick = await vscode.window.showWarningMessage(
        'Remote Device Hub: not signed in',
        'Sign In',
      );
      if (pick === 'Sign In') {
        await this.signIn(true);
      }
      return;
    }
    const secs = Math.max(
      0,
      Math.round((t._got_at ?? 0) + (t.expires_in ?? 0) - Date.now() / 1000),
    );
    this.log.info(`status: signed in, token expires in ${secs}s`);
    vscode.window.showInformationMessage(
      `Remote Device Hub: signed in, token auto-refreshes (expires in ${secs}s)`,
    );
  }

  offerSignIn(reason: string): void {
    this.log.warn(`sign-in requires user action: ${reason}`);
    if (this.signInNoticeShown) {
      return;
    }
    this.signInNoticeShown = true;
    void Promise.resolve(
      vscode.window.showWarningMessage(`Remote Device Hub: ${reason}`, 'Sign In'),
    )
      .then((pick) => {
        if (pick === 'Sign In') {
          return this.signIn(true);
        }
      })
      .catch((e) => this.log.error(`sign-in action failed: ${msg(e)}`));
  }
}

function isExpiring(t: TokenSet): boolean {
  return Date.now() >= tokenExpiresAt(t) - REFRESH_MARGIN_S * 1000;
}

function tokenExpiresAt(t: TokenSet): number {
  return ((t._got_at ?? 0) + (t.expires_in ?? 3600)) * 1000;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === 'AbortError';
}
