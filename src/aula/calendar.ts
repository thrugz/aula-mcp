/**
 * Calendar: lessons and events. Aula answers in UTC and caps a request at 50
 * days (HTTP 200 with status 403 beyond), and returns one lesson object per
 * co-teacher. This module converts to local time, chunks long ranges and
 * merges the duplicate lessons.
 */

import type { AulaClient } from './client.js';
import type { Child, Family } from './family.js';
import { htmlToText, oneLine } from './text.js';
import { addDays, aulaTimestamp, chunkRange, cphMidnight, labelDate, localDateTime, type DateRange } from './time.js';

export interface RawEvent {
  id?: number;
  title?: string;
  type?: string;
  startDateTime?: string;
  endDateTime?: string;
  allDay?: boolean;
  primaryResource?: { name?: string } | null;
  belongsToProfiles?: number[];
  lesson?: {
    lessonStatus?: string;
    participants?: Array<{ teacherName?: string; teacherInitials?: string; participantRole?: string }>;
  } | null;
  hasAttachments?: boolean;
  oldStartDateTime?: string | null;
  oldEndDateTime?: string | null;
  responseRequired?: boolean;
  responseDeadline?: string | null;
  responseStatus?: string | null;
  creatorName?: string;
  description?: { html?: string } | string | null;
  attachments?: unknown[];
}

export interface CalendarEvent {
  id?: number;
  start: string;
  end?: string;
  allDay: boolean;
  title: string;
  type: string;
  who: string[];
  room?: string;
  teachers: string[];
  substitute: boolean;
  moved: boolean;
  responseRequired: boolean;
  responseDeadline?: string;
  hasAttachments: boolean;
}

export async function fetchEvents(client: AulaClient, profileIds: number[], range: DateRange): Promise<RawEvent[]> {
  const seen = new Map<string, RawEvent>();
  for (const chunk of chunkRange(range, 50)) {
    const data = await client.post<RawEvent[] | null>('calendar.getEventsByProfileIdsAndResourceIds', {
      instProfileIds: profileIds,
      resourceIds: [],
      start: aulaTimestamp(cphMidnight(chunk.from)),
      end: aulaTimestamp(cphMidnight(addDays(chunk.to, 1))),
    });
    for (const e of data ?? []) seen.set(`${e.id ?? ''}|${e.startDateTime}|${e.belongsToProfiles?.join(',')}`, e);
  }
  return [...seen.values()];
}

/** Normalise, attribute to children, and merge per-teacher lesson duplicates. */
export function normaliseEvents(raw: RawEvent[], family: Family, label: (c: Child) => string, onlyChildren?: Set<number>): CalendarEvent[] {
  const byId = new Map(family.children.map((c) => [c.id, c]));
  const guardian = new Set(family.guardianProfileIds);
  const merged = new Map<string, CalendarEvent>();
  for (const e of raw) {
    const start = localDateTime(e.startDateTime);
    if (!start) continue;
    const owners = e.belongsToProfiles ?? [];
    const kids = owners.map((id) => byId.get(id)).filter((c): c is Child => !!c);
    if (onlyChildren && !kids.some((c) => onlyChildren.has(c.id)) && !owners.some((id) => guardian.has(id))) continue;
    const who = kids.length ? kids.map(label) : owners.some((id) => guardian.has(id)) ? ['parent'] : [];
    const teachers = (e.lesson?.participants ?? []).map((p) => p.teacherInitials || p.teacherName || '').filter(Boolean);
    const substitute = e.lesson?.lessonStatus === 'substitute' || (e.lesson?.participants ?? []).some((p) => /substitute/i.test(p.participantRole ?? ''));
    const ev: CalendarEvent = {
      ...(e.id !== undefined ? { id: e.id } : {}),
      start,
      ...(localDateTime(e.endDateTime) ? { end: localDateTime(e.endDateTime)! } : {}),
      allDay: !!e.allDay,
      title: (e.title ?? '').trim() || '(untitled)',
      type: e.type ?? 'event',
      who,
      ...(e.primaryResource?.name ? { room: e.primaryResource.name } : {}),
      teachers,
      substitute,
      moved: !!(e.oldStartDateTime && e.oldStartDateTime !== e.startDateTime),
      responseRequired: !!e.responseRequired,
      ...(e.responseDeadline ? { responseDeadline: localDateTime(e.responseDeadline)! } : {}),
      hasAttachments: !!e.hasAttachments,
    };
    const key = ev.type === 'lesson' ? `lesson|${ev.title}|${ev.start}|${ev.end}|${who.join(',')}` : `${ev.id}|${ev.start}`;
    const prev = merged.get(key);
    if (prev) {
      prev.teachers = [...new Set([...prev.teachers, ...ev.teachers])];
      prev.substitute ||= ev.substitute;
    } else merged.set(key, ev);
  }
  return [...merged.values()].sort((a, b) => a.start.localeCompare(b.start) || a.who.join().localeCompare(b.who.join()));
}

export function formatEvent(e: CalendarEvent, showWho: boolean): string {
  const time = e.allDay ? 'all day' : `${e.start.slice(11)}${e.end ? `-${e.end.slice(0, 10) === e.start.slice(0, 10) ? e.end.slice(11) : e.end}` : ''}`;
  const tags: string[] = [];
  if (e.type !== 'lesson' && e.type !== 'event') tags.push(e.type.replace(/_/g, ' '));
  if (e.substitute) tags.push('SUBSTITUTE');
  if (e.moved) tags.push('MOVED');
  if (e.responseRequired) tags.push(`REPLY NEEDED${e.responseDeadline ? ` by ${e.responseDeadline}` : ''}`);
  if (e.hasAttachments) tags.push('attachments');
  const extra = [e.room, e.teachers.join('/')].filter(Boolean).join(', ');
  return `  ${time}  ${showWho && e.who.length ? `${e.who.join(', ')}: ` : ''}${e.title}${extra ? ` (${extra})` : ''}${tags.length ? ` [${tags.join('; ')}]` : ''}${e.id !== undefined && e.type !== 'lesson' ? ` #${e.id}` : ''}`;
}

/** Group by local date; one block per day. */
export function formatDays(events: CalendarEvent[], showWho: boolean): string[] {
  const days = new Map<string, CalendarEvent[]>();
  for (const e of events) days.set(e.start.slice(0, 10), [...(days.get(e.start.slice(0, 10)) ?? []), e]);
  return [...days.entries()].map(([day, list]) => `${labelDate(day)}\n${list.map((e) => formatEvent(e, showWho)).join('\n')}`);
}

/** Full details of one event (description and attachments are not in the list call). */
export async function eventDetails(client: AulaClient, eventId: number): Promise<string> {
  const e = await client.get<RawEvent & { invitedGroups?: Array<{ name?: string }>; attachments?: Array<{ id?: number; name?: string }> }>(
    'calendar.getEventById',
    { eventId },
  );
  const lines = [`#${eventId} ${e.title ?? ''}`.trim()];
  lines.push(`When: ${e.allDay ? `${localDateTime(e.startDateTime)?.slice(0, 10)} (all day)` : `${localDateTime(e.startDateTime)} - ${localDateTime(e.endDateTime) ?? '?'}`}`);
  if (e.type) lines.push(`Type: ${e.type.replace(/_/g, ' ')}`);
  if (e.primaryResource?.name) lines.push(`Where: ${e.primaryResource.name}`);
  if (e.creatorName) lines.push(`Created by: ${e.creatorName}`);
  if (e.invitedGroups?.length) lines.push(`Invited: ${oneLine(e.invitedGroups.map((g) => g.name).filter(Boolean).join(', '), 300)}`);
  if (e.responseRequired) lines.push(`Reply needed${e.responseDeadline ? ` by ${localDateTime(e.responseDeadline)}` : ''}${e.responseStatus ? ` (current: ${e.responseStatus})` : ''}`);
  const desc = typeof e.description === 'string' ? e.description : e.description?.html;
  if (desc) lines.push('', htmlToText(desc));
  if (e.attachments?.length) {
    lines.push('', 'Attachments (fetch with aula_download source="event"):');
    for (const a of e.attachments) lines.push(`  attachment ${a.id ?? '?'}: ${a.name ?? 'file'}`);
  }
  return lines.join('\n');
}
