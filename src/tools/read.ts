/** The read-only tools. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { download, resolveAttachment } from '../aula/attachments.js';
import { eventDetails, fetchEvents, formatDays, normaliseEvents } from '../aula/calendar.js';
import type { Child } from '../aula/family.js';
import {
  fetchAlbums,
  fetchMedia,
  fetchNotifications,
  fetchPosts,
  formatMessages,
  formatNotification,
  formatPost,
  formatThread,
  listThreads,
  threadMessages,
} from '../aula/messages.js';
import { formatPlan, formatPresence, presenceNow, presencePlan } from '../aula/presence.js';
import { clip, withinBudget } from '../aula/text.js';
import { addDays, cphDate, isoWeek, isoWeekMonday, labelDate, localDateTime, resolveRange } from '../aula/time.js';
import { enabledVendors, fetchAll, UNSUPPORTED_WIDGETS, type WeekItem } from '../aula/vendors/index.js';
import { InputError } from '../errors.js';
import { addTool, type App, childField, rangeFields } from './app.js';

const BUDGET = 24_000;

export function registerReadTools(server: McpServer, app: App): void {
  addTool(
    server,
    'aula_status',
    {
      title: 'Aula login and family overview',
      description:
        'Login state, token expiry, the children on the account (with school/daycare and class) and which weekly-plan sources are enabled. Cheap; call it when unsure what the account has or when another tool reports a login problem.',
      input: {},
    },
    async () => {
      const record = await app.session.record();
      if (!record) return 'Not logged in. The user must run `aula-mcp login` in a terminal (MitID approval).';
      const { family, label } = await app.children();
      const lines = [
        `Logged in as ${family.guardianName || record.username}${record.identity ? ` (identity: ${record.identity})` : ''}.`,
        `Access token valid until ${localDateTime(new Date(record.tokens.expires_at * 1000).toISOString())} (renews automatically).`,
        '',
        'Children:',
        ...family.children.map(
          (c) => `- ${c.name} (${label(c)})${c.institutionName ? `: ${c.institutionName}` : ''}${c.className ? `, class ${c.className}` : ''}`,
        ),
      ];
      const vendors = enabledVendors(family.widgets).map((v) => v.vendor.name);
      lines.push('', `Weekly plan sources (aula_weekplan): ${vendors.length ? vendors.join(', ') : 'none enabled for this account'}`);
      const unsupported = family.widgets.filter((w) => UNSUPPORTED_WIDGETS[w]).map((w) => UNSUPPORTED_WIDGETS[w]);
      if (unsupported.length) lines.push(`Enabled but not readable by this server: ${unsupported.join(', ')}`);
      lines.push(`Write tools: ${app.writeEnabled ? 'enabled' : 'disabled (set AULA_ENABLE_WRITE=1)'}`);
      return lines.join('\n');
    },
  );

  addTool(
    server,
    'aula_today',
    {
      title: 'Aula daily digest',
      description:
        'Everything for one day in one call: check-in status or plan, calendar events, weekly-plan items and homework for that day, and (for today) unread messages and new posts. Start here for "what is happening today/tomorrow".',
      input: {
        child: childField,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Day, YYYY-MM-DD. Default today (Copenhagen).'),
      },
    },
    async ({ child, date }) => {
      const { family, children, label } = await app.children(child);
      const day = date ?? cphDate();
      const isToday = day === cphDate();
      const range = { from: day, to: day };
      const sections: string[] = [`${labelDate(day)}${child ? `, ${children.map(label).join(', ')}` : ''}`];

      const presence = (async () => {
        if (isToday) {
          const now = await presenceNow(app.client, children);
          return ['Check-in:', ...children.map((c) => `  ${formatPresence(label(c), now.get(c.id))}`)].join('\n');
        }
        const plan = await presencePlan(app.client, children, range);
        return ['Drop-off/pick-up plan:', ...children.map((c) => `  ${formatPlan(label(c), plan.get(c.id), range).replace(/\n/g, '\n  ')}`)].join('\n');
      })();
      const calendar = (async () => {
        const ids = child ? children.map((c) => c.id) : [...children.map((c) => c.id), ...family.guardianProfileIds];
        const events = normaliseEvents(await fetchEvents(app.client, ids, range), family, label, child ? new Set(children.map((c) => c.id)) : undefined);
        if (events.length === 0) return 'Calendar: nothing.';
        return `Calendar:\n${formatDays(events, children.length > 1 || !child).map((d) => d.split('\n').slice(1).join('\n')).join('\n')}`;
      })();
      const plans = (async () => {
        const res = await timeout(weekplan(app, children, label, isoWeek(day)), 25_000, 'weekly plan sources were too slow');
        const items = res.items.filter((i) => i.date?.slice(0, 10) === day || i.due === day);
        const body = items.length ? formatItems(items, children.length > 1).join('\n') : '  nothing for this day';
        return `Weekly plan / homework:\n${body}${res.warnings.length ? `\n  (${res.warnings.join('; ')})` : ''}`;
      })();
      const inbox = isToday
        ? (async () => {
            const { threads, more } = await listThreads(app.client, { unreadOnly: true, startPage: 0, maxPages: 3, limit: 10 });
            const posts = await fetchPosts(app.client, family, { page: 0, limit: 5, unreadOnly: true });
            const t = threads.length ? threads.map((x) => `  ${formatThread(x).split('\n')[0]}`).join('\n') : '  none in the 60 newest threads';
            const p = posts.posts.length ? posts.posts.map((x) => `  #${x.id} ${localDateTime(x.publishAt ?? x.timestamp) ?? ''} ${x.title ?? ''}`).join('\n') : '  none';
            return `Unread messages${more ? ' (newest 60 checked)' : ''}:\n${t}\nUnread posts:\n${p}`;
          })()
        : Promise.resolve('');

      for (const part of await Promise.allSettled([presence, calendar, plans, inbox])) {
        if (part.status === 'fulfilled') {
          if (part.value) sections.push(part.value);
        } else sections.push(`(part failed: ${(part.reason as Error).message})`);
      }
      return clip(sections.join('\n\n'), BUDGET);
    },
  );

  addTool(
    server,
    'aula_presence',
    {
      title: 'Aula check-in status and pick-up plan',
      description:
        'Komme/gå: whether each child is checked in right now (sick, present, gone home, at a location...) and the registered drop-off/pick-up plan (who picks up, when, goes home alone, holiday) for a period. Default period: next 7 days.',
      input: { child: childField, ...rangeFields },
    },
    async ({ child, range, from, to }) => {
      const { children, label } = await app.children(child);
      const r = resolveRange({ range: range ?? (from || to ? undefined : 'next_7_days'), from, to } as Parameters<typeof resolveRange>[0]);
      const out: string[] = [];
      if (r.from <= cphDate() && cphDate() <= r.to) {
        const now = await presenceNow(app.client, children);
        out.push('Right now:', ...children.map((c) => `  ${formatPresence(label(c), now.get(c.id))}`), '');
      }
      const plan = await presencePlan(app.client, children, r);
      out.push(`Plan ${r.from}..${r.to}:`, ...children.map((c) => formatPlan(label(c), plan.get(c.id), r)));
      return out.join('\n');
    },
  );

  addTool(
    server,
    'aula_calendar',
    {
      title: 'Aula calendar',
      description:
        'Lessons and events in Copenhagen time, grouped by day, with substitute teachers, moved lessons and events needing a reply flagged. Without a child it also includes events for the parents (meetings). Pass eventId (the #number shown on an event) to get its full description and attachments. Default period: this week.',
      input: {
        child: childField,
        ...rangeFields,
        kinds: z.enum(['all', 'events_only', 'lessons_only']).optional().describe('Filter: all (default), events_only (skip lessons), lessons_only.'),
        eventId: z.number().int().positive().optional().describe('Show one event in full instead of a list.'),
      },
    },
    async ({ child, range, from, to, kinds, eventId }) => {
      if (eventId) return eventDetails(app.client, eventId);
      const { family, children, label } = await app.children(child);
      const r = resolveRange({ range: range ?? (from || to ? undefined : 'this_week'), from, to } as Parameters<typeof resolveRange>[0]);
      if (addDays(r.from, 120) < r.to) throw new InputError('Ask for at most 120 days at a time.');
      const ids = child ? children.map((c) => c.id) : [...children.map((c) => c.id), ...family.guardianProfileIds];
      let events = normaliseEvents(await fetchEvents(app.client, ids, r), family, label, child ? new Set(children.map((c) => c.id)) : undefined);
      if (kinds === 'events_only') events = events.filter((e) => e.type !== 'lesson');
      if (kinds === 'lessons_only') events = events.filter((e) => e.type === 'lesson');
      if (events.length === 0) return `No ${kinds === 'events_only' ? 'events' : kinds === 'lessons_only' ? 'lessons' : 'lessons or events'} ${r.from}..${r.to}.`;
      return `${r.from}..${r.to} (times are Copenhagen local)\n${withinBudget(formatDays(events, children.length > 1 || !child), BUDGET, 'days')}`;
    },
  );

  addTool(
    server,
    'aula_messages',
    {
      title: 'Aula message threads',
      description:
        'List message threads (beskeder), newest first, with sender, subject, preview and unread flag. unreadOnly scans several pages (Aula shows 20 per page) so older unread threads are found too. query filters on subject, sender and preview. Read a thread with aula_thread.',
      input: {
        unreadOnly: z.boolean().optional().describe('Only unread threads (default false).'),
        query: z.string().min(2).optional().describe('Case-insensitive text to match in subject, sender, preview or child.'),
        page: z.number().int().min(0).optional().describe('Start page (20 threads per page), default 0.'),
        maxPages: z.number().int().min(1).max(20).optional().describe('Pages to scan when filtering, default 5.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max threads to return, default 30.'),
      },
    },
    async ({ unreadOnly, query, page, maxPages, limit }) => {
      const res = await listThreads(app.client, {
        unreadOnly: !!unreadOnly,
        ...(query ? { query } : {}),
        startPage: page ?? 0,
        maxPages: maxPages ?? 5,
        limit: limit ?? 30,
      });
      const filtered = unreadOnly || query;
      const head = filtered
        ? `${res.threads.length} matching thread(s) in ${res.scannedPages} page(s) (${res.scannedPages * 20} newest threads)${res.more ? '; older threads exist, raise maxPages or page to look further' : '; that is all of them'}.`
        : `Page ${page ?? 0}${res.more ? ` (more: page=${(page ?? 0) + 1})` : ' (last page)'}.`;
      return `${head}\n${withinBudget(res.threads.map(formatThread), BUDGET, 'threads')}`;
    },
  );

  addTool(
    server,
    'aula_thread',
    {
      title: 'Read an Aula message thread',
      description:
        'All messages in one thread as plain text, oldest first, with attachment ids (download with aula_download source="message"). Reading does not mark the thread read in Aula. Sensitive threads may need a fresh MitID login.',
      input: {
        threadId: z.number().int().positive().describe('Thread id (the #number from aula_messages).'),
        page: z.number().int().min(0).optional().describe('0 = newest messages; higher pages go back in time.'),
      },
    },
    async ({ threadId, page }) => {
      const t = await threadMessages(app.client, threadId, page ?? 0);
      return formatMessages(t.subject, t.messages, t.more, threadId, 6000, BUDGET);
    },
  );

  addTool(
    server,
    'aula_posts',
    {
      title: 'Aula posts',
      description: 'News feed posts (opslag) from school, daycare and groups, newest first, as text with attachment ids (download with aula_download source="post").',
      input: {
        unreadOnly: z.boolean().optional().describe('Only posts not seen yet (default false).'),
        page: z.number().int().min(0).optional().describe('Page, default 0.'),
        limit: z.number().int().min(1).max(30).optional().describe('Posts per page, default 10.'),
      },
    },
    async ({ unreadOnly, page, limit }) => {
      const { family } = await app.children();
      const { posts, more } = await fetchPosts(app.client, family, { page: page ?? 0, limit: limit ?? 10, unreadOnly: !!unreadOnly });
      if (posts.length === 0) return unreadOnly ? 'No unread posts.' : 'No posts.';
      const blocks = posts.map((p) => formatPost(p, 3000));
      return `${withinBudget(blocks, BUDGET, 'posts')}${more ? `\n[More posts: page=${(page ?? 0) + 1}]` : ''}`;
    },
  );

  addTool(
    server,
    'aula_notifications',
    {
      title: 'Aula notifications',
      description: 'The notification feed (new messages, posts, events, photos, replies needed), newest first, with the ids to follow up on.',
      input: { limit: z.number().int().min(1).max(100).optional().describe('Max notifications, default 30.') },
    },
    async ({ limit }) => {
      const { family } = await app.children();
      const list = await fetchNotifications(app.client, family);
      if (list.length === 0) return 'No notifications.';
      return list.slice(0, limit ?? 30).map(formatNotification).join('\n');
    },
  );

  addTool(
    server,
    'aula_weekplan',
    {
      title: 'Aula weekly plan and homework',
      description:
        "The week's plan (ugeplan), homework (lektier/opgaver), weekly letters (ugebrev) and reminders (huskeliste) from every source the school uses (EasyIQ, Meebook, Min Uddannelse, Systematic), merged per child and day. Sources are picked automatically.",
      input: {
        child: childField,
        week: z
          .string()
          .optional()
          .describe('"this" (default), "next", an ISO week like 2026-W42, or any date YYYY-MM-DD in the week.'),
        sources: z
          .array(z.enum(['easyiq', 'meebook', 'minuddannelse', 'huskelisten']))
          .optional()
          .describe('Limit to these sources.'),
      },
    },
    async ({ child, week, sources }) => {
      const { children, label } = await app.children(child);
      const w = parseWeek(week);
      const res = await weekplan(app, children, label, w, sources);
      if (res.sources.length === 0) return 'No weekly-plan source (EasyIQ, Meebook, Min Uddannelse, Huskelisten) is enabled for this account.';
      const head = `${w} (${isoWeekMonday(w)}..${addDays(isoWeekMonday(w), 6)}), sources: ${res.sources.join(', ')}`;
      const body = res.items.length ? withinBudget(formatItems(res.items, children.length > 1), BUDGET, 'items') : 'Nothing published for this week.';
      return `${head}\n${body}${res.warnings.length ? `\n\nWarnings:\n${res.warnings.map((x) => `- ${x}`).join('\n')}` : ''}`;
    },
  );

  addTool(
    server,
    'aula_gallery',
    {
      title: 'Aula photo albums',
      description: 'Photo albums, newest first; with albumId the media in that album ("mine" = photos of your children). Save a photo with aula_download source="gallery".',
      input: {
        albumId: z.union([z.number().int().positive(), z.literal('mine')]).optional().describe('Album id, or "mine".'),
        limit: z.number().int().min(1).max(100).optional().describe('Max items, default 20.'),
      },
    },
    async ({ albumId, limit }) => {
      const { family } = await app.children();
      if (albumId === undefined) {
        const albums = await fetchAlbums(app.client, family, limit ?? 20);
        if (albums.length === 0) return 'No albums.';
        return albums
          .map((a) => {
            const created = localDateTime(String(a.creationDate ?? a.createdAt ?? ''));
            const by = (a.creator as { name?: string; fullName?: string } | undefined)?.name ?? (a.creator as { fullName?: string } | undefined)?.fullName;
            const count = a.size ?? a.mediaCount ?? a.totalSize;
            return `album ${a.id}: ${a.title ?? a.name ?? '(untitled)'}${created ? ` (${created.slice(0, 10)})` : ''}${by ? `, by ${by}` : ''}${count !== undefined ? `, ${count} items` : ''}`;
          })
          .join('\n');
      }
      const media = await fetchMedia(app.client, family, albumId, limit ?? 20);
      if (media.length === 0) return 'No media in this album.';
      return media
        .map((m) => {
          const file = (m.file as { name?: string } | undefined)?.name;
          const when = localDateTime(String(m.uploadedAt ?? m.createdAt ?? ''));
          return `media ${m.id}: ${m.mediaType ?? 'file'} ${m.title ?? file ?? ''}${when ? ` (${when})` : ''}`;
        })
        .join('\n');
    },
  );

  addTool(
    server,
    'aula_download',
    {
      title: 'Download an Aula attachment or photo',
      description:
        'Save an attachment or photo to a local file and return its path (open PDFs and images from that path). Identify it by where it was listed: source + the item id + the attachment/media id. URLs are never accepted.',
      input: {
        source: z.enum(['message', 'post', 'event', 'gallery']).describe('Where the attachment was listed.'),
        itemId: z
          .union([z.number().int().positive(), z.literal('mine')])
          .describe('Thread id, post id, event id or album id ("mine" for the album of your own children).'),
        attachmentId: z.union([z.string(), z.number()]).describe('The attachment or media id shown in the listing.'),
      },
    },
    async ({ source, itemId, attachmentId }) => {
      const { family } = await app.children();
      const { url, name } = await resolveAttachment(app.client, family, source, itemId, String(attachmentId));
      const file = await download(url, name);
      return `Saved ${name} (${Math.max(1, Math.round(file.bytes / 1024))} KB, ${file.type}) to:\n${file.path}`;
    },
  );
}

// --- weekly plan helpers ------------------------------------------------------

async function weekplan(app: App, children: Child[], label: (c: Child) => string, week: string, sources?: string[]) {
  const { family } = await app.children();
  return fetchAll(
    { client: app.client, family, children, week, monday: isoWeekMonday(week), username: await app.username(), label, tokens: app.widgets },
    sources,
  );
}

export function parseWeek(week?: string): string {
  const today = cphDate();
  if (!week || week === 'this') return isoWeek(today);
  if (week === 'next') return isoWeek(addDays(today, 7));
  if (/^\d{4}-W\d{2}$/.test(week)) return week;
  if (/^\d{4}-\d{2}-\d{2}$/.test(week)) return isoWeek(week);
  throw new InputError(`Week must be "this", "next", 2026-W42 or a date, got "${week}".`);
}

export function formatItems(items: WeekItem[], showChild: boolean): string[] {
  const order = (i: WeekItem) => `${showChild ? i.child : ''}|${i.date ?? i.due ?? '9999'}|${i.source}`;
  const sorted = [...items].sort((a, b) => order(a).localeCompare(order(b)));
  const out: string[] = [];
  let group = '';
  for (const i of sorted) {
    const g = showChild ? i.child : '';
    if (g && g !== group) {
      out.push(`\n${g}:`);
      group = g;
    }
    const when = !i.date ? 'week' : /^\d{4}-\d{2}-\d{2}/.test(i.date) ? labelDate(i.date.slice(0, 10)) + (i.date.length > 10 ? ` ${i.date.slice(11)}` : '') : i.date;
    const head = [`[${i.kind}]`, when, i.subject, i.title].filter(Boolean).join(' ');
    const due = i.due ? ` (due ${i.due})` : '';
    const text = i.text ? `\n    ${clip(i.text, 1200).replace(/\n/g, '\n    ')}` : '';
    out.push(`  ${head}${due} <${i.source}>${i.link ? ` ${i.link}` : ''}${text}`);
  }
  return out;
}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms).unref())]);
}

