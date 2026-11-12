import * as vscode from 'vscode';
import { AuthSession } from './authSession';
import { CredentialError, msg } from './authErrors';
import { resolveDeployment, type DeploymentConfig } from './authConfig';
import { registerChat } from './chat';
import { isRecord, type TokenSet } from './boundaries';

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
  log.info(`MCP origin: ${deployment.mcpOrigin}; website: ${deployment.publicUrl}`);
  context.subscriptions.push(
    vscode.commands.registerCommand('rdh.signIn', () => auth.signIn(true)),
    vscode.commands.registerCommand('rdh.signOut', () => auth.signOut()),
    vscode.commands.registerCommand('rdh.showStatus', () => auth.showStatus()),
    vscode.commands.registerCommand('rdh.showLogs', () => log.show(true)),
    auth,
  );

  registerChat(context, {
    endpoint: deployment.mcpUri,
    ensureSignedIn: async () => {
      auth.start();
      try {
        if (await auth.getAcceptedToken()) {
          return true;
        }
        await auth.signIn();
        if (await auth.getAcceptedToken()) {
          return true;
        }
        auth.offerSignIn('No usable saved credentials.');
      } catch (e) {
        if (!(e instanceof CredentialError)) {
          throw e;
        }
        auth.offerSignIn(e.message);
      }
      return false;
    },
    accessToken: async () => (await auth.getToken())?.access_token,
    log: (message) => log.info(message),
  });

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: auth.onDidChange,
    provideMcpServerDefinitions: () => {
      // Discovery also runs for disabled duplicates. Do not read credentials,
      // contact the issuer, or start authentication until this definition is used.
      return [makeServer(deployment)];
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
        log.info('MCP server start approved; resolving definition with fresh credentials');
        return makeServer(deployment, t);
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

function makeServer(deployment: DeploymentConfig, t?: TokenSet): vscode.McpHttpServerDefinition {
  return new vscode.McpHttpServerDefinition(
    SERVER_LABEL,
    vscode.Uri.parse(deployment.mcpUri),
    t ? { Authorization: `Bearer ${t.access_token}` } : undefined,
  );
}
