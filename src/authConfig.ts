export const AUTH_BASE = 'https://mcp.xdistribute.site'; // Browser authorization and client registration
export const MCP_URI = 'https://xdistribute.site:8090/mcp'; // MCP endpoint; connects directly to the origin
export const TOKEN_URI = new URL('/token', MCP_URI).toString(); // The same trusted Hub, without the proxy hop
export const REFRESH_URI = new URL('/token/refresh', MCP_URI).toString();
export const REVOKE_URI = new URL('/revoke', MCP_URI).toString();
export const RESOURCE = 'https://mcp.xdistribute.site/mcp';
export const SCOPE = 'devices:control';

export const REFRESH_MARGIN_S = 180; // Refresh 180 seconds before expiration
export const REFRESH_RETRY_MS = 60 * 1000;
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // Maximum time allowed for sign-in
export const REQUEST_TIMEOUT_MS = 30 * 1000;
