// Values from JSON and SecretStorage remain unknown until the
// fields used by the extension have been checked.
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  _got_at?: number;
  client_id: string;
  // Only credentials tied to the discovered issuer may be sent or refreshed.
  _issuer?: string;
  // A surviving pending marker prevents unsafe refresh-token replay.
  _refresh_state?: 'pending' | 'rejected';
  _refresh_request_id?: string;
  _refresh_recovery?: true;
}

export function isTokenSet(value: unknown): value is TokenSet {
  if (!isRecord(value)) {
    return false;
  }
  return (
    nonemptyString(value.access_token) &&
    nonemptyString(value.client_id) &&
    (value._issuer === undefined || nonemptyString(value._issuer)) &&
    (value.refresh_token === undefined || nonemptyString(value.refresh_token)) &&
    (value._got_at === undefined ||
      (typeof value._got_at === 'number' &&
        Number.isFinite(value._got_at) &&
        value._got_at >= 0)) &&
    (value.expires_in === undefined ||
      (typeof value.expires_in === 'number' &&
        Number.isFinite(value.expires_in) &&
        value.expires_in > 0)) &&
    (value._refresh_state === undefined ||
      value._refresh_state === 'pending' ||
      value._refresh_state === 'rejected') &&
    (value._refresh_recovery === undefined || value._refresh_recovery === true) &&
    (value._refresh_request_id === undefined ||
      (typeof value._refresh_request_id === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(value._refresh_request_id) &&
        value._refresh_state === 'pending'))
  );
}

// OAuth payloads cannot set local recovery state, timestamps, or client identity.
export function readTokenResponse(
  value: unknown,
  clientId: string,
): Pick<TokenSet, 'access_token' | 'refresh_token' | 'expires_in'> {
  if (
    !isRecord(value) ||
    !nonemptyString(value.access_token) ||
    (value.refresh_token !== undefined && !nonemptyString(value.refresh_token)) ||
    (value.expires_in !== undefined &&
      (typeof value.expires_in !== 'number' ||
        !Number.isFinite(value.expires_in) ||
        value.expires_in <= 0)) ||
    (value.client_id !== undefined && value.client_id !== clientId)
  ) {
    throw new Error('The token response has an invalid format.');
  }
  return {
    access_token: value.access_token,
    ...(typeof value.refresh_token === 'string' ? { refresh_token: value.refresh_token } : {}),
    ...(typeof value.expires_in === 'number' ? { expires_in: value.expires_in } : {}),
  };
}

export function readClientId(value: unknown): string {
  if (!isRecord(value) || !nonemptyString(value.client_id)) {
    throw new Error('The registration response has no valid client_id.');
  }
  return value.client_id;
}
