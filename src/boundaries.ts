// Values from JSON, SecretStorage, and model providers remain unknown until the
// fields used by the extension have been checked.
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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

export interface McpInputSchema extends Record<string, unknown> {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpInputSchema;
}

function isInputSchema(value: unknown): value is McpInputSchema {
  return (
    isRecord(value) &&
    value.type === 'object' &&
    (value.properties === undefined ||
      (isRecord(value.properties) &&
        Object.values(value.properties).every(
          (schema) => typeof schema === 'boolean' || isRecord(schema),
        ))) &&
    (value.required === undefined ||
      (isUnknownArray(value.required) &&
        value.required.every((name): name is string => typeof name === 'string')))
  );
}

export function readMcpTool(value: unknown): McpTool {
  if (
    !isRecord(value) ||
    !nonemptyString(value.name) ||
    (value.description !== undefined && typeof value.description !== 'string') ||
    !isInputSchema(value.inputSchema)
  ) {
    throw new Error('An MCP tool definition is malformed.');
  }
  return {
    name: value.name,
    inputSchema: value.inputSchema,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

export function readRpcResult(value: unknown, id: number): Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.id !== id) {
    throw new Error('The MCP response ID does not match the request.');
  }
  if ('error' in value) {
    if (
      'result' in value ||
      !isRecord(value.error) ||
      typeof value.error.code !== 'number' ||
      !Number.isInteger(value.error.code) ||
      typeof value.error.message !== 'string'
    ) {
      throw new Error('The MCP error response is malformed.');
    }
    throw new Error(`MCP error ${value.error.code}: ${value.error.message}`);
  }
  if (!isRecord(value.result)) {
    throw new Error('The MCP response is missing its result.');
  }
  return value.result;
}
