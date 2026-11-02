/**
 * Europe/Copenhagen time. Aula's calendar API answers in UTC (`+00:00`) while
 * people think in local time; every timestamp leaving this server is local,
 * and every window ("today", "this week") is computed in local time.
 */

import { InputError } from '../errors.js';

export const TZ = 'Europe/Copenhagen';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function cphParts(d: Date): Parts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFmt.formatToParts(d)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday ?? '',
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local calendar date, YYYY-MM-DD. */
export function cphDate(d: Date = new Date()): string {
  const p = cphParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Offset of Copenhagen from UTC at instant `d`, in minutes (60 or 120). */
export function cphOffsetMinutes(d: Date): number {
  const p = cphParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** The UTC instant of local midnight starting `date` (YYYY-MM-DD). */
export function cphMidnight(date: string): Date {
  const [y, m, d] = parseDate(date);
  // Two passes settle the offset even on DST change days.
  let guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  for (let i = 0; i < 2; i++) guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - cphOffsetMinutes(guess) * 60_000);
  return guess;
}

/** `YYYY-MM-DD HH:mm` in local time from anything Date can parse (ISO with offset). */
export function localDateTime(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const d = parseInstant(value);
  if (!d) return value;
  const p = cphParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Local `HH:mm` of an instant. */
export function localTime(value: string | undefined | null): string | undefined {
  return localDateTime(value)?.slice(11);
}

/**
 * Aula and vendor timestamps come as ISO with offset, `YYYY-MM-DD HH:mm:ss.0000+ZZZZ`,
 * or `YYYY/MM/DD HH:mm`. Strings without an offset are local wall time.
 */
export function parseInstant(value: string): Date | undefined {
  const v = value.trim();
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) {
    // Danish day-first dates (dd-mm-yyyy, dd.mm.yyyy, dd/mm/yyyy), as local wall time.
    const dk = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[T ](\d{2}):(\d{2}))?$/.exec(v);
    if (!dk) return undefined;
    const [, d, mo, y, h = '00', mi = '00'] = dk;
    return parseInstant(`${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')} ${h}:${mi}`);
  }
  const [, y, mo, d, h = '00', mi = '00', s = '00', zone] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone) {
    if (zone === 'Z') return new Date(wall);
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    return new Date(wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000);
  }
  const midnight = cphMidnight(`${y}-${mo}-${d}`);
  return new Date(midnight.getTime() + (wall - Date.UTC(Number(y), Number(mo) - 1, Number(d))));
}

/** Aula calendar request format: `YYYY-MM-DD HH:mm:ss.0000+ZZZZ`, local. */
export function aulaTimestamp(d: Date): string {
  const p = cphParts(d);
  const off = cphOffsetMinutes(d);
  const sign = off >= 0 ? '+' : '-';
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.0000${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

function parseDate(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new InputError(`Dates must be YYYY-MM-DD, got "${date}".`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Calendar arithmetic on YYYY-MM-DD, independent of time zones. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO weekday, Monday = 1. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** ISO week label, `YYYY-Www`, using the ISO week-numbering year. */
export function isoWeek(date: string): string {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const [ty] = parseDate(thursday);
  const jan4 = `${ty}-01-04`;
  const week1Monday = mondayOf(jan4);
  const days = (Date.UTC(...ymd(thursday)) - Date.UTC(...ymd(week1Monday))) / 86_400_000;
  return `${ty}-W${pad(Math.floor(days / 7) + 1)}`;
}

/** Monday (YYYY-MM-DD) of an ISO week label. */
export function isoWeekMonday(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new InputError(`Weeks must look like 2026-W41, got "${week}".`);
  return addDays(mondayOf(`${m[1]}-01-04`), (Number(m[2]) - 1) * 7);
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = parseDate(date);
  return [y, m - 1, d];
}

export interface DateRange {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export const RANGE_NAMES = ['today', 'tomorrow', 'this_week', 'next_week', 'next_7_days', 'next_14_days'] as const;
export type RangeName = (typeof RANGE_NAMES)[number];

/** Resolve a named range or explicit dates to inclusive local dates. */
export function resolveRange(opts: { range?: RangeName; from?: string; to?: string }, today = cphDate()): DateRange {
  if (opts.from || opts.to) {
    const from = opts.from ?? opts.to ?? today;
    const to = opts.to ?? from;
    parseDate(from);
    parseDate(to);
    if (to < from) throw new InputError(`"to" (${to}) is before "from" (${from}).`);
    return { from, to };
  }
  switch (opts.range ?? 'today') {
    case 'today':
      return { from: today, to: today };
    case 'tomorrow':
      return { from: addDays(today, 1), to: addDays(today, 1) };
    case 'this_week':
      return { from: mondayOf(today), to: addDays(mondayOf(today), 6) };
    case 'next_week':
      return { from: addDays(mondayOf(today), 7), to: addDays(mondayOf(today), 13) };
    case 'next_7_days':
      return { from: today, to: addDays(today, 6) };
    case 'next_14_days':
      return { from: today, to: addDays(today, 13) };
  }
}

/** Split an inclusive range into chunks of at most `days` days. */
export function chunkRange(range: DateRange, days: number): DateRange[] {
  const out: DateRange[] = [];
  let from = range.from;
  while (from <= range.to) {
    const end = addDays(from, days - 1);
    const to = end < range.to ? end : range.to;
    out.push({ from, to });
    from = addDays(to, 1);
  }
  return out;
}

const weekdayDa = ['', 'man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];

/** `2026-10-12 (man)`. */
export function labelDate(date: string): string {
  return `${date} (${weekdayDa[isoWeekday(date)]})`;
}
