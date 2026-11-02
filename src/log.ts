/**
 * Logging to stderr only: stdout is the MCP JSON-RPC channel. Off unless
 * AULA_MCP_DEBUG is set. Everything passes through `redact` first, because Aula
 * carries the access token in the query string.
 */

const SECRET_PARAMS =
  /([?&](?:access_token|refresh_token|code|state|ticket|session_code|SAMLResponse|RelayState|token)=)[^&#\s"]+/gi;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redact(text: string): string {
  return text.replace(SECRET_PARAMS, '$1<redacted>').replace(BEARER, '$1<redacted>').replace(JWT, '<jwt>');
}

const enabled = () => /^(1|true|yes|on)$/i.test(process.env.AULA_MCP_DEBUG ?? '');

export const log = {
  debug(event: string, fields?: Record<string, unknown>): void {
    if (!enabled()) return;
    process.stderr.write(`${redact(`[aula-mcp] ${event}${fields ? ` ${JSON.stringify(fields)}` : ''}`)}\n`);
  },
  warn(event: string, fields?: Record<string, unknown>): void {
    process.stderr.write(`${redact(`[aula-mcp] warn ${event}${fields ? ` ${JSON.stringify(fields)}` : ''}`)}\n`);
  },
};
