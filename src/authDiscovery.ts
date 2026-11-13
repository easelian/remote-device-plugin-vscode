import { SafeAuthError } from './authErrors';
import { isIP } from 'net';
import { isRecord } from './boundaries';
import { SCOPE, type DeploymentConfig } from './authConfig';
import { withRequestDeadline } from './requestDeadline';

export interface AuthEndpoints {
  readonly issuer: string;
  readonly authorizationUri: string;
  readonly registrationUri: string;
  readonly tokenUri: string;
  readonly refreshUri: string | undefined;
  readonly revokeUri: string | undefined;
  readonly responseIssuerRequired: boolean;
}

const MAX_METADATA_BYTES = 64 * 1024;

function validatedUrl(value: unknown, name: string): URL {
  if (typeof value !== 'string' || value !== value.trim() || /[\\\u0000-\u0020]/u.test(value)) {
    throw new SafeAuthError(`OAuth metadata has an invalid ${name}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeAuthError(`OAuth metadata has an invalid ${name}.`);
  }
  const loopback =
    ['localhost', '[::1]'].includes(url.hostname) ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SafeAuthError(`OAuth metadata has an unsafe ${name}.`);
  }
  return url;
}

function endpoint(value: unknown, issuer: URL, name: string, required = true): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  const url = validatedUrl(value, name);
  if (url.origin !== issuer.origin) {
    throw new SafeAuthError(`OAuth metadata has a cross-origin ${name}.`);
  }
  return url.href;
}

function supports(value: unknown, required: string, name: string): void {
  if (value !== undefined && (!Array.isArray(value) || !value.includes(required))) {
    throw new SafeAuthError(`OAuth metadata does not support ${name}.`);
  }
}

async function metadata(url: string): Promise<Record<string, unknown>> {
  return withRequestDeadline(async (signal) => {
    const response = await fetch(url, {
      redirect: 'error',
      signal,
      headers: { Accept: 'application/json' },
    });
    signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new SafeAuthError(`OAuth discovery failed with HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new SafeAuthError('OAuth discovery returned an empty response.');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) {
          break;
        }
        size += part.value.byteLength;
        if (size > MAX_METADATA_BYTES) {
          throw new SafeAuthError('OAuth discovery response is too large.');
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new SafeAuthError('OAuth discovery returned invalid JSON.');
    }
    if (!isRecord(parsed)) {
      throw new SafeAuthError('OAuth discovery returned invalid metadata.');
    }
    return parsed;
  }, 'OAuth discovery');
}

/** Discover the issuing authority from this configured MCP resource. */
export async function discoverAuth(deployment: DeploymentConfig): Promise<AuthEndpoints> {
  const resourceUrl = new URL(deployment.resource);
  const resourceMetadata = await metadata(
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
  );
  if (resourceMetadata.resource !== deployment.resource) {
    throw new SafeAuthError('OAuth resource metadata does not match the configured MCP resource.');
  }
  const servers = resourceMetadata.authorization_servers;
  if (!Array.isArray(servers) || servers.length !== 1 || typeof servers[0] !== 'string') {
    throw new SafeAuthError('OAuth resource metadata must identify one authorization server.');
  }
  supports(resourceMetadata.scopes_supported, SCOPE, 'the required resource scope');
  const issuer = validatedUrl(servers[0], 'issuer');
  if (issuer.pathname !== '/' || issuer.href !== servers[0]) {
    throw new SafeAuthError('OAuth metadata has a noncanonical issuer.');
  }
  const auth = await metadata(`${issuer.origin}/.well-known/oauth-authorization-server`);
  if (auth.issuer !== servers[0]) {
    throw new SafeAuthError(
      'OAuth authorization-server issuer does not match the resource metadata.',
    );
  }
  supports(auth.scopes_supported, SCOPE, 'the required authorization scope');
  supports(auth.response_types_supported, 'code', 'authorization codes');
  supports(auth.grant_types_supported, 'authorization_code', 'the authorization-code grant');
  supports(auth.grant_types_supported, 'refresh_token', 'the refresh-token grant');
  supports(auth.code_challenge_methods_supported, 'S256', 'PKCE S256');
  supports(auth.token_endpoint_auth_methods_supported, 'none', 'public OAuth clients');
  if (
    auth.authorization_response_iss_parameter_supported !== undefined &&
    typeof auth.authorization_response_iss_parameter_supported !== 'boolean'
  ) {
    throw new SafeAuthError('OAuth metadata has an invalid authorization response issuer policy.');
  }
  return Object.freeze({
    issuer: servers[0],
    authorizationUri: endpoint(auth.authorization_endpoint, issuer, 'authorization endpoint')!,
    registrationUri: endpoint(auth.registration_endpoint, issuer, 'registration endpoint')!,
    tokenUri: endpoint(auth.token_endpoint, issuer, 'token endpoint')!,
    refreshUri: endpoint(auth.rdh_refresh_endpoint, issuer, 'refresh endpoint', false),
    revokeUri: endpoint(auth.revocation_endpoint, issuer, 'revocation endpoint', false),
    responseIssuerRequired: auth.authorization_response_iss_parameter_supported === true,
  });
}
