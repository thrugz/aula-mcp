/**
 * Aula's OIDC endpoints (SimpleSAMLphp at login.aula.dk). The client is the
 * Aula mobile app's public client: PKCE, no secret, scope `aula-sensitive`.
 */

import { ReauthRequiredError, AulaError } from '../errors.js';
import type { HttpClient } from './http.js';

export const OAUTH = Object.freeze({
  clientId: '_99949a54b8b65423862aac1bf629599ed64231607a',
  scope: 'aula-sensitive',
  redirectUri: 'https://app-private.aula.dk',
  authorize: 'https://login.aula.dk/simplesaml/module.php/oidc/authorize.php',
  token: 'https://login.aula.dk/simplesaml/module.php/oidc/token.php',
  defaultAcs: 'https://login.aula.dk/simplesaml/module.php/saml/sp/saml2-acs.php/uni-sp',
  brokerSaml: 'https://broker.unilogin.dk/auth/realms/broker/broker/nemlogin3/endpoint',
  postBrokerLogin: 'https://broker.unilogin.dk/auth/realms/broker/login-actions/post-broker-login',
});

export interface Tokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  /** Unix seconds. */
  obtained_at: number;
}

export function authorizeUrl(state: string, codeChallenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH.clientId,
    scope: OAUTH.scope,
    redirect_uri: OAUTH.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${OAUTH.authorize}?${q.toString()}`;
}

export async function exchangeCode(http: HttpClient, code: string, verifier: string): Promise<Tokens> {
  return tokenRequest(http, {
    grant_type: 'authorization_code',
    code,
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    code_verifier: verifier,
  });
}

/**
 * Refresh grant. Talks only to login.aula.dk (no broker), so it works from any
 * network. A 400/401 means the refresh token is dead and MitID is needed again.
 */
export async function refreshTokens(http: HttpClient, refreshToken: string): Promise<Tokens> {
  return tokenRequest(
    http,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH.clientId },
    refreshToken,
  );
}

async function tokenRequest(http: HttpClient, form: Record<string, string>, fallbackRefresh?: string): Promise<Tokens> {
  const res = await http.request(OAUTH.token, {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  if (res.status === 400 || res.status === 401) {
    const error = safeError(res.body);
    throw new ReauthRequiredError(`Aula rejected the ${form.grant_type} grant (${error ?? `HTTP ${res.status}`}).`);
  }
  if (res.status !== 200) throw new AulaError(`Aula token endpoint answered HTTP ${res.status}.`);
  return parseTokens(res.body, fallbackRefresh);
}

export function parseTokens(body: string, fallbackRefresh?: string): Tokens {
  const raw = JSON.parse(body) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!raw.access_token) throw new AulaError('Token response has no access_token.');
  const refresh = raw.refresh_token ?? fallbackRefresh;
  if (!refresh) throw new AulaError('Token response has no refresh_token.');
  const now = Math.floor(Date.now() / 1000);
  // Trust the JWT's own exp over expires_in when both exist (scaarup gotcha 8).
  const exp = jwtExp(raw.access_token) ?? now + (typeof raw.expires_in === 'number' ? raw.expires_in : 3600);
  return { access_token: raw.access_token, refresh_token: refresh, expires_at: exp, obtained_at: now };
}

export function jwtExp(jwt: string): number | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

function safeError(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: string; error_description?: string };
    return [j.error, j.error_description].filter(Boolean).join(': ') || undefined;
  } catch {
    return undefined;
  }
}
