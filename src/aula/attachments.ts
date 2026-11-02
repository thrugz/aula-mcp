/**
 * Attachment and photo downloads, by reference only. The model names an item
 * (thread, post, event, album) and an attachment id; the server re-reads that
 * item, takes the fresh signed URL from it, and only follows https URLs on
 * Aula's media hosts, re-checking every redirect. Size is capped while
 * streaming. The model never supplies a URL, so a prompt-injected message
 * cannot point the server at an internal address (the SSRF in prior art).
 */

import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { InputError, AulaError } from '../errors.js';
import { ensureDir, paths } from '../store/files.js';
import type { AulaClient } from './client.js';
import type { Family } from './family.js';
import { attachmentName, fetchMedia, fetchPosts, type RawAttachment, threadMessages } from './messages.js';

const MAX_BYTES = 50 * 1024 * 1024;

/** Aula's file hosts (media-prod.aula.dk and siblings). Exact suffix match, not substring. */
export function allowedHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && (host === 'aula.dk' || host.endsWith('.aula.dk'));
}

export type Source = 'message' | 'post' | 'event' | 'gallery';

function urlOf(a: RawAttachment | Record<string, unknown>): string | undefined {
  const x = a as RawAttachment & { url?: string; file?: { url?: string } };
  return x.file?.url ?? x.media?.file?.url ?? x.url ?? undefined;
}

/** Find the attachment again in its parent item; returns its current signed URL. */
export async function resolveAttachment(
  client: AulaClient,
  family: Family,
  source: Source,
  itemId: number | 'mine',
  attachmentId: string,
): Promise<{ url: string; name: string }> {
  const match = (list: Array<RawAttachment | Record<string, unknown>>) => {
    const hit = list.find((a) => String((a as { id?: unknown }).id) === attachmentId);
    const url = hit ? urlOf(hit) : undefined;
    return hit && url ? { url, name: attachmentName(hit as RawAttachment) } : undefined;
  };
  if (itemId === 'mine' && source !== 'gallery') throw new InputError('"mine" only applies to gallery downloads.');
  if (source === 'message' && typeof itemId === 'number') {
    for (let page = 0; page < 10; page++) {
      const t = await threadMessages(client, itemId, page);
      const found = match(t.messages.flatMap((m) => m.attachments ?? []));
      if (found) return found;
      if (!t.more) break;
    }
  } else if (source === 'post' && typeof itemId === 'number') {
    for (let page = 0; page < 10; page++) {
      const { posts, more } = await fetchPosts(client, family, { page, limit: 20, unreadOnly: false });
      const post = posts.find((p) => p.id === itemId);
      if (post) {
        const found = match(post.attachments ?? []);
        if (found) return found;
        break;
      }
      if (!more) break;
    }
  } else if (source === 'event' && typeof itemId === 'number') {
    const e = await client.get<{ attachments?: RawAttachment[] }>('calendar.getEventById', { eventId: itemId });
    const found = match(e?.attachments ?? []);
    if (found) return found;
  } else if (source === 'gallery') {
    const media = await fetchMedia(client, family, itemId, 200);
    const found = match(media);
    if (found) return found;
  }
  throw new InputError(`No attachment ${attachmentId} on ${source} ${itemId}. List the ${source} again to see current attachment ids.`);
}

/** Download to the scoped downloads dir; returns the local path. */
export async function download(url: string, name: string): Promise<{ path: string; bytes: number; type: string }> {
  let current = new URL(url);
  let res: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    if (!allowedHost(current)) throw new AulaError(`Refusing to download from ${current.host}: not an Aula media host.`);
    res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    break;
  }
  if (!res || res.status !== 200 || !res.body) throw new AulaError(`Download failed (HTTP ${res?.status ?? '?'}); the link may have expired, try again.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new AulaError(`File is ${Math.round(declared / 1e6)} MB, over the ${MAX_BYTES / 1e6} MB limit.`);

  const dir = paths.downloads();
  await ensureDir(dir);
  const path = join(dir, `${randomBytes(3).toString('hex')}-${safeName(name)}`);
  let bytes = 0;
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new AulaError(`File exceeds the ${MAX_BYTES / 1e6} MB limit.`);
      yield chunk;
    }
  };
  try {
    await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(path, { mode: 0o600 }));
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
  return { path, bytes, type: res.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Keep letters (æøå included), digits, dot, dash, underscore and space. */
export function safeName(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[^\p{L}\p{N}._\- ]+/gu, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 120);
}
