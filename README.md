# Remote Device Hub for VS Code

![Easelian Remote Device Hub](resources/icon.png)

Use Copilot Chat or MCP in VS Code to work with your authorized devices. Remote Device Hub (RDH) can inspect and edit shared files, search directories, and run permitted commands on those devices.

[Remote Device Hub](https://rdh.easelian.com) · [Download VSIX](https://github.com/easelian/remote-device-plugin-vscode/releases) · [Report an issue](https://github.com/easelian/remote-device-plugin-vscode/issues)

## Requirements

Install and pair the **RDH Agent** on each device you want to control. See the [Agent installation and pairing guide](https://github.com/easelian/remote-device-agent#install-and-run) and [Agent distribution guide](https://github.com/easelian/remote-device-agent/blob/main/docs/distribution.md) for supported platforms and downloads.

Install the **VS Code extension** in the editor you use to send requests. It requires VS Code desktop 1.105 or later and uses the extension ID `easelian.remote-device-hub`. You can use a local editor window or a Remote SSH editor window. In Remote SSH, the extension runs on the SSH workspace host, which may be a different machine from the RDH target device. VS Code does not need to be installed on the target device.

The Agent must be connected for device operations. File access is limited to the configured shared directories and permissions. Commands require command execution to be enabled and run with the Agent account's OS permissions. Shared directory boundaries do not confine shell commands. Use `device_info` to check the target OS, configured roots, enabled capabilities, and process limits. Optional browser tools are a preview feature. They require a compatible Hub and an Agent with browser sessions enabled. See the [Agent browser guide](https://github.com/easelian/remote-device-agent/blob/main/docs/browser.md).

## Set up and verify the connection

1. On the target device, start the RDH Agent. For an unpaired device, select the shared directory and approve pairing in the browser. Keep the Agent running.
2. In the VS Code window you plan to use, run **Extensions: Install from VSIX**, select the RDH `.vsix`, and run **Developer: Reload Window**. For Remote SSH, open the SSH window first and confirm **Remote Device Hub** appears under the SSH host in the Extensions view. See [VS Code extension installation over SSH](https://code.visualstudio.com/docs/remote/ssh#managing-extensions).
3. When RDH asks to connect your account, choose **Continue** and authorize in the browser on your local machine. Use the RDH account that has access to the paired device. If the prompt was dismissed or sign-in failed, run **Remote Device Hub: Sign In**. Existing valid credentials are reused.
4. Open Chat in the editor window, select a model that supports tool calls, and send `@remote-device-hub List my authorized devices.` The response should include the target device ID and connection status. An empty list means the signed-in account has no devices available to list.

The chat model provider must be available in the same extension host as RDH. In Remote SSH, choose a model whose provider is available on the SSH workspace host. If the browser cannot open automatically, choose **Copy Link** and open it in your local browser. The browser must be able to return to the VS Code forwarded callback.

## Use RDH in Chat

- **`@remote-device-hub`** runs the RDH chat participant in the editor. Type the mention, select it from the suggestions, and describe the task. Try listing a shared directory or checking free disk space on a specific device ID from the device list. The participant connects directly to RDH and manages tool approvals using its own chat settings.
- **Direct MCP tools** let Copilot Agent call the extension's **Remote Device Hub** server. Use **MCP: List Servers** to locate the extension-provided server and start it if needed. In the chat tool picker, enable the tools for your session. Review any server trust prompt before starting it. In VS Code versions that offer **Chat: Manage Tool Approval**, use it to review approvals for the **Remote Device Hub** source. See [VS Code tool approvals](https://code.visualstudio.com/docs/agents/run/approvals#manage-tool-approvals).

The extension provides the MCP server definition to the editor. You do not need to add a duplicate entry to `mcp.json`. VS Code may start the server on demand or when chat discovers tools. If `chat.mcp.autostart` is set to `never`, use **Start** in **MCP: List Servers**. Separate agent sessions that do not load the extension use their harness's MCP configuration. See [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

### Extension commands

Search for **Remote Device Hub** in the Command Palette. These are the English command names.

| Command | What it does |
| --- | --- |
| **Sign In** | Connects or reconnects your RDH account through the browser. |
| **Sign Out** | Clears local sign-in and requests revocation of the saved RDH connection. |
| **Show Status** | Checks whether the RDH service accepts the saved credentials and displays sign-in status. |
| **Show Logs** | Opens the Remote Device Hub output channel. |
| **Set Chat Permissions** | Changes the approval mode for `@remote-device-hub`. |

Command titles, setting descriptions, and chat approval prompts follow the VS Code display language in English, Simplified Chinese, and Traditional Chinese. The initial sign-in explanation is available in English and Simplified Chinese. Some runtime messages and service errors are in English.

## Chat permissions and time limits

Run **Remote Device Hub: Set Chat Permissions** or change `remoteDeviceHub.chat.permissions` in User settings or the SSH host's Remote settings. These settings apply to `@remote-device-hub`.

| Mode | Setting value | Behavior |
| --- | --- | --- |
| Read only | `read-only` | Inspect devices, shared files, process output, and operation status. Commands and changes are blocked. |
| Ask for approval (default) | `ask` | Inspection tools on the read-only list run without prompting. Other tools require approval, including shell commands used only for inspection. |
| Full access | `full-access` | Skip RDH approval prompts for available tools in a trusted workspace. Account and device permissions still apply. |

In **Ask for approval** mode, review the tool arguments and choose **Run Once**, **Approval Options…**, or cancel the chat request. **Approval Options…** lets you run the operation once and keep asking, switch to **Read only** and cancel the pending change, or save **Full access** and continue the request. If the workspace is trusted and the tool requires a device ID, **Allow Device for This Task** permits operations on that device for the remainder of the current request, including file changes and shell commands. It does not change saved permissions or apply to other devices, global operations, follow-ups, or concurrent requests.

The participant can iterate through tool calls until the task completes, you stop it, the time limit is reached, or an error occurs. Set `remoteDeviceHub.chat.maxDurationMinutes` in User or Remote settings. The default is **60 minutes**, including model waits, tool calls, and approvals. Enter an integer from `1` to `1440`, or `0` to remove the overall time limit. Individual network deadlines still apply. Changes to the effective settings stop active requests. Selecting **Full access** in an approval prompt can continue the request you are approving.

## Troubleshoot a connection or stalled request

| What you see | What to check |
| --- | --- |
| RDH is missing from Chat or the selected model is unavailable | Check the Extensions view in the current window. In Remote SSH, confirm RDH is installed on that host and select a tool-capable model available in the same extension host. Reload after installing. |
| Sign-in does not open or finish | Run **Remote Device Hub: Sign In** and confirm the access explanation. If offered, use **Copy Link** in the local browser. In Remote SSH, keep the SSH window connected while the browser returns to VS Code. Run **Show Status** after sign-in. |
| No devices are listed, or the target is offline | Check that you signed in to an account with access to the paired device and that the Agent is running. Use a fresh device list to confirm the device ID and status. |
| The native MCP server is missing, stopped, or asks for its own sign-in | In **MCP: List Servers**, check the server source, then use **Start** or **Show Output**. A separately configured server with the same name has its own authentication. If a running connection still uses rejected credentials after **Show Status** succeeds, restart the MCP server. |
| The chat request stalls or reports a timeout | **Show Logs** opens RDH's output. Check whether the request was connecting, loading tools, waiting for the selected model, or running a named tool. The extension allows 30 seconds for each OAuth metadata request, credential check, or token refresh request, and 60 seconds for each RDH chat MCP request. The model's response is subject to the overall chat time limit. |
| A command was sent, but the result is unconfirmed | Check the original operation with `get_operation_status` using its operation ID or `list_operations` on the device. For an ordinary device call, use `get_call_status` with the Support ID or `list_calls`. Match the record to the device, action, and time before deciding whether to run it again. |

Stopping a chat, reloading VS Code, or timing out does not undo a command already sent to a device. A successful `start_process` confirms that the job started. Use `read_process` with the returned job ID to check output and completion. When reporting a problem, include the relevant run ID, tool name, and any operation or Support ID. RDH chat logs record execution metadata rather than command arguments, file contents, or credentials.

## Account access and data

The extension connects to `https://rdh.easelian.com/mcp` and discovers the OAuth issuer from the MCP resource metadata. OAuth sign-in uses PKCE and opens in the local browser, including in a Remote SSH window. The extension stores credentials in VS Code SecretStorage, scoped to the MCP resource and bound to the issuer. Sign-in grants the extension access to the account's authorized devices. Pairing a device is a separate approval.

While the extension host is running, the extension refreshes credentials in the background. When the issuing service supports refresh recovery and recovery data is available, the extension can retrieve the result of an interrupted rotation without a new sign-in. Use **Sign In** if the issuer changes or the saved credentials cannot be renewed. **Sign Out** clears local credentials first and asks the authorization service to revoke the connection. If revocation cannot be confirmed, use the RDH account settings to revoke the connection.

The `@remote-device-hub` participant passes your request, relevant chat context, and RDH tool exchanges to the selected chat model. Tool results may contain remote file contents, paths, and command output. Large results may be shown to the model as partial excerpts. Ask for smaller ranges or read process output incrementally when you need the complete result.

## Development

`npm run format` formats maintained sources and tests. `npm run style:check`
checks formatting and lint rules without editing files; `npm run lint` runs only
lint rules. Biome is pinned as a development dependency. The common convention
is two spaces, single quotes, semicolons, trailing commas, and one statement per
line. Type-only imports are explicit; explicit `any` and `@ts-ignore` are rejected.
Generated files and third-party code are outside the formatting scope.

From the extension repository root, use Node.js 22, as configured in the CI and release workflows.

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
| `src/authCallback.ts` | Temporary OAuth callback server |
| `src/requestDeadline.ts` | Deadlines for authentication and MCP requests |
| `src/boundaries.ts` | Validation for saved credentials, OAuth responses, and MCP messages |
| `src/chat.ts` | Chat participant, model tool calls, and the MCP HTTP client |
| `src/chatRun.ts` | Permission picker, task approvals, time limit, and cancellation |
| `src/chatContext.ts` | Bounded model context and historical tool excerpts |
| `.vscode/launch.json` | F5 launch configuration |
| `package.json` | Extension metadata, MCP provider, chat participant, commands, and settings |
| `package.nls*.json`, `l10n/` | Translations for extension contributions and chat UI |

## License

Easelian publishes this extension under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.
