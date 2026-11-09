# Remote Device Hub for VS Code

![Easelian](resources/icon.png)

Remote Device Hub by Easelian is a VS Code extension for working with your authorized remote devices through Copilot Chat and MCP.

[Remote Device Hub](https://rdh.easelian.com) · [Source](https://github.com/easelian/remote-device-plugin-vscode) · [Report an issue](https://github.com/easelian/remote-device-plugin-vscode/issues)

The extension ID is `easelian.remote-device-hub`. It requires VS Code 1.105 or later.

Install the extension and reload VS Code. Before opening browser sign-in, the extension explains why it needs access to your Remote Device Hub account. Choose **Continue** to proceed, or cancel to leave it disconnected. Once authorized, you can use the device file, shell, and process tools through `@remote-device-hub` or the Remote Device Hub MCP server.

## Capabilities

- Browser sign-in with OAuth PKCE and automatic token refresh.
- An authenticated MCP provider for device file, shell, and process tools.
- A single `@remote-device-hub` chat participant with per-call confirmation or explicitly scoped automatic execution.
- Local and Remote SSH operation through the workspace extension host.

## Authentication

Sign-in uses OAuth with PKCE. Recovery after a lost refresh response requires the Hub's `/token/refresh` endpoint.

MCP transport and the OAuth resource use `/mcp` at the configured MCP origin, which defaults to `https://rdh.easelian.com`. The extension discovers the authorization server and its endpoints from the MCP resource metadata. The website also defaults to `https://rdh.easelian.com`. Token requests reject redirects and never switch routes after an indeterminate result. A definitive 404 on the first recovery request permits a fallback to the advertised token endpoint.

The resource metadata must identify one origin-based issuer. The authorization, registration, token, refresh-recovery, and revocation endpoints, when advertised, must use that issuer's origin.

Deployment settings belong in **User** or **Remote** settings. Workspace and folder settings cannot redirect credentials:

```json
{
  "remoteDeviceHub.publicUrl": "https://rdh.easelian.com",
  "remoteDeviceHub.mcpPublicUrl": "https://rdh.easelian.com"
}
```

Empty values use the packaged defaults from `src/deploymentDefaults.ts`. Both settings accept origins only: no paths, query strings, fragments, or embedded credentials. HTTPS is required; HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development servers. `publicUrl` identifies the website. `mcpPublicUrl` selects the MCP resource, which identifies the authorization server.

Reload the window after changing deployment settings. Until reload, all requests in that window continue using the active deployment. Sign out before changing deployments if you also want to revoke that deployment's grant. Each MCP origin has separate saved tokens, sign-in state, and refresh recovery keys. Saved credentials are also bound to the discovered issuer; if the issuer changes or the saved credentials do not identify one, use **Remote Device Hub: Sign In** to reconnect. The extension does not send those credentials to the new issuer.

1. The extension runs in the workspace extension host (`extensionKind: ["workspace"]`), which on an SSH host is the remote host. This keeps it in the same extension host as language-model providers, so `@remote-device-hub` can resolve the selected chat model. It starts a temporary callback server on a random `127.0.0.1` port on its host.
2. `vscode.env.asExternalUri` makes the callback reachable from the client browser, forwarding the port when the extension runs remotely.
3. The extension registers an OAuth client dynamically with the discovered Auth service, opens sign-in with PKCE, validates the callback, and exchanges the authorization code for tokens. The Auth service must allow the callback URI, including any URI produced by Remote SSH forwarding.
4. Tokens are stored in `SecretStorage`. Refresh is scheduled three minutes before the token expires, including when another window updates the credentials. Credential changes fire `onDidChangeMcpServerDefinitions`.
5. Before MCP startup, a side-effect-free `ping` checks whether the service accepts the token. A 401 triggers a refresh attempt. Permission errors, service failures, and rejected saved credentials do not automatically open browser sign-in. The MCP server does not start if the credential check fails.

## Startup and sign-in

The extension registers its MCP provider during activation with `lm.registerMcpServerDefinitionProvider`. VS Code controls when the MCP server starts, including on-demand startup from chat and manual startup from the MCP server list. The `chat.mcp.autostart` setting controls automatic startup; a disabled server or a server in an error state may require manual intervention. Complete any trust prompt that VS Code displays.

Before starting the server, VS Code calls `resolveMcpServerDefinition`. The extension checks credentials, refreshes them when needed, and returns a definition with the current Authorization header.

Activation checks saved credentials with the service. When no sign-in has been attempted, the extension first explains that Remote Device Hub is Easelian’s remote-device service and that connecting your account enables access to authorized devices, permitted files, and enabled commands and processes. Device restrictions still apply, and signing in does not pair a new device. Choose **Continue** to open browser sign-in, where you can authorize or decline access. Canceling the explanation opens no browser. A shared record prevents other windows or reloads from repeating the prompt or browser flow after cancellation, timeout, or failure. Use **Remote Device Hub: Sign In** to retry; each new browser sign-in requires confirmation. Existing credentials are renewed silently; if they cannot be renewed, use `Remote Device Hub: Sign In` to reconnect. MCP startup and chat show a `Sign In` action when saved credentials need attention. Typing `@` alone does not start authentication.

Refresh tokens are single-use. Sign-in creates a client recovery key in a separate SecretStorage entry. Before refreshing, the extension saves a pending marker and a proof derived from that private key and the refresh token. A server that supports `/token/refresh` can return the saved result of the same operation after a lost response, reload, or process restart. The extension retries recovery in the background without browser sign-in. If only saving the response failed, the running extension retries saving it without another network request. Credentials without recovery metadata use `/token` and cannot recover a lost refresh response. If recovery is unavailable or the service has revoked the grant, use `Sign In` to reconnect. Logs omit private keys, proofs, and token values.

**Local VS Code:** Install the VSIX, run `Developer: Reload Window`, and complete authorization in your browser if prompted.

**Remote SSH:** The extension declares `extensionKind: ["workspace"]` and runs on the SSH host. `vscode.env.asExternalUri` forwards the callback port and `openExternal` asks the client to open the browser. The extension does not launch a browser on the SSH host. Running on the SSH host also keeps it in the same extension host as chat model providers, so the `@remote-device-hub` participant can use the selected model.

Activation, MCP startup, and manual sign-in share one pending login flow. A host-level lock coordinates windows on the same extension host. A canceled or timed-out login requires an explicit `Sign In` retry; queued windows do not start another browser flow. Signing out also suppresses automatic sign-in after reload. If the browser API reports failure, choose `Copy Link` and open the link in your local browser.

`Remote Device Hub: Sign Out` records local sign-out, removes local tokens and the private recovery key, and asks the trusted Hub's `/revoke` endpoint to revoke the saved authorization. Local cleanup happens before waiting for the response, so closing VS Code during a slow request cannot restore the old sign-in. Sign-out shares the credential lock with refresh, so it revokes the latest saved credentials without refreshing them first. If the server cannot acknowledge revocation, a warning explains that server revocation is unconfirmed. Use the Hub's account settings to revoke the connection if credentials may have been compromised. A newer account signed in by another host while revocation is in flight is preserved.

Refresh is initiated by the extension, not pushed by the server. While the extension host is active, its timer refreshes credentials without chat activity. When VS Code is closed, refresh stops; the next activation can use a valid refresh token even if the one-hour access token has expired. The current Hub gives refresh tokens a 30-day lifetime and also expires the authorization grant 30 days after initial sign-in. Refresh does not extend that grant deadline. The recovery cache's separate 24-hour limit only applies to retrieving the result of an interrupted rotation.

The loopback lock coordinates windows on one host. Hosts using the same VS Code SecretStorage share the private recovery key and derive the same proof for a refresh; the server serializes the operation and returns one rotation result to each host. A token pair alone cannot derive that proof. Do not share refresh tokens with clients that lack this recovery mechanism: they can replay consumed tokens.

If VS Code still displays its built-in MCP OAuth prompt, check the server's source in `MCP: List Servers`. A separate entry in `mcp.json`, even with the same name, does not use this extension's sign-in flow. If the service revokes credentials for a running connection, stop and restart that server so the extension can check them again.

If the MCP server does not start:

- Run `Remote Device Hub: Show Status` to check your sign-in status.
- Open `MCP: List Servers` and use **Start** or **Show Output**.
- If you declined a trust prompt, use `MCP: Reset Trust` and try again.
- If `chat.mcp.autostart` is set to `never`, start the server manually or change that setting.
- Run `Remote Device Hub: Show Logs` for extension diagnostics.

The extension's MCP provider is available in the editor window running the extension. Separate Agent Host sessions in the Agents window use their own configuration, including workspace `.mcp.json` and user `~/.copilot/mcp-config.json`. The extension does not manage those configuration files.

## Use Remote Device Hub in Copilot Chat

Install the VSIX and run `Developer: Reload Window`. In Copilot Chat, type `@remote-device-hub` and select it from the suggestions. Then describe your task:

- `@remote-device-hub List my authorized devices.`
- `@remote-device-hub Check free disk space on device kylin-pc-a5704092.` Replace the example ID with one returned for your account. Shell commands require confirmation in the default execution mode.

There is one chat entry point: `@remote-device-hub`. No slash commands are required. The gray placeholder shows examples; pressing Tab does not insert that text. An empty request displays a brief input hint if the client allows it to be sent.

The chat participant shares the extension's authentication and token refresh logic and connects directly to the same RDH MCP service. You do not need to enable the server in the Agent mode tool picker first. Regular Agent mode can still use the existing MCP provider.

Natural-language requests use the model selected in the chat window. That model must support tool calling. Recent text exchanges with this participant provide context for follow-up requests, while tools retrieve current device information. The default `confirm` execution mode asks before writes, shell commands, and operations outside the read-only allowlist. Declining stops the request. Network failures do not automatically replay tool calls, and canceling chat does not undo operations already sent to a device.

### Continuous AI iteration

The participant can repeat inspection, editing, builds, tests, and repairs in one request. It continues until the model finishes, you press Stop, a configured budget is reached, or an error occurs. Each request uses the model you selected in chat.

For unattended work, first use `@remote-device-hub List my authorized devices` to obtain the target's exact ID. Then open **Preferences: Open User Settings (JSON)**, or **Preferences: Open Remote Settings (JSON)** in a Remote SSH window, and add:

```json
{
  "remoteDeviceHub.chat.executionMode": "automatic",
  "remoteDeviceHub.chat.automaticDevices": ["REPLACE_WITH_YOUR_DEVICE_ID"],
  "remoteDeviceHub.chat.automaticTools": [
    "start_process", "write_file", "edit_file", "make_directory",
    "move_file", "write_process_stdin", "terminate_process",
    "start_search", "stop_search"
  ],
  "remoteDeviceHub.chat.maxModelTurns": 0,
  "remoteDeviceHub.chat.maxToolCalls": 0,
  "remoteDeviceHub.chat.maxDurationMinutes": 60
}
```

Replace the placeholder with an ID returned for your account, and retain only tools you intend to permit. The tool list above supports common coding tasks; a tool must also be advertised by the connected Hub. `0` removes the corresponding budget. The defaults are unlimited model turns and tool calls with a 60-minute time budget. Set `maxDurationMinutes` to `0` to remove that deadline, or use an integer up to 1440 for a bounded run.

Automatic mode requires a trusted workspace. Device reads are limited to `automaticDevices`; non-read-only calls also require a name in `automaticTools`. Global read-only discovery remains available. Global mutations cannot run automatically, even if their tool name is listed. A call outside the configured scope stops with an explanation instead of waiting for a confirmation popup. Workspace `.vscode/settings.json` cannot grant these permissions or change the budgets; the settings are machine-scoped and are read from User or Remote settings. Changing chat execution settings stops active requests. Set `executionMode` back to `confirm` to restore per-call confirmation.

Allowing `start_process` permits arbitrary shell commands with the remote Agent account's OS permissions. A device ID or file root is not a shell sandbox. Automatic mode removes RDH's per-call confirmation within that scope; model-provider consent, service quota, sign-in, and other VS Code prompts may still require attention.

Describe the task and acceptance checks, for example: `@remote-device-hub On device <ID>, repair the failing tests in <project path>. Run the relevant checks after each fix and continue until they pass. Stop if you need a product decision.` The extension keeps the original request, recent complete tool exchanges, and bounded excerpts from earlier results within the selected model's input limit. Large outputs are explicitly marked as partial so the model can read narrower ranges. Excerpts are historical data; they do not replace checking current device state.

Keep VS Code and its extension host running. Closing or reloading the window stops the loop; the extension does not resume a task automatically afterward. A remote process already started may continue running. Inspect its state before starting it again. `Remote Device Hub: Show Logs` records run IDs, tool names, device IDs, outcomes, and stop reasons without logging commands, file contents, or credentials.

The chat client targets RDH's stateless Streamable HTTP configuration with JSON responses; it is not a general-purpose MCP client. Automated tests use simulated models, authentication responses, and MCP requests. Verify completion suggestions and model calls in the Copilot client when testing a release.

## Development

`npm run format` formats maintained sources and tests. `npm run style:check`
checks formatting and lint rules without editing files; `npm run lint` runs only
lint rules. Biome is pinned as a development dependency. The common convention
is two spaces, single quotes, semicolons, trailing commas, and one statement per
line. Type-only imports are explicit; explicit `any` and `@ts-ignore` are rejected.
Generated files and third-party code are outside the formatting scope.

Use Node.js 22, as configured in the CI and release workflows.

```bash
npm ci
npm run compile     # Or use npm run watch during development
npm test            # Requires permission to listen on temporary 127.0.0.1 ports
npm run package:vsix
```

Press `F5` to launch the Extension Development Host. On a first sign-in, verify that the access explanation appears before any browser opens. Choose **Continue** to open browser authorization, or cancel and use **Remote Device Hub: Sign In** when ready to retry. Regression tests use simulated VS Code APIs and authentication responses, real HTTP callbacks, and forwarding between different local ports. They do not use real accounts or replace browser testing in an actual Remote SSH session.

TypeScript enables `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. JSON, saved credentials, OAuth responses, and MCP messages enter through `src/boundaries.ts` as `unknown` and are checked before use. MCP schema checks cover the fields consumed by the extension; they are not a full JSON Schema validator.

With the Hub's development dependencies installed and `RDH_TEST_POSTGRES_DSN` pointing to a disposable PostgreSQL database, also verify sign-out against a disposable local Hub using the compiled extension:

```sh
RDH_SERVER_ROOT=/path/to/remote-device-server
PYTHONDONTWRITEBYTECODE=1 "$RDH_SERVER_ROOT/.venv/bin/python" -m pytest \
  -q -p no:cacheprovider -c "$RDH_SERVER_ROOT/pyproject.toml" \
  -o "pythonpath=$RDH_SERVER_ROOT/tests/support $RDH_SERVER_ROOT $RDH_SERVER_ROOT/tests" \
  test/server/test_signout.py
```

The integration tests use the Hub's reference service and simulated discovery metadata. They cover ordinary sign-out, rotation before sign-out, lost refresh responses, and lost revocation responses. They check that the entire authorization is revoked, cached recovery cannot restore it, and other connections remain valid.

For the split-service integration test, set `RDH_TEST_RUST_AUTH` and `RDH_TEST_RUST_MIGRATE` to matching Server binaries and run the same pytest command with `test/server/test_split_auth.py`. It uses the real Auth service and a simulated MCP Gate to verify discovery, first sign-in, refresh, and revocation.

## Project layout

| File | Purpose |
|---|---|
| `src/extension.ts` | Extension activation, commands, and MCP provider integration |
| `src/authSession.ts` | Authentication state, refresh recovery, timers, and disposal |
| `src/credentialStore.ts` | SecretStorage formats and conditional credential cleanup |
| `src/authCallback.ts` | Temporary OAuth callback servers and cancellable waits |
| `src/boundaries.ts` | Validation for saved credentials, OAuth responses, and MCP messages |
| `src/chat.ts` | Chat participant, model tool calls, and the MCP HTTP client |
| `src/chatRun.ts` | Chat execution permissions, budgets, and cancellation |
| `src/chatContext.ts` | Bounded model context and historical tool excerpts |
| `.vscode/launch.json` | F5 launch configuration |
| `package.json` | Extension metadata, MCP provider, chat participant, and commands |

## Brand assets and license

The extension icon is a 256 × 256 PNG exported from the [Remote Device Hub universal product master](https://github.com/easelian/brand/blob/main/products/remote-device-hub/icons/remote-device-hub.svg). Its fixed charcoal badge and off-white border, desktop display, lock, and two-tooth key use two solid colors on both light and dark surfaces; only the rounded outer corners are transparent. Easelian is the publisher. The Marketplace banner uses the product background color, `#1D1D1F`.

To regenerate the icon from a sibling `brand` checkout:

```sh
inkscape ../brand/products/remote-device-hub/icons/remote-device-hub.svg \
  --export-area-page --export-width=256 --export-height=256 \
  --export-background-opacity=0 --export-filename=resources/icon.png
```

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

## Known limitations

- Documentation, comments, and UI text use American English; localization is not provided.
- Credential checks target the current stateless HTTP MCP service. An existing connection is not guaranteed to pick up refreshed credentials immediately. Restart MCP if the service revokes its token.
- Workspaces in the same window share stored credentials. Refresh coordination is scoped to the extension host.
- The `@remote-device-hub` chat participant can only use chat models whose provider extension runs in the same extension host. `extensionKind: ["workspace"]` keeps the extension alongside model providers in remote windows; a model from a provider in another extension host fails with "The selected model ... is not available."
