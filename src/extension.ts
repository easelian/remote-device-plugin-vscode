/**
 * Remote Device Hub · VS Code 扩展 (MVP 脚手架)
 *
 * 目标: 安装扩展 -> "RDH: Sign In" 登录一次 -> "Remote Device Hub" MCP 服务器
 * 自动出现在 VS Code, 供 Copilot Chat / Agent 使用 (设备文件 / Shell / 进程工具)。
 *
 * 核心设计 (评审重点):
 *  1. 认证由扩展自己完成: 本机(或远端扩展宿主)起一次性 loopback 回调服务,
 *     用 vscode.env.asExternalUri 转为浏览器可达地址 (远程场景自动隧道),
 *     完全绕开 VS Code 原生 MCP OAuth 的 vscode.dev/redirect + 127.0.0.1:33418 链条。
 *     - 已验证 (2026-10-12): 服务端 DCR 白名单接受 http://127.0.0.1:<任意端口>/callback (HTTP 201)。
 *  2. 令牌存 SecretStorage; 扩展是唯一令牌消费者, 过期前自动刷新,
 *     与服务端 refresh token 轮换 + 重放保护设计匹配。
 *  3. 通过 lm.registerMcpServerDefinitionProvider 动态提供 McpHttpServerDefinition,
 *     以 headers 注入最新 Authorization; 令牌变化时触发 onDidChangeMcpServerDefinitions。
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as http from 'http';

// ================= 可按部署环境调整 =================
const AUTH_BASE = 'https://mcp.xdistribute.site';       // OAuth: register / authorize / token
const MCP_URI = 'https://xdistribute.site:8090/mcp';    // 数据面 MCP 端点 (直连源站优先)
const RESOURCE = 'https://mcp.xdistribute.site/mcp';
const SCOPE = 'devices:control';

const PROVIDER_ID = 'xdistribute.remote-device-hub';
const SERVER_LABEL = 'Remote Device Hub';
const SECRET_KEY = 'rdh.tokens.v1';
const REFRESH_MARGIN_S = 180;               // 过期前 180s 开始刷新
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 保活检查间隔
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;      // 授权等待上限
const REQUEST_TIMEOUT_MS = 30 * 1000;

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  _got_at?: number;   // 获取时间 (epoch 秒)
  client_id: string;
}

let changeEmitter: vscode.EventEmitter<void>;
let refreshInflight: Promise<TokenSet | undefined> | undefined;
let log: vscode.LogOutputChannel;
let signInInflight: Promise<void> | undefined;
let signInAbort: AbortController | undefined;
let credentialCheckInflight: Promise<TokenSet | undefined> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  changeEmitter = new vscode.EventEmitter<void>();
  log = vscode.window.createOutputChannel('Remote Device Hub', { log: true });

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('rdh.signIn', () => signIn(context)),
    vscode.commands.registerCommand('rdh.signOut', () => signOut(context)),
    vscode.commands.registerCommand('rdh.showStatus', () => showStatus(context)),
    vscode.commands.registerCommand('rdh.showLogs', () => log.show(true)),
    new vscode.Disposable(() => signInAbort?.abort()),
    changeEmitter,
  );

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: async () => {
      // VS Code 在提交聊天消息时的自动启动扫描 (chat.mcp.autostart) 或 MCP 视图中询问服务器定义。
      // 即使未登录也返回定义: 服务器会出现在列表中, 真正启动时走 resolve 引导登录。
      try {
        const t = await getToken(context, false);
        log.debug(t
          ? 'definition provided with a valid token'
          : 'definition provided without a token (sign-in will be requested when the server starts)');
        return [makeServer(t)];
      } catch (e) {
        log.error(`provideMcpServerDefinitions failed: ${msg(e)}`);
        return [makeServer()];
      }
    },
    resolveMcpServerDefinition: async () => {
      // VS Code 即将启动服务器时回调: 确保有有效令牌, 否则引导登录后再放行
      try {
        let t = await getAcceptedToken(context);
        if (!t) {
          log.info('server start requested without accepted credentials; opening sign-in automatically');
          await signIn(context);
          t = await getToken(context, false);
          if (!t) {
            log.error('sign-in finished without a usable token; MCP server will not start');
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
        return undefined;
      }
    },
  };
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
  log.info('MCP server definition provider registered; VS Code starts the server on demand (chat / MCP view).');

  // 保活刷新 (惰性刷新兜底)
  const timer = setInterval(() => {
    log.debug('keep-alive token check');
    void getToken(context, false);
  }, REFRESH_INTERVAL_MS);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  // 安装后 Reload / 启动时直接进入登录，不要求用户再执行命令或点击 Sign In。
  log.info('activation: checking saved credentials with the MCP server');
  void getAcceptedToken(context).then((t) => {
    if (!t) {
      log.info('activated without a token; opening sign-in automatically');
      return signIn(context);
    } else {
      log.info('activation: server accepted saved credentials; browser sign-in is not needed');
    }
  }).catch((e) => {
    log.error(`automatic sign-in check failed: ${msg(e)}`);
    void vscode.window.showWarningMessage(`Remote Device Hub: could not check sign-in status - ${msg(e)}`);
  });
}

export function deactivate(): void { /* noop */ }

function makeServer(t?: TokenSet): vscode.McpHttpServerDefinition {
  return new vscode.McpHttpServerDefinition(
    SERVER_LABEL,
    vscode.Uri.parse(MCP_URI),
    t ? { Authorization: `Bearer ${t.access_token}` } : undefined,
  );
}

// ---------------------------------------------------------------- 令牌管理

async function getToken(context: vscode.ExtensionContext, interactive: boolean): Promise<TokenSet | undefined> {
  const raw = await context.secrets.get(SECRET_KEY);
  if (!raw) { return undefined; }
  let t: TokenSet;
  try { t = JSON.parse(raw) as TokenSet; } catch { return undefined; }
  if (!t || typeof t.access_token !== 'string' || !t.access_token
      || typeof t.client_id !== 'string' || !t.client_id) { return undefined; }
  if (!isExpiring(t)) { return t; }

  // 单飞刷新: 同一时刻只有一个刷新在途 (避免与轮换/重放保护冲突)
  const fresh = await refreshToken(context, t);
  if (!fresh && interactive) {
    vscode.window.showErrorMessage('Remote Device Hub: token refresh failed, please sign in again');
  }
  return fresh;
}

function refreshToken(context: vscode.ExtensionContext, t: TokenSet): Promise<TokenSet | undefined> {
  refreshInflight = refreshInflight ?? doRefresh(context, t).finally(() => { refreshInflight = undefined; });
  return refreshInflight;
}

function getAcceptedToken(context: vscode.ExtensionContext): Promise<TokenSet | undefined> {
  credentialCheckInflight ??= (async () => {
    let t = await getToken(context, false);
    if (t && !await acceptsToken(t)) {
      log.warn('MCP rejected saved credentials; trying token refresh');
      t = await refreshToken(context, t);
      if (t && !await acceptsToken(t)) { t = undefined; }
    }
    return t;
  })().finally(() => { credentialCheckInflight = undefined; });
  return credentialCheckInflight;
}

// 本地时间尚未过期不代表服务端仍接受令牌。先发无副作用的 MCP ping，
// 让失效凭据在扩展内恢复，避免启动后由 VS Code 的原生 OAuth 接管。
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
  if (resp.status === 401 || resp.status === 403) { return false; }
  if (!resp.ok) { throw new Error(`MCP credential check failed: HTTP ${resp.status}`); }
  return true;
}

function isExpiring(t: TokenSet): boolean {
  const got = t._got_at ?? 0;
  const exp = t.expires_in ?? 3600;
  return Date.now() / 1000 >= got + exp - REFRESH_MARGIN_S;
}

async function doRefresh(context: vscode.ExtensionContext, t: TokenSet): Promise<TokenSet | undefined> {
  if (!t.refresh_token) { return undefined; }
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.client_id,
      resource: RESOURCE,
    });
    const resp = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) { throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`); }
    const data = await resp.json() as Partial<TokenSet>;
    if (!data.access_token) { throw new Error('token response has no access_token'); }
    const next: TokenSet = {
      ...t,
      ...data,
      refresh_token: data.refresh_token ?? t.refresh_token,
      _got_at: Date.now() / 1000,
    };
    await context.secrets.store(SECRET_KEY, JSON.stringify(next));
    log.info('token refreshed; asked VS Code to pick up new credentials');
    changeEmitter.fire();
    return next;
  } catch (e) {
    log.warn(`token refresh failed (will retry later): ${msg(e)}`);
    console.error('[rdh] token refresh failed:', e);
    return undefined;
  }
}

// ---------------------------------------------------------------- 登录流程

function signIn(context: vscode.ExtensionContext): Promise<void> {
  if (!signInInflight) {
    signInInflight = Promise.resolve(vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Remote Device Hub: signing in',
      cancellable: true,
    }, (progress, cancellation) => runSignIn(context, progress, cancellation)))
      .then(() => undefined).finally(() => { signInInflight = undefined; });
  }
  return signInInflight;
}

async function runSignIn(
  context: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string }>,
  cancellation: vscode.CancellationToken,
): Promise<void> {
  const controller = new AbortController();
  signInAbort = controller;
  const cancel = cancellation.onCancellationRequested(() => controller.abort());
  if (cancellation.isCancellationRequested) { controller.abort(); }
  const deadline = setTimeout(() => controller.abort(new Error('sign-in timed out')), AUTH_TIMEOUT_MS);
  const signal = controller.signal;
  try {
    signal.throwIfAborted();
    progress.report({ message: 'Preparing browser callback…' });
    const cb = await startCallbackServer();
    log.info(`sign-in started; waiting for browser callback on 127.0.0.1:${cb.port}`);
    try {
      // asExternalUri: 远程场景自动建立端口隧道, 返回浏览器侧可达地址; 不要缓存结果
      const redirectUri = (await abortable(vscode.env.asExternalUri(
        vscode.Uri.parse(`http://127.0.0.1:${cb.port}/callback`)), signal, 'callback forwarding')).toString(true);

      // 1) 动态注册客户端 (RFC 7591)
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

      // 3) 打开浏览器授权
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

      // 4) 等待回调
      progress.report({ message: 'Complete authorization in your browser…' });
      const result = await abortable(cb.waitForCode(state, AUTH_TIMEOUT_MS), signal, 'authorization', AUTH_TIMEOUT_MS);
      if (result.error) {
        throw new Error(`${result.error} ${result.errorDescription ?? ''}`);
      }

      // 5) 换取令牌
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: result.code ?? '',
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      });
      const resp = await fetch(`${AUTH_BASE}/token`, {
        method: 'POST',
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
      await context.secrets.store(SECRET_KEY, JSON.stringify(tok));
      log.info('signed in; token stored; asked VS Code to pick up new credentials');
      changeEmitter.fire();
      vscode.window.showInformationMessage('Remote Device Hub: signed in');
    } finally {
      cb.close();
    }
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
  await signInInflight;
  await context.secrets.delete(SECRET_KEY);
  log.info('signed out; MCP server will request sign-in again on next start');
  changeEmitter.fire();
  vscode.window.showInformationMessage('Remote Device Hub: signed out');
}

async function showStatus(context: vscode.ExtensionContext): Promise<void> {
  const t = await getToken(context, true);
  if (!t) {
    const pick = await vscode.window.showWarningMessage(
      'Remote Device Hub: not signed in', 'Sign In');
    if (pick === 'Sign In') { await signIn(context); }
    return;
  }
  const secs = Math.max(0, Math.round((t._got_at ?? 0) + (t.expires_in ?? 0) - Date.now() / 1000));
  log.info(`status: signed in, token expires in ${secs}s`);
  vscode.window.showInformationMessage(
    `Remote Device Hub: signed in, token auto-refreshes (expires in ${secs}s)`);
}

// ---------------------------------------------------------------- 一次性回调服务

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

// ---------------------------------------------------------------- 工具

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
  return e instanceof Error ? e.message : String(e);
}
