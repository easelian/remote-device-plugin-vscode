# Remote Device Hub for VS Code

Remote Device Hub is a VS Code extension for working with your authorized remote devices through Copilot Chat and MCP. This is an MVP pending review.

Install the extension and reload VS Code. If you need to sign in, the extension opens your browser automatically. Once authorized, you can use the device file, shell, and process tools through `@remote-device-hub` or the Remote Device Hub MCP server.

## Why use an extension?

- In earlier tests in this project's remote development environment, the built-in MCP OAuth redirect chain through `vscode.dev/redirect` and local port `127.0.0.1:33418` was unreachable.
- The deployed service uses one-hour access tokens, refresh token rotation, and replay protection. A static token in `mcp.json` cannot refresh itself, and competing refresh clients can invalidate one another's tokens.
- The extension manages sign-in and token refresh, then supplies the current Authorization header to its MCP server definition. You authorize access in your browser the first time; the extension handles subsequent refreshes.

## Authentication

The extension uses the service's existing authentication endpoints. No server changes are required for this flow.

Browser authorization and client registration use `https://mcp.xdistribute.site`. Token exchange uses `https://xdistribute.site:8090/token`; refresh uses `/token/refresh` on that same trusted origin. This keeps renewal traffic off the proxy route. Token requests reject redirects and never switch routes after an indeterminate result. An older server's definitive 404 on the first refresh request permits a fallback to its standard `/token` endpoint.

1. The extension runs in the workspace extension host (`extensionKind: ["workspace"]`), which on an SSH host is the remote host. This keeps it in the same extension host as language-model providers, so `@remote-device-hub` can resolve the selected chat model. It starts a temporary callback server on a random `127.0.0.1` port on its host.
2. `vscode.env.asExternalUri` makes the callback reachable from the client browser, forwarding the port when the extension runs remotely.
3. The extension registers an OAuth client dynamically, opens Google sign-in with PKCE, receives the authorization code, and exchanges it for tokens.
4. Tokens are stored in `SecretStorage`. Refresh is scheduled three minutes before the token expires, including when another window updates the credentials. Credential changes fire `onDidChangeMcpServerDefinitions`.
5. Before MCP startup, a side-effect-free `ping` checks whether the service accepts the token. A 401 triggers a refresh attempt. Permission errors, service failures, and rejected saved credentials do not automatically open browser sign-in. The MCP server does not start if the credential check fails.

A deployment test on October 12, 2026 confirmed that dynamic client registration accepted `http://127.0.0.1:<port>/callback` with HTTP 201.

## Startup and sign-in

The extension registers its MCP provider during activation with `lm.registerMcpServerDefinitionProvider`. VS Code controls when the MCP server starts, including on-demand startup from chat and manual startup from the MCP server list. The `chat.mcp.autostart` setting controls automatic startup; a disabled server or a server in an error state may require manual intervention. Complete any trust prompt that VS Code displays.

Before starting the server, VS Code calls `resolveMcpServerDefinition`. The extension checks credentials, refreshes them when needed, and returns a definition with the current Authorization header.

Activation also checks saved credentials with the service. A first installation opens browser sign-in automatically. A shared record prevents other windows or reloads from opening another browser after that attempt is canceled, times out, or fails. Existing credentials are renewed silently; if they cannot be renewed, use `Remote Device Hub: Sign In` to reconnect. MCP startup and chat show a `Sign In` action when saved credentials need attention. Typing `@` alone does not start authentication.

Refresh tokens are single-use. New sign-ins create a client recovery key in a separate SecretStorage entry. Before refreshing, the extension saves a pending marker and a proof derived from that private key and the refresh token. A server that supports `/token/refresh` can return the saved result of the same operation after a lost response, reload, or process restart. The extension retries recovery in the background without browser sign-in. If only saving the response failed, the running extension retries saving it without another network request. Legacy credentials retain their original refresh flow until the next explicit sign-in. If a legacy response was lost or the service has already revoked the grant, use `Sign In` to reconnect. Logs omit private keys, proofs, and token values.

**Local VS Code:** Install the VSIX, run `Developer: Reload Window`, and complete authorization in your browser if prompted.

**Remote SSH:** The extension declares `extensionKind: ["workspace"]` and runs on the SSH host. `vscode.env.asExternalUri` forwards the callback port and `openExternal` asks the client to open the browser. The extension does not launch a browser on the SSH host. Running on the SSH host also keeps it in the same extension host as chat model providers, so the `@remote-device-hub` participant can use the selected model.

Activation, MCP startup, and manual sign-in share one pending login flow. A host-level lock coordinates windows on the same extension host. A canceled or timed-out login requires an explicit `Sign In` retry; queued windows do not start another browser flow. Signing out also suppresses automatic sign-in after reload. If the browser API reports failure, choose `Copy Link` and open the link in your local browser.

The loopback lock coordinates windows on one host. Hosts using the same VS Code SecretStorage share the private recovery key and derive the same proof for a refresh; the server serializes the operation and returns one rotation result to each host. An old token pair alone cannot derive that proof. Keep older extension versions from running alongside this version: they do not use recovery and can replay consumed tokens.

If VS Code still displays its built-in MCP OAuth prompt, check the server's source in `MCP: List Servers`. A separate entry in `mcp.json`, even with the same name, does not use this extension's sign-in flow. If the service revokes credentials for a running connection, stop and restart that server so the extension can check them again.

If the MCP server does not start:

- Run `Remote Device Hub: Show Status` to check your sign-in status.
- Open `MCP: List Servers` and use **Start** or **Show Output**.
- If you declined a trust prompt, use `MCP: Reset Trust` and try again.
- If `chat.mcp.autostart` is set to `never`, start the server manually or change that setting.
- Run `Remote Device Hub: Show Logs` for extension diagnostics.

The extension's MCP provider is available in the editor window running the extension. Separate Agent Host sessions in the Agents window use their own configuration, including workspace `.mcp.json` and user `~/.copilot/mcp-config.json`. Support for distributing those configurations is still planned.

## Use Remote Device Hub in Copilot Chat

Install the latest VSIX and run `Developer: Reload Window`. In Copilot Chat, type `@remote-device-hub` and select it from the suggestions. Then describe your task:

- `@remote-device-hub List my authorized devices.`
- `@remote-device-hub Check free disk space on device kylin-pc-a5704092.` Replace the example ID with one returned for your account. Shell commands require confirmation before they run.

There is one chat entry point: `@remote-device-hub`. No slash commands are required. The gray placeholder shows examples; pressing Tab does not insert that text. An empty request displays a brief input hint if the client allows it to be sent.

The chat participant shares the extension's authentication and token refresh logic and connects directly to the same RDH MCP service. You do not need to enable the server in the Agent mode tool picker first. Regular Agent mode can still use the existing MCP provider.

Natural-language requests use the model selected in the chat window. That model must support tool calling. Recent text exchanges with this participant provide context for follow-up requests, while tools retrieve current device information. Writes, shell commands, and operations outside the read-only allowlist require confirmation. Declining stops the request. Network failures do not automatically replay tool calls, and canceling chat does not undo operations already sent to a device.

The chat client targets RDH's stateless Streamable HTTP configuration with JSON responses; it is not a general-purpose MCP client. Tests cover simulated models, authentication responses, and MCP requests. Completion suggestions and actual model calls still need verification in the Copilot client.

## Development

```bash
npm install
npm run compile     # Or use npm run watch during development
npm test            # Requires permission to listen on temporary 127.0.0.1 ports
npm run package:vsix
```

Press `F5` to launch the Extension Development Host. If you are not signed in, the browser authorization page should open automatically. Regression tests use simulated VS Code APIs and authentication responses, real HTTP callbacks, and forwarding between different local ports. They do not use real accounts or replace browser testing in an actual Remote SSH session.

## Project layout

| File | Purpose |
|---|---|
| `src/extension.ts` | Authentication, token management, and the MCP provider |
| `src/chat.ts` | Chat participant, model tool calls, and the MCP HTTP client |
| `.vscode/launch.json` | F5 launch configuration |
| `package.json` | Extension metadata, MCP provider, chat participant, and commands |

## Planned work

- [ ] Confirm the publisher, extension name, and versioning policy. The current identifiers are `xdistribute` and `remote-device-hub`.
- [ ] Add an icon and localization support. Documentation, comments, and UI text currently use American English.
- [ ] Expose deployment settings through `contributes.configuration`, including service URLs and direct connections on port 8090.
- [ ] Test an actual Remote SSH session with a client-side browser and a remote extension host, including the `asExternalUri` tunnel.
- [ ] Publish VSIX packages through the RDH service's `downloads` directory, Marketplace, or Open VSX.
- [ ] Consider a server-side `device_code` flow for environments without a browser, including CI.
- [ ] Provide `.mcp.json` and `~/.copilot/mcp-config.json` configuration for Agent Host sessions.
- [ ] Add a device tree, status bar integration, and per-device actions in a later release.

## Known limitations

- Credential checks target the current stateless HTTP MCP service. An existing connection is not guaranteed to pick up refreshed credentials immediately. Restart MCP if the service revokes its token.
- Workspaces in the same window share stored credentials. Refresh coordination is scoped to the extension host.
- The `@remote-device-hub` chat participant can only use chat models whose provider extension runs in the same extension host. `extensionKind: ["workspace"]` keeps the extension alongside model providers in remote windows; a model from a provider in another extension host fails with "The selected model ... is not available."

## Build history

- `remote-device-hub-0.0.9.vsix`: Updated documentation, comments, UI text, model instructions, and test fixtures to American English.
- `remote-device-hub-0.0.8.vsix`: Kept one `@remote-device-hub` entry point, removed slash commands and follow-up buttons, and added natural-language examples to the input hint.
- `remote-device-hub-0.0.7.vsix`: Added clearer input guidance, `/help`, empty-request guidance, and suggested follow-ups. These additional controls were removed in 0.0.8.
- `remote-device-hub-0.0.6.vsix`: Added `@remote-device-hub` and `/devices`, sharing authentication and supporting model tool calls, confirmation, and cancellation.
- `remote-device-hub-0.0.5.vsix`: Added server-side credential checks after reload, logged why sign-in was skipped, and shared pending checks with MCP startup.
- `remote-device-hub-0.0.4.vsix`: Added automatic browser sign-in, checks for rejected credentials before startup, shared sign-in requests, cancellation, timeouts, and support for local execution and SSH callback forwarding.
- `remote-device-hub-0.0.3.vsix`: Built on October 12, 2026 using npm. Added the output channel and `Remote Device Hub: Show Logs`, provider error handling and logging, and startup troubleshooting documentation.
- `remote-device-hub-0.0.2.vsix`: Built on October 12, 2026. Added a sign-in prompt on activation when no credentials were available. Installation was verified with `code-server --install-extension`.

The recorded build environment uses npm 10.9.0 and Node.js 22.11.0. Standard npm installation, compilation, and packaging are available. The earlier workaround using an npm mirror and manual packaging is no longer needed.
