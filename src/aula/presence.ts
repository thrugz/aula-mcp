/**
 * Komme/gå: today's check-in status and the planned drop-off/pick-up.
 * Status codes per Casperjuel's PRESENCE_STATUS_CODE (Aula frontend constants).
 */

import type { AulaClient } from './client.js';
import type { Child } from './family.js';
import { labelDate, type DateRange } from './time.js';

export const STATUS: Record<number, string> = {
  0: 'not arrived (ikke kommet)',
  1: 'sick (syg)',
  2: 'absent, reported (ferie/fri)',
  3: 'present (kommet)',
  4: 'on a trip (på tur)',
  5: 'sleeping (sover)',
  6: 'at a leisure activity (fritidsaktivitet)',
  7: 'at a location',
  8: 'gone home (gået)',
};

export const ACTIVITY = {
  picked_up_by: 0,
  self_decider: 1,
  send_home: 2,
  go_home_with: 3,
} as const;
export type ActivityName = keyof typeof ACTIVITY;
const ACTIVITY_LABEL: Record<number, string> = {
  0: 'picked up by',
  1: 'goes home on own (selvbestemmer)',
  2: 'sent home',
  3: 'goes home with',
};

interface Overview {
  institutionProfile?: { id?: number };
  status?: number;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  entryTime?: string | null;
  exitTime?: string | null;
  exitWith?: string | null;
  comment?: string | null;
  location?: { name?: string } | null;
  selfDeciderStartTime?: string | null;
  selfDeciderEndTime?: string | null;
  activityType?: number | null;
  sleepIntervals?: Array<{ startTime?: string; endTime?: string }>;
}

const hhmm = (t?: string | null) => (t && t !== '23:59:00' ? t.slice(0, 5) : undefined);

export async function presenceNow(client: AulaClient, children: Child[]): Promise<Map<number, Overview>> {
  const data = await client.get<Overview[] | null>('presence.getDailyOverview', { childIds: children.map((c) => c.id) });
  const out = new Map<number, Overview>();
  for (const entry of data ?? []) if (entry.institutionProfile?.id !== undefined) out.set(entry.institutionProfile.id, entry);
  return out;
}

export function formatPresence(label: string, o: Overview | undefined): string {
  if (!o) return `${label}: no check-in data (the institution may not use Komme/gå).`;
  const parts = [`${label}: ${STATUS[o.status ?? -1] ?? `status ${o.status}`}`];
  if (o.status === 7 && o.location?.name) parts[0] += ` (${o.location.name})`;
  if (hhmm(o.checkInTime)) parts.push(`checked in ${hhmm(o.checkInTime)}`);
  if (hhmm(o.checkOutTime)) parts.push(`checked out ${hhmm(o.checkOutTime)}`);
  const plan = planText({ ...o, exitWith: o.exitWith ?? null });
  if (plan) parts.push(`plan: ${plan}`);
  for (const s of o.sleepIntervals ?? []) if (s.startTime) parts.push(`slept ${hhmm(s.startTime)}-${hhmm(s.endTime) ?? ''}`);
  if (o.comment) parts.push(`note: ${o.comment}`);
  return parts.join(', ');
}

interface DayTemplate {
  byDate?: string;
  entryTime?: string | null;
  exitTime?: string | null;
  exitWith?: string | null;
  activityType?: number | null;
  selfDeciderStartTime?: string | null;
  selfDeciderEndTime?: string | null;
  isOnVacation?: boolean;
  comment?: string | null;
  spareTimeActivity?: { startTime?: string; endTime?: string; comment?: string } | null;
}

function planText(d: DayTemplate): string {
  const bits: string[] = [];
  if (hhmm(d.entryTime)) bits.push(`arrives ${hhmm(d.entryTime)}`);
  const type = d.activityType ?? undefined;
  if (type === 1 && (d.selfDeciderStartTime || d.selfDeciderEndTime)) {
    bits.push(`goes home on own ${hhmm(d.selfDeciderStartTime) ?? '?'}-${hhmm(d.selfDeciderEndTime) ?? '?'}`);
  } else if (hhmm(d.exitTime)) {
    const how = type !== undefined && type !== null ? ACTIVITY_LABEL[type] : undefined;
    bits.push(`leaves ${hhmm(d.exitTime)}${how ? `, ${how}${d.exitWith ? ` ${d.exitWith}` : ''}` : d.exitWith ? ` with ${d.exitWith}` : ''}`);
  }
  if (d.spareTimeActivity?.startTime) bits.push(`activity ${hhmm(d.spareTimeActivity.startTime)}-${hhmm(d.spareTimeActivity.endTime) ?? ''}`);
  return bits.join(', ');
}

export async function presencePlan(client: AulaClient, children: Child[], range: DateRange): Promise<Map<number, DayTemplate[]>> {
  const data = await client.get<{ presenceWeekTemplates?: Array<{ institutionProfile?: { id?: number }; dayTemplates?: DayTemplate[] }> }>(
    'presence.getPresenceTemplates',
    { filterInstitutionProfileIds: children.map((c) => c.id), fromDate: range.from, toDate: range.to },
  );
  const out = new Map<number, DayTemplate[]>();
  for (const w of data?.presenceWeekTemplates ?? []) {
    const id = w.institutionProfile?.id;
    if (id === undefined) continue;
    out.set(id, [...(out.get(id) ?? []), ...(w.dayTemplates ?? [])]);
  }
  return out;
}

export function formatPlan(label: string, days: DayTemplate[] | undefined, range: DateRange): string {
  const inRange = (days ?? []).filter((d) => d.byDate && d.byDate.slice(0, 10) >= range.from && d.byDate.slice(0, 10) <= range.to);
  if (inRange.length === 0) return `${label}: no drop-off/pick-up plan registered for ${range.from}..${range.to}.`;
  const lines = inRange
    .sort((a, b) => (a.byDate ?? '').localeCompare(b.byDate ?? ''))
    .map((d) => {
      const date = labelDate(d.byDate!.slice(0, 10));
      if (d.isOnVacation) return `  ${date}: on holiday (ferie registreret)`;
      const text = planText(d);
      return `  ${date}: ${text || 'nothing registered'}${d.comment ? ` (note: ${d.comment})` : ''}`;
    });
  return `${label}:\n${lines.join('\n')}`;
}

/** Body for presence.updatePresenceTemplate, as the Aula web app builds it. */
export function templateBody(args: {
  childId: number;
  date: string;
  activity: ActivityName;
  entryTime?: string;
  exitTime?: string;
  with?: string;
  selfDeciderStart?: string;
  selfDeciderEnd?: string;
  comment?: string;
  repeat?: 'never' | 'weekly' | 'every_2_weeks';
  repeatUntil?: string;
}): Record<string, unknown> {
  const entryTime = args.entryTime ?? null;
  const exitTime = args.exitTime ?? null;
  const block: Record<ActivityName, [string, Record<string, unknown>]> = {
    picked_up_by: ['pickup', { entryTime, exitTime, exitWith: args.with ?? null }],
    self_decider: ['selfDecider', { entryTime, exitStartTime: args.selfDeciderStart ?? null, exitEndTime: args.selfDeciderEnd ?? null }],
    send_home: ['sendHome', { entryTime, exitTime }],
    go_home_with: ['goHomeWith', { entryTime, exitTime, exitWith: args.with ?? null }],
  };
  const [key, value] = block[args.activity];
  const repeat = args.repeat ?? 'never';
  return {
    institutionProfileId: args.childId,
    byDate: args.date,
    presenceActivity: { activityType: ACTIVITY[args.activity], [key]: value },
    comment: args.comment ?? null,
    repeatPattern: repeat,
    expiresAt: repeat === 'never' ? null : (args.repeatUntil ?? null),
  };
}
