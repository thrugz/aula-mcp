import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenSession } from '../src/aula/session.js';
import { ReauthRequiredError } from '../src/errors.js';
import { paths } from '../src/store/files.js';
import { clearRecord, loadRecord, saveRecord, type TokenRecord, withRefreshLock } from '../src/store/tokens.js';
import { FakeFetch, json } from './helpers/fake-fetch.js';

const now = () => Math.floor(Date.now() / 1000);
const record = (access: string, expiresIn: number, refresh = 'r1'): TokenRecord => ({
  version: 1,
  username: 'parent01',
  tokens: { access_token: access, refresh_token: refresh, expires_at: now() + expiresIn, obtained_at: now() },
  saved_at: now(),
});

beforeEach(async () => {
  vi.stubEnv('AULA_MCP_DIR', await mkdtemp(join(tmpdir(), 'aula-mcp-test-')));
  vi.stubEnv('AULA_MCP_KEY', 'a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('token store', () => {
  it('round-trips an encrypted record with 0600 permissions and no plaintext on disk', async () => {
    await saveRecord(record('secret-access', 3600));
    const raw = await readFile(paths.tokens(), 'utf8');
    expect(raw).not.toContain('secret-access');
    expect((await stat(paths.tokens())).mode & 0o777).toBe(0o600);
    expect((await loadRecord())?.tokens.access_token).toBe('secret-access');
  });

  it('supports a passphrase key (scrypt, per-file salt)', async () => {
    vi.stubEnv('AULA_MCP_KEY', 'correct horse battery staple');
    await saveRecord(record('pp-access', 3600));
    expect(JSON.parse(await readFile(paths.tokens(), 'utf8')).salt).toBeTruthy();
    expect((await loadRecord())?.tokens.access_token).toBe('pp-access');
  });

  it('asks for a new login when the key changed', async () => {
    await saveRecord(record('x', 3600));
    vi.stubEnv('AULA_MCP_KEY', 'b'.repeat(64));
    await expect(loadRecord()).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('returns nothing when not logged in, and clears', async () => {
    expect(await loadRecord()).toBeUndefined();
    await saveRecord(record('x', 3600));
    await clearRecord();
    expect(await loadRecord()).toBeUndefined();
  });

  it('serialises work under the refresh lock and takes over a dead holder', async () => {
    const order: string[] = [];
    await Promise.all([
      withRefreshLock(async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 50));
        order.push('a-end');
      }),
      withRefreshLock(async () => {
        order.push('b');
      }),
    ]);
    // Either may win the lock, but b never runs while a holds it.
    expect([['a-start', 'a-end', 'b'], ['b', 'a-start', 'a-end']]).toContainEqual(order);

    await writeFile(paths.lock(), '999999 0');
    expect(await withRefreshLock(async () => 'taken over', { waitMs: 2000 })).toBe('taken over');

    // A holder whose lock was taken over leaves the new owner's lock alone.
    await withRefreshLock(async () => {
      await writeFile(paths.lock(), 'someone else');
    });
    expect(await readFile(paths.lock(), 'utf8')).toBe('someone else');
  });
});

describe('token session', () => {
  it('refreshes near expiry and persists the rotated refresh token', async () => {
    await saveRecord(record('old-access', 60, 'refresh-old'));
    const f = new FakeFetch().on('POST', 'https://login.aula.dk/simplesaml/module.php/oidc/token.php', (r) => {
      expect(new URLSearchParams(r.body).get('refresh_token')).toBe('refresh-old');
      return json({ access_token: 'new-access', refresh_token: 'refresh-new', expires_in: 3600 });
    });
    f.install();
    const session = new TokenSession();
    expect(await session.accessToken()).toBe('new-access');
    expect((await loadRecord())?.tokens.refresh_token).toBe('refresh-new');
    expect(await session.accessToken()).toBe('new-access');
    expect(f.calls).toHaveLength(1);
  });

  it('uses a token another process already refreshed instead of rotating again', async () => {
    await saveRecord(record('stale', 60));
    const session = new TokenSession();
    await session.record();
    // Another process refreshes in the meantime.
    await saveRecord(record('fresh-from-other-process', 3600, 'r2'));
    const f = new FakeFetch();
    f.install();
    expect(await session.renew('stale')).toBe('fresh-from-other-process');
    expect(f.calls).toHaveLength(0);
  });

  it('turns a rejected refresh token into a login request', async () => {
    await saveRecord(record('old', 10));
    new FakeFetch().on('POST', 'https://login.aula.dk/simplesaml/module.php/oidc/token.php', () => json({ error: 'invalid_grant' }, 400)).install();
    await expect(new TokenSession().accessToken()).rejects.toBeInstanceOf(ReauthRequiredError);
  });
});
