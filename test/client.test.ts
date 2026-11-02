import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AulaClient, query } from '../src/aula/client.js';
import type { TokenSource } from '../src/aula/session.js';
import { ApiError } from '../src/errors.js';
import { loadState } from '../src/store/state.js';
import { FakeFetch, json } from './helpers/fake-fetch.js';

class StaticTokens implements TokenSource {
  token = 'tok-1';
  renewals = 0;
  async accessToken() {
    return this.token;
  }
  async renew() {
    this.renewals++;
    this.token = `tok-${this.renewals + 1}`;
    return this.token;
  }
  age: number | undefined = 3600;
  async record() {
    return undefined;
  }
  async tokenAgeSeconds() {
    return this.age;
  }
}

const ok = (data: unknown) => json({ status: { code: 0, message: 'OK' }, data });
const method = (u: URL) => u.searchParams.get('method');

beforeEach(async () => {
  vi.stubEnv('AULA_MCP_DIR', await mkdtemp(join(tmpdir(), 'aula-mcp-client-')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AulaClient', () => {
  it('puts the token in the query, repeats array params, and bootstraps the profile context first', async () => {
    const f = new FakeFetch()
      .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () => ok({ profiles: [] }))
      .on('GET', (u) => method(u) === 'profiles.getProfileContext', () => ok({ userId: 1 }))
      .on('GET', (u) => method(u) === 'presence.getDailyOverview', (r) => {
        expect(r.url.searchParams.getAll('childIds[]')).toEqual(['1', '2']);
        expect(r.url.searchParams.get('access_token')).toBe('tok-1');
        expect(r.headers.get('authorization')).toBeNull();
        return ok([]);
      });
    f.install();
    const client = new AulaClient(new StaticTokens());
    await client.get('presence.getDailyOverview', { childIds: [1, 2] });
    const methods = f.calls.map((c) => method(c.url));
    expect(methods.indexOf('profiles.getProfileContext')).toBeLessThan(methods.indexOf('presence.getDailyOverview'));
    expect(f.calls.every((c) => c.url.pathname === '/api/v24/')).toBe(true);
  });

  it('walks up past retired API versions, replays the POST body, and remembers the version', async () => {
    const f = new FakeFetch()
      .on('GET', (u) => u.pathname === '/api/v24/', () => json({}, 410))
      .on('GET', (u) => u.pathname === '/api/v25/', () => json({}, 410))
      .on('POST', (u) => u.pathname === '/api/v24/', () => json({}, 410))
      .on('GET', (u) => u.pathname === '/api/v26/' && method(u) === 'profiles.getProfilesByLogin', () => ok({ profiles: [] }))
      .on('GET', (u) => u.pathname === '/api/v26/' && method(u) === 'profiles.getProfileContext', () => ok({}))
      .on('POST', (u) => u.pathname === '/api/v26/', (r) => {
        expect(JSON.parse(r.body)).toEqual({ a: 1 });
        return ok('saved');
      });
    f.install();
    const client = new AulaClient(new StaticTokens());
    expect(await client.post('presence.updatePresenceTemplate', { a: 1 })).toBe('saved');
    expect((await loadState()).apiVersion).toBe(26);
  });

  it('bootstraps again and retries once on code 10 / subCode 23', async () => {
    let posts = 0;
    let contexts = 0;
    new FakeFetch()
      .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () => ok({}))
      .on('GET', (u) => method(u) === 'profiles.getProfileContext', () => {
        contexts++;
        return ok({});
      })
      .on('POST', () => true, () => (++posts === 1 ? json({ status: { code: 10, subCode: 23, message: 'no profile' } }, 403) : ok('ok')))
      .install();
    const tokens = new StaticTokens();
    const client = new AulaClient(tokens);
    expect(await client.post('x.y', {})).toBe('ok');
    expect(contexts).toBe(2);
  });

  it('refreshes the token once on 401 and retries', async () => {
    new FakeFetch()
      .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () => ok({}))
      .on('GET', (u) => method(u) === 'profiles.getProfileContext', () => ok({}))
      .on('GET', (u) => method(u) === 'messaging.getThreads', (r) => (r.url.searchParams.get('access_token') === 'tok-1' ? json({}, 401) : ok({ threads: [] })))
      .install();
    const tokens = new StaticTokens();
    const client = new AulaClient(tokens);
    expect(await client.get('messaging.getThreads')).toEqual({ threads: [] });
    expect(tokens.renewals).toBe(1);
  });

  it('gives up on endless 410s and never saves a version that did not answer', async () => {
    new FakeFetch().on('GET', () => true, () => json({}, 410)).on('POST', () => true, () => json({}, 410)).install();
    const client = new AulaClient(new StaticTokens());
    await expect(client.get('messaging.getThreads')).rejects.toThrow(/No live Aula API version/);
    expect((await loadState()).apiVersion).toBeUndefined();
  });

  it('does not rotate a minutes-old token on a permission 403', async () => {
    new FakeFetch()
      .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () => ok({}))
      .on('GET', (u) => method(u) === 'profiles.getProfileContext', () => ok({}))
      .on('POST', () => true, () => json({ status: { code: 403, message: 'forbidden' } }, 403))
      .install();
    const tokens = new StaticTokens();
    tokens.age = 30;
    await expect(new AulaClient(tokens).post('calendar.getEventsByProfileIdsAndResourceIds', {})).rejects.toMatchObject({ status: 403 });
    expect(tokens.renewals).toBe(0);
  });

  it('reports envelope errors and HTML outage pages clearly', async () => {
    new FakeFetch()
      .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () => ok({}))
      .on('GET', (u) => method(u) === 'profiles.getProfileContext', () => ok({}))
      .on('GET', (u) => method(u) === 'a.b', () => json({ status: { code: 40, message: 'bad param' } }))
      .on('GET', (u) => method(u) === 'c.d', () => new Response('<html>Aula opdateres</html>', { status: 200 }))
      .install();
    const client = new AulaClient(new StaticTokens());
    await expect(client.get('a.b')).rejects.toMatchObject({ code: 40 });
    await expect(client.get('c.d')).rejects.toThrow(/non-JSON page/);
    await expect(client.get('a.b')).rejects.toBeInstanceOf(ApiError);
  });

  it('shares cached reads', async () => {
    const f = new FakeFetch()
      .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () => ok({}))
      .on('GET', (u) => method(u) === 'profiles.getProfileContext', () => ok({}))
      .on('GET', (u) => method(u) === 'messaging.getThreads', () => ok({ threads: [] }));
    f.install();
    const client = new AulaClient(new StaticTokens());
    await Promise.all([client.get('messaging.getThreads', { page: 0 }, { cacheSeconds: 30 }), client.get('messaging.getThreads', { page: 0 }, { cacheSeconds: 30 })]);
    expect(f.calls.filter((c) => method(c.url) === 'messaging.getThreads')).toHaveLength(1);
  });

  it('serialises query params like the Aula web app', () => {
    expect(query({ method: 'm', ids: [1, 2], skip: undefined, flag: false })).toBe('method=m&ids%5B%5D=1&ids%5B%5D=2&flag=false');
  });
});
