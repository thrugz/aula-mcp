/**
 * Filesystem helpers: the config dir (0700) and atomic 0600 writes. A reader
 * never sees a half-written file, and the file is never briefly world-readable.
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function configDir(): string {
  return process.env.AULA_MCP_DIR || join(homedir(), '.config', 'aula-mcp');
}

export const paths = {
  tokens: () => join(configDir(), 'tokens.enc'),
  state: () => join(configDir(), 'state.json'),
  lock: () => join(configDir(), 'refresh.lock'),
  keyFile: () => join(configDir(), 'key'),
  downloads: () => process.env.AULA_MCP_DOWNLOAD_DIR || join(configDir(), 'downloads'),
};

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
