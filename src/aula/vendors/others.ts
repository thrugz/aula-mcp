/**
 * Meebook (0004), Min Uddannelse (0029 ugebrev, 0030 opgaver, 0023 SSO
 * fallback) and Systematic Huskelisten (0062). Request shapes follow
 * Casperjuel/aula-mcp and scaarup/aula.
 */

import type { Child } from '../family.js';
import { htmlToText } from '../text.js';
import { addDays, localDateTime } from '../time.js';
import { AULA_ORIGIN, shared, type Vendor, type VendorContext, type VendorResult, vendorJson, type WeekItem } from './types.js';

const DA_WEEKDAYS = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];

/** Meebook dates read like "mandag 28. nov."; map the weekday onto the requested week. */
export function meebookDate(label: string | undefined, monday: string): string | undefined {
  if (!label) return undefined;
  const i = DA_WEEKDAYS.findIndex((d) => label.toLowerCase().startsWith(d));
  return i >= 0 ? addDays(monday, i) : undefined;
}

export const meebook: Vendor = {
  id: 'meebook',
  name: 'Meebook',
  widgetIds: ['0004'],
  async fetch(ctx, widgetId) {
    const out: VendorResult = { items: [], warnings: [] };
    const kids = ctx.children.filter((c) => c.userId);
    if (kids.length === 0) return { items: [], warnings: ['Meebook: Aula has no unilogin ids for the children.'] };
    const q = new URLSearchParams({ currentWeekNumber: ctx.week, userProfile: 'guardian' });
    for (const c of kids) q.append('childFilter[]', c.userId!);
    for (const code of codesFor(ctx, kids)) q.append('institutionFilter[]', code);
    const res = await ctx.tokens.withToken(widgetId, (token) =>
      shared.request(`https://app.meebook.com/aulaapi/relatedweekplan/all?${q}`, {
        bare: true,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', sessionuuid: ctx.username, 'x-version': '1.0', ...AULA_ORIGIN },
      }),
    );
    const data = vendorJson<unknown>('Meebook', res);
    if (!Array.isArray(data)) {
      const msg = (data as { message?: string; exceptionMessage?: string })?.exceptionMessage ?? (data as { message?: string })?.message;
      return { items: [], warnings: [`Meebook: ${msg ?? 'unexpected answer'}${/f.rste gang|first time/i.test(msg ?? '') ? ' (open Meebook once from aula.dk in a browser to activate it)' : ''}`] };
    }
    for (const person of data as Array<{ name?: string; unilogin?: string; exceptionMessage?: string; weekPlan?: Array<{ date?: string; tasks?: Array<Record<string, unknown>> }> }>) {
      const child = kids.find((c) => c.userId?.toLowerCase() === person.unilogin?.toLowerCase());
      const label = child ? ctx.label(child) : (person.name ?? '?');
      if (person.exceptionMessage) out.warnings.push(`Meebook (${label}): ${person.exceptionMessage}`);
      for (const day of person.weekPlan ?? []) {
        const date = meebookDate(day.date, ctx.monday);
        for (const t of day.tasks ?? []) {
          const type = String(t.type ?? '');
          const subject = typeof t.pill === 'string' && !/ingen fag/i.test(t.pill) ? t.pill : undefined;
          const text = htmlToText(String(t.content ?? ''));
          out.items.push({
            child: label,
            source: 'Meebook',
            kind: type === 'assignment' ? 'homework' : type === 'comment' ? 'note' : 'plan',
            ...(date ? { date } : {}),
            ...(subject ? { subject } : {}),
            ...(typeof t.title === 'string' && t.title ? { title: t.title } : {}),
            ...(text ? { text } : {}),
          });
        }
      }
    }
    return out;
  },
};

/** Min Uddannelse wraps links as `/aula/redirect/<n>/<base64(urlencoded url)>`; unwrap to the real page. */
export function unwrapMuLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const last = url.split('/').filter(Boolean).pop();
  if (!last || !url.includes('/redirect/')) return url;
  try {
    const decoded = decodeURIComponent(Buffer.from(last, 'base64').toString('utf8'));
    return /^https?:\/\//.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function muQuery(ctx: VendorContext, kids: Child[]): string {
  return new URLSearchParams({
    assuranceLevel: '2',
    childFilter: kids.map((c) => c.userId).join(','),
    currentWeekNumber: ctx.week,
    isMobileApp: 'false',
    placement: 'narrow',
    sessionUUID: ctx.family.guardianUserId ?? '',
    userProfile: 'guardian',
  }).toString();
}

async function muGet<T>(ctx: VendorContext, widgetId: string, path: string, kids: Child[]): Promise<T> {
  const res = await ctx.tokens.withToken(widgetId, (token) =>
    shared.request(`https://api.minuddannelse.net/aula/${path}?${muQuery(ctx, kids)}`, {
      bare: true,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    }),
  );
  return vendorJson<T>('Min Uddannelse', res);
}

function byChildName(ctx: VendorContext, kids: Child[], name: string | undefined): string {
  const n = (name ?? '').toLowerCase();
  const hit = kids.find((c) => c.name.toLowerCase() === n) ?? kids.find((c) => n.startsWith(c.firstName.toLowerCase()));
  return hit ? ctx.label(hit) : (name ?? '?');
}

function muKids(ctx: VendorContext): Child[] | VendorResult {
  const kids = ctx.children.filter((c) => c.userId);
  // Numeric ids make Min Uddannelse answer 200 with nothing (Casperjuel #74), so refuse instead.
  return kids.length ? kids : { items: [], warnings: ['Min Uddannelse: Aula has no unilogin ids for the children.'] };
}

export const muWeeklyLetter: Vendor = {
  id: 'minuddannelse-ugebrev',
  name: 'Min Uddannelse ugebrev',
  widgetIds: ['0029', '0023'],
  async fetch(ctx, widgetId) {
    const kids = muKids(ctx);
    if (!Array.isArray(kids)) return kids;
    const data = await muGet<{ personer?: Array<{ navn?: string; institutioner?: Array<{ ugebreve?: Array<{ indhold?: string; tilknytningNavn?: string }> }> }> }>(ctx, widgetId, 'ugebrev', kids);
    const items: WeekItem[] = [];
    for (const p of data.personer ?? []) {
      for (const inst of p.institutioner ?? []) {
        for (const letter of inst.ugebreve ?? []) {
          const text = htmlToText(letter.indhold ?? '');
          if (!text) continue;
          items.push({ child: byChildName(ctx, kids, p.navn), source: 'Min Uddannelse', kind: 'letter', ...(letter.tilknytningNavn ? { subject: letter.tilknytningNavn } : {}), title: 'Ugebrev', text });
        }
      }
    }
    return { items, warnings: [] };
  },
};

export const muTasks: Vendor = {
  id: 'minuddannelse-opgaver',
  name: 'Min Uddannelse opgaver',
  widgetIds: ['0030', '0023'],
  async fetch(ctx, widgetId) {
    const kids = muKids(ctx);
    if (!Array.isArray(kids)) return kids;
    const data = await muGet<{ opgaver?: Array<Record<string, unknown>> }>(ctx, widgetId, 'opgaveliste', kids);
    const items: WeekItem[] = (data.opgaver ?? []).map((o) => {
      const hold = (o.hold as Array<{ navn?: string; fagNavn?: string }> | undefined)?.[0];
      const day = typeof o.ugedag === 'string' ? DA_WEEKDAYS.findIndex((d) => (o.ugedag as string).toLowerCase().startsWith(d)) : -1;
      const due = typeof o.afleveringsdato === 'string' ? localDateTime(o.afleveringsdato)?.slice(0, 10) : undefined;
      const link = unwrapMuLink(typeof o.url === 'string' ? o.url : undefined);
      return {
        child: byChildName(ctx, kids, o.kuvertnavn as string | undefined),
        source: 'Min Uddannelse',
        kind: 'task',
        ...(day >= 0 ? { date: addDays(ctx.monday, day) } : {}),
        ...(due ? { due } : {}),
        ...(hold?.fagNavn || hold?.navn ? { subject: hold.fagNavn ?? hold.navn } : {}),
        ...(typeof o.title === 'string' ? { title: o.erFaerdig === true ? `${o.title} (done)` : o.title } : {}),
        ...(link ? { link } : {}),
      };
    });
    return { items, warnings: [] };
  },
};

export const huskelisten: Vendor = {
  id: 'huskelisten',
  name: 'Systematic Huskelisten',
  widgetIds: ['0062'],
  async fetch(ctx, widgetId) {
    const from = ctx.monday;
    const q = new URLSearchParams({
      children: ctx.children.map((c) => c.id).join(','),
      institutions: codesFor(ctx, ctx.children).join(','),
      from,
      dueNoLaterThan: addDays(from, 13),
      widgetVersion: '1.10',
      userProfile: 'guardian',
      sessionId: ctx.username,
    });
    const res = await ctx.tokens.withToken(widgetId, (token) =>
      shared.request(`https://systematic-momo.dk/api/aula/reminders/v1?${q}`, {
        bare: true,
        headers: { 'aula-authorization': `Bearer ${token}`, accept: 'application/json, text/plain, */*', zone: 'Europe/Copenhagen', ...AULA_ORIGIN },
      }),
    );
    const data = vendorJson<Array<Record<string, unknown>>>('Huskelisten', res);
    const items: WeekItem[] = [];
    for (const person of Array.isArray(data) ? data : []) {
      const child = byChildName(ctx, ctx.children, person.userName as string | undefined);
      const lists: Array<[string, Array<Record<string, unknown>>]> = [
        ['team', (person.teamReminders as Array<Record<string, unknown>>) ?? []],
        ['course', (person.courseReminders as Array<Record<string, unknown>>) ?? []],
        ['assignment', (person.assignmentReminders as Array<Record<string, unknown>>) ?? []],
      ];
      for (const [, list] of lists) {
        for (const r of list) {
          const due = typeof r.dueDate === 'string' ? localDateTime(r.dueDate)?.slice(0, 10) : undefined;
          const text = htmlToText(String(r.reminderText ?? r.assignmentText ?? ''));
          const subject = (r.subjectName as string) ?? (Array.isArray(r.courseSubjects) ? (r.courseSubjects as string[]).join(', ') : undefined);
          const title = (r.teamName as string) ?? (Array.isArray(r.teamNames) ? (r.teamNames as string[]).join(', ') : undefined);
          items.push({
            child,
            source: 'Huskelisten',
            kind: 'reminder',
            ...(due ? { due } : {}),
            ...(subject ? { subject } : {}),
            ...(title ? { title } : {}),
            ...(text ? { text } : {}),
          });
        }
      }
    }
    return { items, warnings: [] };
  },
};

function codesFor(ctx: VendorContext, kids: Child[]): string[] {
  const codes = [...new Set(kids.map((c) => c.institutionCode).filter((c): c is string => !!c))];
  return codes.length ? codes : ctx.family.institutionCodes;
}
