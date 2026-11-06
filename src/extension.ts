import * as vscode from 'vscode';
import { AuthSession } from './authSession';
import { CredentialError, msg } from './authErrors';
import { resolveDeployment, userDeploymentValue, type DeploymentConfig } from './authConfig';
import { registerChat } from './chat';
import { isRecord, type TokenSet } from './boundaries';

const PROVIDER_ID = 'easelian.remote-device-hub';
const SERVER_LABEL = 'Remote Device Hub';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Remote Device Hub', { log: true });
  const manifest: unknown = context.extension?.packageJSON;
  const version =
    isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : 'development';
  log.info(`Remote Device Hub ${version} activated`);

  context.subscriptions.push(log);
  let deployment: DeploymentConfig;
  try {
    deployment = readDeployment();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Remote Device Hub: ${msg(error)}. Correct User or Remote settings and reload the window.`,
    );
    return;
  }
  const auth = new AuthSession(context, log, deployment);
  log.info(`MCP origin: ${deployment.mcpOrigin}; website: ${deployment.publicUrl}`);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('remoteDeviceHub.publicUrl') &&
        !event.affectsConfiguration('remoteDeviceHub.mcpPublicUrl')
      ) {
        return;
      }
      try {
        const next = readDeployment();
        if (next.publicUrl === deployment.publicUrl && next.mcpOrigin === deployment.mcpOrigin) {
          return;
        }
      } catch {
        // Invalid new settings also require correction and a reload.
      }
      void vscode.window
        .showWarningMessage(
          `Remote Device Hub deployment settings changed. This window continues using ${deployment.mcpOrigin} until you reload.`,
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    }),
  );
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
    provideMcpServerDefinitions: async () => {
      // VS Code requests definitions during chat autostart scans or from the MCP view.
      // Advertise the server before sign-in; resolve handles authentication when it starts.
      try {
        const t = await auth.readStoredToken();
        log.debug(
          t
            ? 'definition provided with saved credentials (validated before startup)'
            : 'definition provided without a token (sign-in will be requested when the server starts)',
        );
        return [makeServer(deployment, t)];
      } catch (e) {
        log.error(`provideMcpServerDefinitions failed: ${msg(e)}`);
        return [makeServer(deployment)];
      }
    },
    resolveMcpServerDefinition: async () => {
      // Validate credentials before VS Code starts the server; sign in if needed.
      try {
        let t = await auth.getAcceptedToken();
        if (!t) {
          log.info(
            'server start: no saved credentials; checking whether first-time sign-in is allowed',
          );
          await auth.signIn();
          t = await auth.getToken();
          if (!t) {
            auth.offerSignIn('No usable saved credentials.');
            return undefined;
          }
          if (!(await auth.acceptsToken(t))) {
            throw new Error(
              'MCP rejected the new token. Check the account permissions and server configuration.',
            );
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

  auth.start();
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

function readDeployment(): DeploymentConfig {
  const settings = vscode.workspace.getConfiguration('remoteDeviceHub');
  return resolveDeployment({
    publicUrl: userDeploymentValue(settings.inspect('publicUrl')),
    mcpPublicUrl: userDeploymentValue(settings.inspect('mcpPublicUrl')),
  });
}
