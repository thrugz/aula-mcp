/**
 * Messages (beskeder), posts (opslag), notifications and the gallery.
 *
 * Aula serves 20 threads per page and ignores pageSize, so "any unread?" has
 * to look past page one (Casperjuel #81); `listThreads` scans a bounded number
 * of pages and says when it stopped early. Attachments are listed by id only;
 * downloads re-resolve the id against the item (see attachments.ts).
 */

import { ApiError, AulaError } from '../errors.js';
import type { AulaClient } from './client.js';
import type { Family } from './family.js';
import { clip, htmlToText, oneLine } from './text.js';
import { localDateTime } from './time.js';

export interface RawAttachment {
  id?: number | string;
  name?: string;
  file?: { id?: number; name?: string; url?: string; size?: number } | null;
  media?: { id?: number; title?: string; file?: { name?: string; url?: string } | null } | null;
  link?: { url?: string } | null;
}

interface RawThread {
  id?: number;
  subject?: string;
  read?: boolean;
  isRead?: boolean;
  muted?: boolean;
  marked?: boolean;
  sensitive?: boolean;
  latestMessage?: { id?: string; sendDateTime?: string; sender?: { fullName?: string }; text?: { html?: string } | string };
  lastMessage?: { sendDateTime?: string; sender?: { fullName?: string } };
  regardingChildren?: Array<{ displayName?: string; profileId?: number }>;
  creator?: { fullName?: string };
}

export interface ThreadSummary {
  id: number;
  /** Id of the newest message, for the read marker. */
  latestMessageId?: string;
  subject: string;
  unread: boolean;
  date?: string;
  from?: string;
  preview?: string;
  regarding?: string;
  sensitive: boolean;
}

function summarise(t: RawThread): ThreadSummary | undefined {
  if (typeof t.id !== 'number') return undefined;
  const last = t.latestMessage ?? t.lastMessage;
  const text = typeof t.latestMessage?.text === 'string' ? t.latestMessage.text : t.latestMessage?.text?.html;
  const regarding = t.regardingChildren?.map((c) => c.displayName).filter(Boolean).join(', ');
  return {
    id: t.id,
    ...(t.latestMessage?.id ? { latestMessageId: String(t.latestMessage.id) } : {}),
    subject: (t.subject ?? '').trim() || '(no subject)',
    unread: t.read === false || t.isRead === false,
    ...(localDateTime(last?.sendDateTime) ? { date: localDateTime(last?.sendDateTime)! } : {}),
    // The thread list carries no sender for the latest message, only who started the thread.
    ...(t.creator?.fullName ? { from: t.creator.fullName } : {}),
    ...(text ? { preview: oneLine(htmlToText(text), 140) } : {}),
    ...(regarding ? { regarding } : {}),
    sensitive: !!t.sensitive,
  };
}

export async function threadsPage(client: AulaClient, page: number): Promise<{ threads: ThreadSummary[]; more: boolean }> {
  const data = await client.get<{ threads?: RawThread[]; moreMessagesExist?: boolean }>(
    'messaging.getThreads',
    { sortOn: 'date', orderDirection: 'desc', page },
    { cacheSeconds: 30 },
  );
  return { threads: (data?.threads ?? []).map(summarise).filter((t): t is ThreadSummary => !!t), more: !!data?.moreMessagesExist };
}

export async function listThreads(
  client: AulaClient,
  opts: { unreadOnly: boolean; query?: string; startPage: number; maxPages: number; limit: number },
): Promise<{ threads: ThreadSummary[]; scannedPages: number; more: boolean }> {
  const needle = opts.query?.toLowerCase();
  const out: ThreadSummary[] = [];
  let page = opts.startPage;
  let more = true;
  let scanned = 0;
  while (more && scanned < opts.maxPages && out.length < opts.limit) {
    const res = await threadsPage(client, page);
    scanned++;
    more = res.more;
    for (const t of res.threads) {
      if (opts.unreadOnly && !t.unread) continue;
      if (needle && ![t.subject, t.from, t.preview, t.regarding].some((f) => f?.toLowerCase().includes(needle))) continue;
      out.push(t);
    }
    page++;
    // Without filters one page is a full answer.
    if (!opts.unreadOnly && !needle) break;
  }
  return { threads: out.slice(0, opts.limit), scannedPages: scanned, more };
}

export function formatThread(t: ThreadSummary): string {
  const meta = [t.from ? `started by ${t.from}` : '', t.regarding ? `re ${t.regarding}` : ''].filter(Boolean).join('; ');
  return `#${t.id} ${t.unread ? '[UNREAD] ' : ''}${t.date ?? ''}  ${t.subject}${meta ? ` (${meta})` : ''}${t.sensitive ? ' [sensitive]' : ''}${t.preview ? `\n    ${t.preview}` : ''}`;
}

interface RawMessage {
  id?: string;
  messageType?: string;
  sendDateTime?: string;
  sender?: { fullName?: string; metadata?: string };
  text?: { html?: string } | string;
  attachments?: RawAttachment[];
}

export class StepUpRequiredError extends AulaError {}

export async function threadMessages(client: AulaClient, threadId: number, page = 0): Promise<{ subject: string; messages: RawMessage[]; more: boolean }> {
  try {
    const data = await client.get<{ subject?: string; messages?: RawMessage[]; moreMessagesExist?: boolean }>('messaging.getMessagesForThread', {
      threadId,
      page,
    });
    return { subject: data?.subject ?? '', messages: data?.messages ?? [], more: !!data?.moreMessagesExist };
  } catch (e) {
    if (e instanceof ApiError && e.code === 403) {
      throw new StepUpRequiredError(`Thread ${threadId} is marked sensitive and needs a fresh MitID login to read.`, {
        hint: 'Ask the user to run `aula-mcp login` again, then retry.',
      });
    }
    throw e;
  }
}

export function attachmentName(a: RawAttachment): string {
  return a.name ?? a.file?.name ?? a.media?.title ?? a.media?.file?.name ?? 'file';
}

export function formatMessages(subject: string, messages: RawMessage[], more: boolean, threadId: number, maxChars: number, budget: number): string {
  const blocks: string[] = [];
  const sorted = [...messages].sort((a, b) => (a.sendDateTime ?? '').localeCompare(b.sendDateTime ?? ''));
  for (const m of sorted) {
    if (m.messageType && m.messageType !== 'Message') {
      blocks.push(`-- ${localDateTime(m.sendDateTime) ?? ''} ${m.messageType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}${m.sender?.fullName ? ` (${m.sender.fullName})` : ''}`);
      continue;
    }
    const text = htmlToText(typeof m.text === 'string' ? m.text : m.text?.html);
    const lines = [`\n-- ${localDateTime(m.sendDateTime) ?? ''} ${m.sender?.fullName ?? '?'}${m.sender?.metadata ? ` (${m.sender.metadata})` : ''}:`, clip(text, maxChars)];
    for (const a of m.attachments ?? []) lines.push(`   attachment ${a.id ?? '?'}: ${attachmentName(a)}`);
    blocks.push(lines.join('\n'));
  }
  // Keep the newest messages whole when the thread is long, and say what was left out.
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (used + blocks[i]!.length > budget && kept.length > 0) {
      kept.unshift(`[${i + 1} older message(s) on this page not shown: output limit reached.]`);
      break;
    }
    kept.unshift(blocks[i]!);
    used += blocks[i]!.length;
  }
  const tail = more ? ['', '[Older messages exist: call again with page=+1.]'] : [];
  return [`Thread #${threadId}: ${subject || '(no subject)'}`, ...kept, ...tail].join('\n');
}

// --- posts -----------------------------------------------------------------

export interface RawPost {
  id?: number;
  title?: string;
  content?: { html?: string } | string;
  publishAt?: string;
  timestamp?: string;
  ownerProfile?: { fullName?: string; institution?: { institutionName?: string } };
  isImportant?: boolean;
  attachments?: RawAttachment[];
}

/** Posts are addressed to the guardian's and the children's institution profiles; without them Aula returns nothing. */
export function postProfileIds(family: Family): number[] {
  return [...new Set([...family.guardianProfileIds, ...family.children.map((c) => c.id)])];
}

export async function fetchPosts(client: AulaClient, family: Family, opts: { page: number; limit: number; unreadOnly: boolean }) {
  const data = await client.get<{ posts?: RawPost[]; hasMorePosts?: boolean; moreMessagesExist?: boolean }>('posts.getAllPosts', {
    parent: 'profile',
    // An offset, not a page number (miklen's traffic-captured client uses page * limit).
    index: opts.page * opts.limit,
    limit: opts.limit,
    isUnread: opts.unreadOnly,
    institutionProfileIds: postProfileIds(family),
  }, { cacheSeconds: 30 });
  return { posts: data?.posts ?? [], more: !!(data?.hasMorePosts ?? data?.moreMessagesExist) };
}

export function formatPost(p: RawPost, maxChars: number): string {
  const html = typeof p.content === 'string' ? p.content : p.content?.html;
  const head = `#${p.id ?? '?'} ${localDateTime(p.publishAt ?? p.timestamp) ?? ''}${p.isImportant ? ' [IMPORTANT]' : ''}  ${p.title ?? '(untitled)'}`;
  const by = [p.ownerProfile?.fullName, p.ownerProfile?.institution?.institutionName].filter(Boolean).join(', ');
  const att = (p.attachments ?? []).map((a) => `   attachment ${a.id ?? '?'}: ${attachmentName(a)}`);
  return [head, by ? `   by ${by}` : '', clip(htmlToText(html), maxChars), ...att].filter(Boolean).join('\n');
}

// --- notifications ---------------------------------------------------------

export async function fetchNotifications(client: AulaClient, family: Family): Promise<Array<Record<string, unknown>>> {
  const data = await client.get<unknown>('notifications.getNotificationsForActiveProfile', {
    activeChildrenIds: family.children.map((c) => c.id),
    activeInstitutionCodes: family.institutionCodes,
  });
  const list = Array.isArray(data) ? data : ((data as { notifications?: unknown[] })?.notifications ?? []);
  return list as Array<Record<string, unknown>>;
}

/** Notification shapes vary by type; show the fields that carry meaning. */
export function formatNotification(n: Record<string, unknown>): string {
  const str = (k: string) => (typeof n[k] === 'string' && (n[k] as string).trim() ? (n[k] as string).trim() : undefined);
  const when = localDateTime(str('triggered') ?? str('createdAt') ?? str('expires'));
  const type = (str('notificationEventType') ?? str('notificationType') ?? 'notification').replace(/([a-z])([A-Z])/g, '$1 $2');
  const about = [str('title'), str('postTitle'), str('threadSubject'), str('eventTitle'), str('albumName')].find(Boolean);
  const text = str('messageText') ?? str('content');
  const child = str('relatedChildName');
  const ref = (['threadId', 'postId', 'eventId', 'albumId'] as const).map((k) => (n[k] !== undefined && n[k] !== null ? `${k}=${n[k]}` : '')).filter(Boolean).join(' ');
  return `${when ?? ''} ${type}${child ? ` (${child})` : ''}${about ? `: ${oneLine(about, 120)}` : ''}${text ? ` - ${oneLine(htmlToText(text), 160)}` : ''}${ref ? ` [${ref}]` : ''}`.trim();
}

// --- gallery -----------------------------------------------------------------

export async function fetchAlbums(client: AulaClient, family: Family, limit: number) {
  const data = await client.get<unknown>('gallery.getAlbums', {
    index: 0,
    limit,
    sortOn: 'mediaCreatedAt',
    orderDirection: 'desc',
    filterBy: 'all',
    institutionProfileIds: postProfileIds(family),
  });
  return (Array.isArray(data) ? data : ((data as { albums?: unknown[] })?.albums ?? [])) as Array<Record<string, unknown>>;
}

export async function fetchMedia(client: AulaClient, family: Family, albumId: number | 'mine', limit: number) {
  const data = await client.get<unknown>('gallery.getMedia', {
    ...(albumId === 'mine' ? { userSpecificAlbum: true } : { albumId }),
    index: 0,
    limit,
    sortOn: 'uploadedAt',
    orderDirection: 'desc',
    filterBy: 'all',
    institutionProfileIds: postProfileIds(family),
  });
  const d = data as { results?: unknown[]; media?: unknown[]; mediaList?: unknown[] };
  return (Array.isArray(data) ? data : (d?.results ?? d?.media ?? d?.mediaList ?? [])) as Array<Record<string, unknown>>;
}
