/**
 * Where the token encryption key comes from, first match wins:
 *
 *   1. AULA_MCP_KEY: 64 hex chars used as the raw key, anything else is a
 *      passphrase run through scrypt with the per-file salt.
 *   2. macOS Keychain item service "aula-mcp", account "token-key" (in
 *      AULA_MCP_KEYCHAIN if set, else the default keychain). Created on first
 *      use. The value is written through `security -i` on stdin, so it never
 *      appears in a process listing.
 *   3. A `key` file (0600) in the config dir, for platforms without a keychain.
 */

import { execFile, spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { promisify } from 'node:util';
import { AulaError } from '../errors.js';
import { paths, readIfExists, writeFileAtomic } from './files.js';

const run = promisify(execFile);
const SERVICE = 'aula-mcp';
const ACCOUNT = 'token-key';

export type KeySource = 'env' | 'keychain' | 'file';

export interface KeyMaterial {
  source: KeySource;
  /** Derive the AES key for a file. Raw keys ignore the salt. */
  derive(salt: Buffer): Buffer;
  /** True when the key needs a per-file salt (passphrase). */
  salted: boolean;
}

export async function resolveKey(opts: { create: boolean }): Promise<KeyMaterial | undefined> {
  const env = process.env.AULA_MCP_KEY?.trim();
  if (env) {
    if (/^[0-9a-f]{64}$/i.test(env)) return raw('env', Buffer.from(env, 'hex'));
    return { source: 'env', salted: true, derive: (salt) => scryptSync(env, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) };
  }
  if (useKeychain()) {
    const existing = await keychainRead();
    if (existing) return raw('keychain', existing);
    if (!opts.create) return undefined;
    const key = randomBytes(32);
    await keychainWrite(key);
    return raw('keychain', key);
  }
  const fromFile = await readIfExists(paths.keyFile());
  if (fromFile && /^[0-9a-f]{64}$/i.test(fromFile.trim())) return raw('file', Buffer.from(fromFile.trim(), 'hex'));
  if (!opts.create) return undefined;
  const key = randomBytes(32);
  await writeFileAtomic(paths.keyFile(), key.toString('hex'));
  return raw('file', key);
}

function raw(source: KeySource, key: Buffer): KeyMaterial {
  return { source, salted: false, derive: () => key };
}

function useKeychain(): boolean {
  return process.platform === 'darwin' && process.env.AULA_MCP_NO_KEYCHAIN !== '1';
}

function keychainArgs(): string[] {
  return process.env.AULA_MCP_KEYCHAIN ? [process.env.AULA_MCP_KEYCHAIN] : [];
}

async function keychainRead(): Promise<Buffer | undefined> {
  try {
    const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', ...keychainArgs()]);
    const hex = stdout.trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined;
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    if (err.code === 44 || /could not be found/i.test(err.stderr ?? '')) return undefined;
    throw new AulaError(`Reading the Aula key from the Keychain failed: ${(err.stderr ?? String(e)).trim()}`, {
      hint: 'Unlock the keychain, or set AULA_MCP_KEY, or set AULA_MCP_NO_KEYCHAIN=1 to use a key file.',
    });
  }
}

async function keychainWrite(key: Buffer): Promise<void> {
  const target = keychainArgs().map((k) => ` "${k.replace(/"/g, '\\"')}"`).join('');
  const command = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "aula-mcp token key" -w ${key.toString('hex')}${target}\n`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && !/error|fail/i.test(stderr)) resolve();
      else reject(new AulaError(`Saving the Aula key to the Keychain failed: ${stderr.trim() || `exit ${code}`}`));
    });
    child.stdin.end(command);
  });
  if (!(await keychainRead())?.equals(key)) throw new AulaError('Saved the Aula key to the Keychain but could not read it back.');
}
