/**
 * The token record, encrypted at rest (AES-256-GCM) in `tokens.enc`, plus the
 * lock that serialises refreshes across processes. Refresh tokens may rotate,
 * so two processes refreshing at once could each invalidate the other's token;
 * the lock and a re-read inside it prevent that.
 */

import { link, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { aesGcmOpen, aesGcmSeal } from '../auth/crypto.js';
import type { Tokens } from '../auth/oauth.js';
import { AulaError, ReauthRequiredError } from '../errors.js';
import { ensureDir, configDir, paths, readIfExists, writeFileAtomic } from './files.js';
import { resolveKey } from './key.js';

export interface TokenRecord {
  version: 1;
  username: string;
  identity?: string;
  tokens: Tokens;
  saved_at: number;
}

interface Envelope {
  v: 1;
  alg: 'aes-256-gcm';
  salt?: string;
  data: string;
}

export async function saveRecord(record: TokenRecord): Promise<void> {
  const key = await resolveKey({ create: true });
  if (!key) throw new AulaError('No encryption key available.');
  const salt = key.salted ? randomBytes(16) : undefined;
  const sealed = aesGcmSeal(key.derive(salt ?? Buffer.alloc(0)), Buffer.from(JSON.stringify(record), 'utf8'), 12);
  const env: Envelope = { v: 1, alg: 'aes-256-gcm', ...(salt ? { salt: salt.toString('base64') } : {}), data: sealed.toString('base64') };
  await writeFileAtomic(paths.tokens(), JSON.stringify(env));
}

export async function loadRecord(): Promise<TokenRecord | undefined> {
  const text = await readIfExists(paths.tokens());
  if (text === undefined) return undefined;
  const key = await resolveKey({ create: false });
  if (!key) throw new ReauthRequiredError('Saved Aula tokens exist but their encryption key is missing.');
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new ReauthRequiredError('The saved Aula token file is corrupt.');
  }
  try {
    const plain = aesGcmOpen(key.derive(env.salt ? Buffer.from(env.salt, 'base64') : Buffer.alloc(0)), Buffer.from(env.data, 'base64'), 12);
    return JSON.parse(plain.toString('utf8')) as TokenRecord;
  } catch {
    throw new ReauthRequiredError(`The saved Aula tokens could not be decrypted with the ${key.source} key (was AULA_MCP_KEY changed?).`);
  }
}

export async function clearRecord(): Promise<void> {
  await rm(paths.tokens(), { force: true });
}

/**
 * Run `fn` holding `refresh.lock`. A lock older than `staleMs`, or held by a
 * process that no longer exists, is taken over.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>, opts: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  await ensureDir(configDir());
  const lock = paths.lock();
  const mine = `${process.pid} ${Date.now()} ${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  for (;;) {
    try {
      const fh = await open(lock, 'wx', 0o600);
      await fh.writeFile(mine);
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await lockInfo(lock);
      if (held && held.age > (opts.staleMs ?? 60_000)) {
        await takeOver(lock, held.content);
        continue;
      }
      if (Date.now() > deadline) throw new AulaError('Timed out waiting for another process to finish refreshing Aula tokens.');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    // Only release our own lock, never one another process has since taken over.
    if ((await readFile(lock, 'utf8').catch(() => undefined)) === mine) await rm(lock, { force: true });
  }
}

/**
 * Remove a stale lock without racing another waiter: move it aside atomically,
 * and if what was moved is not the lock judged stale (someone took over in
 * between), put it back unless a newer lock already exists.
 */
async function takeOver(lock: string, staleContent: string): Promise<void> {
  const aside = `${lock}.${randomBytes(6).toString('hex')}`;
  try {
    await rename(lock, aside);
  } catch {
    return; // Already gone: retry the create.
  }
  if ((await readFile(aside, 'utf8').catch(() => undefined)) !== staleContent) await link(aside, lock).catch(() => {});
  await rm(aside, { force: true });
}

async function lockInfo(lock: string): Promise<{ content: string; age: number } | undefined> {
  try {
    const content = await readFile(lock, 'utf8');
    const pid = Number(content.split(' ')[0]);
    if (pid && pid !== process.pid && !alive(pid)) return { content, age: Number.POSITIVE_INFINITY };
    return { content, age: Date.now() - (await stat(lock)).mtimeMs };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
