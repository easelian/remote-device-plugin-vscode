# remote-device-vscode

Remote Device Hub 的 VS Code 扩展（**MVP 脚手架，待评审**）。

目标：安装扩展 → `Remote Device Hub: Sign In` → 登录一次 → “Remote Device Hub” MCP
服务器自动出现在 VS Code，供 Copilot Chat / Agent 使用（设备文件、Shell、进程等 22 个工具）。

## 为什么需要扩展（而不是只发一段 mcp.json）

- VS Code 原生 MCP OAuth 依赖 `vscode.dev/redirect` + 本机 `127.0.0.1:33418`，
  在远程开发 / 受限网络（本项目的实际使用环境）下不可达（已实测）；
- 服务端令牌 1 小时过期 + 轮换 / 重放保护：静态 mcp.json 无法自动刷新，多消费者会互抢（已实测）；
- 扩展自己完成认证与刷新（唯一令牌消费者），把最新令牌注入 MCP 服务器定义，全程零手工。

## 认证流程（按服务端当前能力设计，**无需服务端改动**）

1. 扩展在本机（或远端扩展宿主）`127.0.0.1` 随机端口起一个一次性回调服务；
2. `vscode.env.asExternalUri` 把它转成浏览器可达地址（远程场景自动建立端口隧道）；
3. 动态注册客户端（DCR）→ 打开浏览器完成 Google 授权（PKCE）→ 回调收到 code → 换 token；
4. 令牌存 `SecretStorage`；过期前自动 refresh；变更时 `onDidChangeMcpServerDefinitions` 通知。

> ✅ 已验证（2026-10-12）：服务端回调白名单接受 `http://127.0.0.1:<任意端口>/callback`（HTTP 201）。

## 开发

```bash
npm install
npm run compile     # 或 npm run watch
```

按 `F5` 启动扩展开发宿主调试；命令面板执行 `Remote Device Hub: Sign In`。

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
- [ ] （后续版本）设备树视图、状态栏、每设备快捷操作

## 已知限制（MVP）

- token 在服务器上报错前不会主动感知失效；失败时重新 Sign In 即可
- 同一窗口内多工作区共享同一份令牌（符合"单消费者"设计）

## 构建记录

- `remote-device-hub-0.0.2.vsix`：2026-10-12 构建（v0.0.2 新增“激活时未登录即主动提示登录”），已通过 `code-server --install-extension` 安装验证。
- 构建环境备注：npm 在本环境不可用（本机 npm 11.19 拉取首个 manifest 即崩溃；设备端解析大依赖树长时间停滞），
  因此采用“无 npm 构建”：
  1. 从 npmmirror 直接下载 `typescript` / `@types/vscode` / `@types/node` / `undici-types` 摊平到 `node_modules/`；
  2. `node node_modules/typescript/bin/tsc -p ./` 编译到 `out/`；
  3. Python 按 VSIX 规范打包（`[Content_Types].xml` + `extension.vsixmanifest` + `extension/**`）。
- 后续建议：npm 修复后回归标准流程 `npm install && npm run package:vsix`。
