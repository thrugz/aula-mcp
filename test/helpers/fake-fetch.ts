/** A routing fake for global fetch: handlers match on method + URL. */

import { vi } from 'vitest';

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

type Handler = (req: FakeRequest) => Response | Promise<Response>;

export class FakeFetch {
  readonly calls: FakeRequest[] = [];
  private readonly routes: Array<{ method: string; test: (u: URL) => boolean; handler: Handler }> = [];

  on(method: string, match: string | RegExp | ((u: URL) => boolean), handler: Handler): this {
    const test =
      typeof match === 'function'
        ? match
        : typeof match === 'string'
          ? (u: URL) => `${u.origin}${u.pathname}` === match
          : (u: URL) => match.test(u.toString());
    this.routes.push({ method, test, handler });
    return this;
  }

  install(): void {
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body === undefined || init.body === null ? '' : String(init.body);
      const req: FakeRequest = { method, url, headers: new Headers(init.headers as HeadersInit), body };
      this.calls.push(req);
      const route = this.routes.find((r) => r.method === method && r.test(url));
      if (!route) throw new Error(`FakeFetch: no route for ${method} ${url}`);
      return route.handler(req);
    });
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });

export const redirect = (location: string, status = 302, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { location, ...headers } });

export const empty = (status: number) => new Response(null, { status });
