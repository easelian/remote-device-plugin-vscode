# remote-device-vscode

Remote Device Hub 的 VS Code 扩展（**MVP 脚手架，待评审**）。

使用流程：安装扩展并 Reload → 自动打开浏览器授权 → “Remote Device Hub” MCP
服务器自动出现在 VS Code，供 Copilot Chat / Agent 使用（设备文件、Shell、进程等 22 个工具）。

## 为什么需要扩展（而不是只发一段 mcp.json）

- VS Code 原生 MCP OAuth 依赖 `vscode.dev/redirect` + 本机 `127.0.0.1:33418`，
  在远程开发 / 受限网络（本项目的实际使用环境）下不可达（已实测）；
- 服务端令牌 1 小时过期 + 轮换 / 重放保护：静态 mcp.json 无法自动刷新，多消费者会互抢（已实测）；
- 扩展自己完成认证与刷新（唯一令牌消费者），把最新令牌注入 MCP 服务器定义，首次在浏览器中授权，之后自动刷新。

## 认证流程（按服务端当前能力设计，**无需服务端改动**）

1. 扩展优先运行在本地；仅安装在 SSH 端时也可运行在远端。扩展在所在主机的`127.0.0.1` 随机端口起一个一次性回调服务；
2. `vscode.env.asExternalUri` 把它转成浏览器可达地址（远程场景自动建立端口隧道）；
3. 动态注册客户端（DCR）→ 打开浏览器完成 Google 授权（PKCE）→ 回调收到 code → 换 token；
4. 令牌存 `SecretStorage`；过期前自动 refresh；变更时 `onDidChangeMcpServerDefinitions` 通知。
5. MCP 启动前发送无副作用的 `ping` 检查令牌。收到 401/403 时先刷新，无法恢复则自动打开浏览器重新授权；检查失败时不启动 MCP。

> ✅ 已验证（2026-10-12）：服务端回调白名单接受 `http://127.0.0.1:<任意端口>/callback`（HTTP 201）。

## MCP 服务器如何被启动（自动启动机制）

VS Code 不允许扩展在安装后立即强制启动 MCP 服务器；正确且唯一的机制是：

1. 扩展激活（`onStartupFinished`）后注册 `lm.registerMcpServerDefinitionProvider`，服务器出现在 MCP 服务器列表；
2. **提交聊天消息时** VS Code 执行自动启动扫描（设置 `chat.mcp.autostart`，默认 `newAndOutdated`：启动“从未运行过”的服务器；被禁用或处于错误状态的服务器会被跳过）；
3. 首次启动弹出信任确认（扩展提供的服务器属于独立信任来源，与工作区信任分离）；
4. 启动前回调 `resolveMcpServerDefinition`：扩展在此确保有有效令牌（否则自动打开浏览器登录），返回带最新 Authorization 的定义后服务器才会真正连接。

扩展激活时先向 MCP 服务检查保存的令牌；令牌缺失或被拒绝且刷新失败时，会直接调用浏览器登录流程，无需执行 `Sign In` 命令。通过聊天（包括 `@` 选择代理后发起需要设备工具的请求）或 MCP 列表启动服务器时，也会检查凭据并按需自动登录；仅输入 `@` 字符不会触发扩展认证。

本地 VS Code：安装 VSIX 后执行 `Developer: Reload Window`，在自动打开的浏览器中授权。
Remote SSH：建议在客户端本地安装；扩展声明 `extensionKind: ["ui", "workspace"]`，优先运行在本地。若仅在 SSH 端安装，则由 `asExternalUri` 转发回调端口，`openExternal` 仍请求客户端打开浏览器，不调用 SSH 服务器上的浏览器程序。

激活、MCP 启动和手动命令同时触发时，共用一次登录，避免重复打开网页。登录进度通知支持取消；取消后本次 MCP 启动停止，后续再次启动可重新授权。浏览器 API 返回失败时可选择 `Copy Link`，在客户端浏览器打开链接。`Sign In` 命令保留为手动重试入口。

若仍看到 VS Code 自带的 MCP OAuth 提示，先在 `MCP: List Servers` 中核对服务器来源是否为本扩展；另行配置在 `mcp.json` 中的同名服务器不经过扩展登录流程。运行中的连接若被服务端撤销凭据，需要停止并重新启动，让扩展重新检查令牌。

排查“没有自动启动”：

- `Remote Device Hub: Show Status` 确认已登录；
- 命令面板 `MCP: List Servers` 查看服务器状态，可直接 Start / Show Output；
- 若首次信任弹窗被拒绝：命令面板 `MCP: Reset Trust` 重置后再启动；
- 若 `chat.mcp.autostart` 被设为 `never`，需手动 Start（或改回默认）；
- 扩展侧诊断日志：命令面板 `Remote Device Hub: Show Logs`。

> ⚠️ 扩展提供的 MCP 服务器目前仅在运行该扩展的编辑器窗口的会话中可用；
> Agents window（Agent Host 会话）的 MCP 配置来源是工作区 `.mcp.json` 与用户 `~/.copilot/mcp-config.json`（该场景的分发见“待办”）。

## 开发

```bash
npm install
npm run compile     # 或 npm run watch
npm test            # 需要允许监听本机 127.0.0.1 临时端口
```

按 `F5` 启动扩展开发宿主；未登录时应自动打开授权页。回归测试使用模拟的 VS Code API 和认证响应、真实 HTTP 回调，以及不同端口间的转发；不使用真实账号，也不代替实际 Remote SSH 窗口中的浏览器验收。

## 目录

| 文件 | 说明 |
|---|---|
| `src/extension.ts` | 全部逻辑（认证 / 令牌管理 / MCP 提供器） |
| `.vscode/launch.json` | F5 调试配置 |
| `package.json` | `contributes.mcpServerDefinitionProviders` + 命令 |

## 待办（评审后推进）

- [ ] publisher / name 确认（当前占位 `xdistribute` / `remote-device-hub`）与版本策略
- [ ] 图标、中英文文案、i18n（当前 UI 字符串为英文，注释中文）
- [ ] 设置项改为 `contributes.configuration`（服务地址、是否走 :8090 直连等）
- [ ] 远程场景实测：Remote-SSH（浏览器在客户端 + 扩展宿主在远端，验证 asExternalUri 隧道）
- [ ] 打包发布：`vsce package` → 挂到 RDH 服务 `downloads` 目录 / Marketplace / Open VSX
- [ ] （服务端, 可选）`device_code` 流程：无浏览器 / CI 环境兜底
- [ ] Agents window：为 Agent Host 会话提供 `.mcp.json` / `~/.copilot/mcp-config.json` 分发路径
- [ ] （后续版本）设备树视图、状态栏、每设备快捷操作

## 已知限制（MVP）

- 启动前的令牌检查面向当前无状态 HTTP MCP 服务；不保证已经运行的连接即时接收刷新后的凭据。服务端撤销令牌后需重新启动 MCP。
- 同一窗口内多工作区共享同一份令牌（符合"单消费者"设计）

## 构建记录

- `remote-device-hub-0.0.5.vsix`：Reload 后也执行服务端凭据检查；记录跳过授权的原因，与 MCP 启动共享在途检查。

- `remote-device-hub-0.0.4.vsix`：自动触发浏览器授权、启动前检查失效令牌、合并并发登录、取消与超时处理、本地优先及 SSH 回调转发支持。

- `remote-device-hub-0.0.3.vsix`：2026-10-12 构建（v0.0.3 新增：输出日志通道 + `Remote Device Hub: Show Logs` 命令；`provide`/`resolve` 启动链路容错与日志；README 补充自动启动机制与排查指南），使用 npm 标准流程构建。
- `remote-device-hub-0.0.2.vsix`：2026-10-12 构建（v0.0.2 新增“激活时未登录即主动提示登录”），已通过 `code-server --install-extension` 安装验证。
- 构建环境：npm 已在本环境恢复可用（npm 10.9.0 / node v22.11.0），标准流程 `npm install && npm run compile && npm run package:vsix` 工作正常；
  此前“无 npm 构建”（npmmirror 摊平依赖 + 手工打包）已不再需要。
