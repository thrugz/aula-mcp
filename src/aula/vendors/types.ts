/**
 * Shared shape for the vendor widgets behind "ugeplan" and friends. Each
 * vendor is reached with a short-lived widget token minted by Aula
 * (`aulaToken.getAulaToken&widgetId=`), and each wants different ids for the
 * same child; the vendor modules hide that from the tools.
 */

import { HttpClient, type HttpResponse } from '../../auth/http.js';
import { AulaError } from '../../errors.js';
import type { AulaClient } from '../client.js';
import type { Child, Family } from '../family.js';

export type ItemKind = 'plan' | 'note' | 'homework' | 'task' | 'letter' | 'reminder';

export interface WeekItem {
  child: string;
  source: string;
  kind: ItemKind;
  /** Local `YYYY-MM-DD` or `YYYY-MM-DD HH:mm`. */
  date?: string;
  /** Local `YYYY-MM-DD` when something is due. */
  due?: string;
  subject?: string;
  title?: string;
  text?: string;
  link?: string;
}

export interface VendorResult {
  items: WeekItem[];
  warnings: string[];
}

export interface VendorContext {
  client: AulaClient;
  family: Family;
  children: Child[];
  /** `YYYY-Www`. */
  week: string;
  /** Monday of `week`, `YYYY-MM-DD`. */
  monday: string;
  /** MitID username; some vendors use it as their session id. */
  username: string;
  label(child: Child): string;
  tokens: WidgetTokens;
}

export interface Vendor {
  id: string;
  name: string;
  /** Widget ids that enable this vendor, in preference order. */
  widgetIds: string[];
  fetch(ctx: VendorContext, widgetId: string): Promise<VendorResult>;
}

export class VendorError extends AulaError {}

/**
 * Widget tokens, cached for 50 s (they are short lived) and shared between
 * concurrent calls. `withToken` retries once with a fresh token when the
 * vendor says it expired, which some report as HTTP 200 with a message.
 */
export class WidgetTokens {
  private readonly cache = new Map<string, { until: number; token: Promise<string> }>();
  private readonly client: AulaClient;

  constructor(client: AulaClient) {
    this.client = client;
  }

  get(widgetId: string, fresh = false): Promise<string> {
    const hit = this.cache.get(widgetId);
    if (!fresh && hit && hit.until > Date.now()) return hit.token;
    const token = this.client.get<string>('aulaToken.getAulaToken', { widgetId }).then((t) => {
      if (typeof t !== 'string' || !t) throw new VendorError(`Aula issued no token for widget ${widgetId}.`);
      return t.replace(/^Bearer\s+/i, '');
    });
    this.cache.set(widgetId, { until: Date.now() + 50_000, token });
    token.catch(() => this.cache.delete(widgetId));
    return token;
  }

  async withToken(widgetId: string, call: (token: string) => Promise<HttpResponse>): Promise<HttpResponse> {
    const res = await call(await this.get(widgetId));
    if (!tokenExpired(res)) return res;
    return call(await this.get(widgetId, true));
  }
}

export function tokenExpired(res: HttpResponse): boolean {
  if (res.status === 401) return true;
  return res.body.length < 2000 && /JWT[- ]?Token expired|token (has )?expired/i.test(res.body);
}

/** Parse vendor JSON, turning HTML error pages and bad statuses into a clear error. */
export function vendorJson<T>(name: string, res: HttpResponse): T {
  if (res.status >= 300 && res.status < 400) throw new VendorError(`${name} redirected to ${res.headers.get('location') ?? 'a login page'} (session not accepted).`);
  if (res.status !== 200) throw new VendorError(`${name} answered HTTP ${res.status}.`);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new VendorError(`${name} answered with something other than JSON.`);
  }
}

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export const AULA_ORIGIN = { origin: 'https://www.aula.dk', referer: 'https://www.aula.dk/' };

/** A fresh cookie jar, for vendors that key their session on cookies. */
export function freshHttp(): HttpClient {
  return new HttpClient();
}

export const shared = new HttpClient();
