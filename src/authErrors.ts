// Only application-owned diagnostics may be shown. Transport and storage errors can contain secrets.
export class SafeAuthError extends Error {}

export class CredentialError extends SafeAuthError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function callbackError(code: string): SafeAuthError {
  const allowed = new Set([
    'invalid_request',
    'unauthorized_client',
    'access_denied',
    'unsupported_response_type',
    'invalid_scope',
    'server_error',
    'temporarily_unavailable',
    'timeout',
    'state_mismatch',
    'issuer_mismatch',
  ]);
  return new SafeAuthError(
    `OAuth authorization failed: ${allowed.has(code) ? code : 'authorization_error'}`,
  );
}

export function msg(e: unknown): string {
  if (e instanceof CredentialError) {
    return `${e.reason}: ${e.message}`;
  }
  return e instanceof SafeAuthError
    ? e.message
    : 'Authentication operation failed. Check connectivity and secure storage, then try again.';
}
