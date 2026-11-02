/**
 * Aula API client. One RPC endpoint, `https://www.aula.dk/api/v{N}/?method=...`,
 * with the access token as a query parameter (Aula rejects an Authorization
 * header alongside it). Handles, so tools do not have to:
 *
 *   - API version: starts at the last version that worked (persisted), bumps
 *     on 410 Gone, and replays the original request (method and body).
 *   - Session bootstrap: `profiles.getProfileContext` before the first call of
 *     a session; Aula answers 403 code 10 / subCode 23 without it.
 *   - Auth: one refresh-and-retry when Aula rejects the token.
 *   - Transient failures: timeouts, and two retries with backoff for reads.
 *   - Concurrency: at most four requests in flight; identical reads in a short
 *     window share one request.
 */

import { HttpClient, NetworkError } from '../auth/http.js';
import { ApiError, ReauthRequiredError } from '../errors.js';
import { log } from '../log.js';
import { loadState, saveState } from '../store/state.js';
import type { TokenSource } from './session.js';

export const API_HOST = 'https://www.aula.dk';
const FIRST_VERSION = 24;
const MAX_VERSION_STEPS = 12;

export type Params = Record<string, string | number | boolean | undefined | ReadonlyArray<string | number>>;

interface Envelope<T> {
  status?: { code?: number; message?: string; subCode?: number };
  data?: T;
}

export class AulaClient {
  readonly http: HttpClient;
  private readonly tokens: TokenSource;
  private version?: number;
  private versionProbe?: Promise<number>;
  private bootstrap?: Promise<unknown>;
  private readonly cache = new Map<string, { until: number; value: Promise<unknown> }>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(tokens: TokenSource, http = new HttpClient()) {
    this.tokens = tokens;
    this.http = http;
  }

  /** GET with an optional short cache (seconds). */
  async get<T>(method: string, params: Params = {}, opts: { cacheSeconds?: number } = {}): Promise<T> {
    if (opts.cacheSeconds) {
      const key = `${method}?${serialize(params)}`;
      const hit = this.cache.get(key);
      if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
      const value = this.call<T>('GET', method, params);
      this.cache.set(key, { until: Date.now() + opts.cacheSeconds * 1000, value });
      value.catch(() => this.cache.delete(key));
      return value;
    }
    return this.call<T>('GET', method, params);
  }

  async post<T>(method: string, body: unknown, params: Params = {}): Promise<T> {
    return this.call<T>('POST', method, params, body);
  }

  /** The guardian profile context; also the session bootstrap. Cached per session. */
  profileContext<T = unknown>(): Promise<T> {
    this.bootstrap ??= this.send('GET', 'profiles.getProfileContext', { portalrole: 'guardian' }).catch((e) => {
      this.bootstrap = undefined;
      throw e;
    });
    return this.bootstrap as Promise<T>;
  }

  /** Drop cached reads (after a write). */
  invalidate(): void {
    this.cache.clear();
  }

  async apiVersion(): Promise<number> {
    if (this.version) return this.version;
    // Trust the last version that worked; a 410 triggers a probe anyway.
    const saved = (await loadState()).apiVersion;
    if (saved) return (this.version = saved);
    return this.probeVersion();
  }

  private async call<T>(verb: 'GET' | 'POST', method: string, params: Params, body?: unknown): Promise<T> {
    if (method !== 'profiles.getProfileContext') await this.profileContext();
    try {
      return await this.send<T>(verb, method, params, body);
    } catch (e) {
      // Session lost its acting profile (code 10 / subCode 23): bootstrap again once.
      if (e instanceof ApiError && e.code === 10 && e.subCode === 23) {
        this.bootstrap = undefined;
        await this.profileContext();
        return this.send<T>(verb, method, params, body);
      }
      throw e;
    }
  }

  private async send<T>(verb: 'GET' | 'POST', method: string, params: Params, body?: unknown): Promise<T> {
    let version = await this.apiVersion();
    let token = await this.tokens.accessToken();
    let renewed = false;
    let bumps = 0;
    let attempt = 0;
    for (;;) {
      attempt++;
      let res;
      try {
        res = await this.limited(() => this.request(verb, version, method, params, token, body));
      } catch (e) {
        if (e instanceof NetworkError && verb === 'GET' && attempt <= 2) {
          await backoff(attempt);
          continue;
        }
        throw e;
      }
      if (res.status === 410) {
        if (++bumps > 3) throw new ApiError(`Aula keeps answering 410 Gone for ${method} after ${bumps - 1} version changes.`, { status: 410 });
        version = await this.probeVersion(version + 1);
        continue;
      }
      if (!renewed && (res.status === 401 || (res.status === 403 && (await this.mayBeExpired(res.body))))) {
        renewed = true;
        token = await this.tokens.renew(token);
        continue;
      }
      if (res.status === 401) throw new ReauthRequiredError('Aula rejected the access token after a refresh.');
      if (res.status >= 500 && verb === 'GET' && attempt <= 2) {
        await backoff(attempt);
        continue;
      }
      return parseEnvelope<T>(method, res.status, res.body);
    }
  }

  /**
   * Whether a 403 could be an expired token. Not when it says "no acting
   * profile" (code 10 / subCode 23: call() bootstraps instead), and not when
   * the token is minutes old: then it is a permission answer, and refreshing
   * would only rotate the refresh token for nothing.
   */
  private async mayBeExpired(body: string): Promise<boolean> {
    if (missingProfileContext(body)) return false;
    const age = await this.tokens.tokenAgeSeconds();
    return age === undefined || age > 600;
  }

  private async request(verb: 'GET' | 'POST', version: number, method: string, params: Params, token: string, body?: unknown) {
    const url = `${API_HOST}/api/v${version}/?${query({ method, ...params, access_token: token })}`;
    const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
    if (verb === 'POST') {
      headers['content-type'] = 'application/json';
      const csrf = await this.http.cookie(url, 'Csrfp-Token');
      if (csrf) headers['csrfp-token'] = csrf;
    }
    return this.http.request(url, { method: verb, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  /**
   * Find a live API version, starting at `from` (or the persisted one) and
   * walking up past 410/404. Only a version that answered is adopted and saved;
   * if none does, the previous version is kept and the call fails.
   */
  private probeVersion(from?: number): Promise<number> {
    this.versionProbe ??= (async () => {
      const start = from ?? (await loadState()).apiVersion ?? FIRST_VERSION;
      const token = await this.tokens.accessToken();
      let found: number | undefined;
      let verified = false;
      for (let v = start; v < start + MAX_VERSION_STEPS; v++) {
        const res = await this.request('GET', v, 'profiles.getProfilesByLogin', {}, token);
        if (res.status === 410 || res.status === 404) continue;
        if (res.status === 200) {
          found = v;
          verified = true;
        } else if (res.status === 401 || res.status === 403) {
          // The version exists; the token is the problem. send() refreshes and retries.
          found = v;
        } else {
          throw new ApiError(`Aula API version check answered HTTP ${res.status}.`, { status: res.status });
        }
        break;
      }
      if (found === undefined) {
        throw new ApiError(`No live Aula API version found between v${start} and v${start + MAX_VERSION_STEPS - 1}.`, {
          status: 410,
          hint: 'Aula may have changed its API; check for an aula-mcp update.',
        });
      }
      if (this.version !== found) log.debug('api.version', { from: this.version, to: found });
      this.version = found;
      if (verified) await saveState({ apiVersion: found }).catch(() => {});
      return found;
    })().finally(() => {
      this.versionProbe = undefined;
    });
    return this.versionProbe;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export function parseEnvelope<T>(method: string, status: number, body: string): T {
  let env: Envelope<T>;
  try {
    env = JSON.parse(body) as Envelope<T>;
  } catch {
    throw new ApiError(`Aula answered ${method} with a non-JSON page (HTTP ${status}); Aula may be down or under maintenance.`, {
      status,
      hint: 'Try again in a few minutes.',
    });
  }
  const code = env.status?.code ?? 0;
  if (status !== 200 || code !== 0) {
    throw new ApiError(`Aula ${method} failed: ${env.status?.message ?? `HTTP ${status}`} (code ${code}${env.status?.subCode !== undefined ? `/${env.status.subCode}` : ''}).`, {
      status,
      code,
      ...(env.status?.subCode !== undefined ? { subCode: env.status.subCode } : {}),
    });
  }
  return env.data as T;
}

function missingProfileContext(body: string): boolean {
  try {
    const s = (JSON.parse(body) as Envelope<unknown>).status;
    return s?.code === 10 && s.subCode === 23;
  } catch {
    return false;
  }
}

/** `key[]=a&key[]=b` for arrays, as the Aula web app sends them. */
export function query(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) q.append(`${k}[]`, String(item));
    else q.append(k, String(v));
  }
  return q.toString();
}

function serialize(params: Params): string {
  return query(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))));
}

const backoff = (attempt: number) => new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1) + Math.random() * 200));
