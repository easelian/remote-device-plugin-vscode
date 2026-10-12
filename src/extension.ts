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

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  _got_at?: number;   // 获取时间 (epoch 秒)
  client_id: string;
}

let changeEmitter: vscode.EventEmitter<void>;
let refreshInflight: Promise<TokenSet | undefined> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  changeEmitter = new vscode.EventEmitter<void>();

  context.subscriptions.push(
    vscode.commands.registerCommand('rdh.signIn', () => signIn(context)),
    vscode.commands.registerCommand('rdh.signOut', () => signOut(context)),
    vscode.commands.registerCommand('rdh.showStatus', () => showStatus(context)),
  );

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: async () => {
      const t = await getToken(context, false);
      return [makeServer(t)];
    },
    resolveMcpServerDefinition: async () => {
      // 服务器即将启动: 确保有有效令牌, 否则引导登录
      let t = await getToken(context, false);
      if (!t) {
        const pick = await vscode.window.showWarningMessage(
          'Remote Device Hub: sign in to use this MCP server', 'Sign In');
        if (pick !== 'Sign In') { return undefined; }
        await signIn(context);
        t = await getToken(context, false);
        if (!t) { return undefined; }
      }
      return makeServer(t);
    },
  };
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));

  // 保活刷新 (惰性刷新兜底)
  const timer = setInterval(() => { void getToken(context, false); }, REFRESH_INTERVAL_MS);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  // 激活时若尚未登录, 主动提示一次 (AI 工具依赖登录)
  void getToken(context, false).then((t) => {
    if (!t) {
      void vscode.window.showInformationMessage(
        'Remote Device Hub: sign in to use device tools with AI agents',
        'Sign In',
      ).then((pick) => {
        if (pick === 'Sign In') { void signIn(context); }
      });
    }
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
  if (!isExpiring(t)) { return t; }

  // 单飞刷新: 同一时刻只有一个刷新在途 (避免与轮换/重放保护冲突)
  refreshInflight = refreshInflight ?? doRefresh(context, t).finally(() => { refreshInflight = undefined; });
  const fresh = await refreshInflight;
  if (!fresh && interactive) {
    vscode.window.showErrorMessage('Remote Device Hub: token refresh failed, please sign in again');
  }
  return fresh;
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) { throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`); }
    const data = await resp.json() as Partial<TokenSet>;
    const next: TokenSet = {
      ...t,
      ...data,
      refresh_token: data.refresh_token ?? t.refresh_token,
      _got_at: Date.now() / 1000,
    };
    await context.secrets.store(SECRET_KEY, JSON.stringify(next));
    changeEmitter.fire();
    return next;
  } catch (e) {
    console.error('[rdh] token refresh failed:', e);
    return undefined;
  }
}

// ---------------------------------------------------------------- 登录流程

async function signIn(context: vscode.ExtensionContext): Promise<void> {
  try {
    const cb = await startCallbackServer();
    try {
      // asExternalUri: 远程场景自动建立端口隧道, 返回浏览器侧可达地址; 不要缓存结果
      const redirectUri = (await vscode.env.asExternalUri(
        vscode.Uri.parse(`http://127.0.0.1:${cb.port}/callback`))).toString(true);

      // 1) 动态注册客户端 (RFC 7591)
      const reg = await fetch(`${AUTH_BASE}/register`, {
        method: 'POST',
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
      await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

      // 4) 等待回调
      const result = await cb.waitForCode(state, AUTH_TIMEOUT_MS);
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!resp.ok) { throw new Error(`token HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`); }
      const tok = await resp.json() as TokenSet;
      tok.client_id = clientId;
      tok._got_at = Date.now() / 1000;
      await context.secrets.store(SECRET_KEY, JSON.stringify(tok));
      changeEmitter.fire();
      vscode.window.showInformationMessage('Remote Device Hub: signed in');
    } finally {
      cb.close();
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Remote Device Hub: sign-in failed - ${msg(e)}`);
  }
}

async function signOut(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
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
          const timer = setTimeout(
            () => res({ error: 'timeout', errorDescription: 'no callback received' }), timeoutMs);
          void resultPromise.then((r) => {
            clearTimeout(timer);
            if (r.error || r.state === expectedState) { res(r); }
            else { res({ error: 'state_mismatch', errorDescription: 'state validation failed' }); }
          });
        }),
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------- 工具

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
