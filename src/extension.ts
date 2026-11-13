import * as vscode from 'vscode';
import { AuthSession } from './authSession';
import { CredentialError, msg } from './authErrors';
import { resolveDeployment, type DeploymentConfig } from './authConfig';
import { isRecord } from './boundaries';
import { McpProxy } from './mcpProxy';

const PROVIDER_ID = 'easelian.remote-device-hub';
// VS Code groups colliding MCP definitions by label, not endpoint or provider ID.
// Keep this equal to the server key in the RDH agent plugins.
const SERVER_LABEL = 'remote-device-hub';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Remote Device Hub', { log: true });
  const manifest: unknown = context.extension?.packageJSON;
  const version =
    isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : 'development';
  log.info(`Remote Device Hub ${version} activated`);

  context.subscriptions.push(log);
  let deployment: DeploymentConfig;
  try {
    deployment = resolveDeployment();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Remote Device Hub: ${msg(error)}. Reinstall the extension with valid deployment defaults.`,
    );
    return;
  }
  const auth = new AuthSession(context, log, deployment);
  const proxy = new McpProxy(auth, log, deployment);
  log.info(`MCP origin: ${deployment.mcpOrigin}; website: ${deployment.publicUrl}`);
  context.subscriptions.push(
    vscode.commands.registerCommand('rdh.signIn', () => auth.signIn(true)),
    vscode.commands.registerCommand('rdh.signOut', () => {
      proxy.disconnect();
      return auth.signOut();
    }),
    vscode.commands.registerCommand('rdh.showStatus', () => auth.showStatus()),
    vscode.commands.registerCommand('rdh.showLogs', () => log.show(true)),
    auth,
    proxy,
  );

  const makeServer = async () => {
    const launch = await proxy.launch();
    return new vscode.McpHttpServerDefinition(
      SERVER_LABEL,
      vscode.Uri.parse(launch.uri),
      launch.headers,
    );
  };
  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: auth.onDidChange,
    provideMcpServerDefinitions: async () => {
      // Copilot can use discovery without resolving. Both paths return the
      // same loopback proxy definition; it holds no OAuth token and is safe to cache.
      const token = await auth.discoveryToken();
      if (!token) {
        return [];
      }
      try {
        return [await makeServer()];
      } catch (e) {
        log.warn(`MCP definition withheld: ${msg(e)}`);
        return [];
      }
    },
    resolveMcpServerDefinition: async () => {
      // Validate credentials before VS Code starts the server; sign in if needed.
      auth.start();
      try {
        let t = await auth.getAcceptedToken();
        if (!t) {
          log.info(
            'server start: no saved credentials; checking whether first-time sign-in is allowed',
          );
          await auth.signIn();
          t = await auth.getAcceptedToken();
          if (!t) {
            auth.offerSignIn('No usable saved credentials.');
            return undefined;
          }
        }
        log.info('MCP server start approved; resolving local proxy definition');
        return await makeServer();
      } catch (e) {
        log.error(`resolveMcpServerDefinition failed: ${msg(e)}`);
        if (e instanceof CredentialError) {
          auth.offerSignIn(e.message);
        }
        return undefined;
      }
    },
  };
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
  log.info(
    'MCP server definition provider registered; VS Code starts the server on demand (chat / MCP view).',
  );
}

export function deactivate(): void {
  /* VS Code disposes context subscriptions. */
}
