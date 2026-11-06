import { createHash } from 'crypto';
import { PUBLIC_URL, MCP_PUBLIC_URL } from './deploymentDefaults';

export interface DeploymentConfig {
  readonly publicUrl: string;
  readonly mcpOrigin: string;
  readonly mcpUri: string;
  readonly resource: string;
  readonly credentialNamespace: string;
}

// Only User/Remote values may choose where credentials are sent. Never use
// configuration.get(), which can include a repository's workspace settings.
export function userDeploymentValue(setting: { globalValue?: unknown } | undefined): unknown {
  return setting?.globalValue;
}

function origin(value: unknown, fallback: string, name: string): string {
  const input = value === undefined || value === '' ? fallback : value;
  if (typeof input !== 'string') {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    input !== input.trim() ||
    /[\\\u0000-\u0020]/u.test(input) ||
    input.includes('?') ||
    input.includes('#') ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTPS origin without credentials, a path, query, or fragment (HTTP is allowed only on loopback)`,
    );
  }
  return url.origin;
}

export function resolveDeployment(
  values: { publicUrl?: unknown; mcpPublicUrl?: unknown } = {},
): DeploymentConfig {
  const publicUrl = origin(values.publicUrl, PUBLIC_URL, 'remoteDeviceHub.publicUrl');
  const mcpOrigin = origin(values.mcpPublicUrl, MCP_PUBLIC_URL, 'remoteDeviceHub.mcpPublicUrl');
  const mcpUri = `${mcpOrigin}/mcp`;
  return Object.freeze({
    publicUrl,
    mcpOrigin,
    mcpUri,
    resource: mcpUri,
    credentialNamespace: `rdh.deployment.${createHash('sha256').update(mcpUri).digest('hex')}`,
  });
}

export const SCOPE = 'devices:control';
export const REFRESH_MARGIN_S = 180;
export const REFRESH_RETRY_MS = 60 * 1000;
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30 * 1000;
