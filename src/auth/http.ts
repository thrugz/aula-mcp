/**
 * fetch with a cookie jar, manual redirects and a timeout. Used by the login
 * flow, the Aula API client and the vendor integrations alike.
 */

import { Cookie, CookieJar } from 'tough-cookie';
import { redact, log } from '../log.js';
import { AulaError } from '../errors.js';

/**
 * The mobile Chrome fingerprint the scaarup/Casperjuel login flow is proven
 * with. Kept verbatim on purpose: STIL's bot protection sits in front of the
 * broker, so this is not the place for a fresher user agent. accept-encoding is
 * left to fetch, which also decodes it.
 */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent':
    'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'upgrade-insecure-requests': '1',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
});

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** Skip BROWSER_HEADERS (vendor calls set their own). */
  bare?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
  /** The URL this response came from (redirects are manual, so the request URL). */
  url: string;
}

export class NetworkError extends AulaError {}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  readonly jar: CookieJar;

  constructor(jar: CookieJar = new CookieJar()) {
    this.jar = jar;
  }

  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = req.bare ? {} : { ...BROWSER_HEADERS };
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.cookie = cookie;
    if (req.body instanceof URLSearchParams && !headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const method = req.method ?? 'GET';
    const started = Date.now();
    let res: Response;
    let body: string;
    try {
      res = await fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      // Inside the try: a body that stalls hits the same timeout and becomes a NetworkError.
      body = await res.text();
    } catch (e) {
      if (req.signal?.aborted) throw new AulaError('Cancelled.', { cause: e });
      const why = timeout.aborted ? `timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` : (e as Error).message;
      throw new NetworkError(`${method} ${redact(hostAndPath(url))} failed: ${why}`, { cause: e });
    }
    for (const raw of res.headers.getSetCookie()) {
      const parsed = Cookie.parse(raw);
      if (!parsed) continue;
      try {
        await this.jar.setCookie(parsed, url);
      } catch {
        // A cookie for a foreign domain or an expired one; ignore like a browser would.
      }
    }
    log.debug('http', { method, url: redact(url), status: res.status, ms: Date.now() - started });
    return { status: res.status, headers: res.headers, body, url };
  }

  /**
   * Follow 3xx responses up to `maxHops`. 303/301/302 become GET without a body,
   * 307/308 keep method and body. Calls `onHop` with each URL so callers can
   * stop on hosts they recognise (bot defense).
   */
  async follow(
    url: string,
    req: HttpRequest = {},
    opts: { maxHops?: number; onHop?: (url: string) => void } = {},
  ): Promise<{ final: HttpResponse; hops: string[] }> {
    const hops: string[] = [];
    let current = url;
    let currentReq = req;
    for (let i = 0; i < (opts.maxHops ?? 12); i++) {
      opts.onHop?.(current);
      hops.push(current);
      const res = await this.request(current, currentReq);
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return { final: res, hops };
      current = new URL(location, current).toString();
      const keep = res.status === 307 || res.status === 308;
      currentReq = keep ? req : { ...(req.headers ? { headers: req.headers } : {}) };
    }
    throw new AulaError(`Redirect chain exceeded ${opts.maxHops ?? 12} hops at ${redact(hostAndPath(current))}`);
  }

  async cookie(url: string, name: string): Promise<string | undefined> {
    const cookies = await this.jar.getCookies(url);
    return cookies.find((c) => c.key === name)?.value;
  }
}

export function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}
