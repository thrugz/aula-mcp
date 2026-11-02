/**
 * EasyIQ: three widgets on two backends.
 *   0001  legacy weekplan API (api.easyiqcloud.dk)
 *   0128  SkolePortal weekplan (skoleportal.easyiqcloud.dk, per-child login id)
 *   0142  SkolePortal homework ("Lektier"), per-child login ids from GetChildren
 * Request shapes follow Casperjuel/aula-mcp, plus the class-level events
 * filter (`courseFilter=-1`) and the weekly note from its unmerged PR #104.
 */

import { htmlToText } from '../text.js';
import { localDateTime } from '../time.js';
import type { Child } from '../family.js';
import {
  AULA_ORIGIN,
  DESKTOP_UA,
  freshHttp,
  shared,
  type Vendor,
  type VendorContext,
  type VendorResult,
  VendorError,
  vendorJson,
  type WeekItem,
} from './types.js';

const PORTAL = 'https://skoleportal.easyiqcloud.dk';

function portalHeaders(token: string, ctx: VendorContext, widget: 'UgeplanWidget' | 'LektierWidget', extra: Record<string, string>) {
  return {
    bare: true as const,
    headers: {
      accept: '*/*',
      'accept-language': 'da-DK,da;q=0.9,en;q=0.8',
      authorization: `Bearer ${token}`,
      origin: PORTAL,
      referer: `${PORTAL}/${widget}`,
      'user-agent': DESKTOP_UA,
      'x-institutionfilter': ctx.family.institutionCodes.join(','),
      'x-userprofile': 'guardian',
      ...extra,
    },
  };
}

const pick = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
};

function localStamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const local = localDateTime(value);
  return local?.endsWith(' 00:00') ? local.slice(0, 10) : local;
}

function portalItem(ctx: VendorContext, child: Child, source: string, e: Record<string, unknown>, kind: WeekItem['kind']): WeekItem {
  const courses = pick(e, 'CoursesDisplay');
  const activities = pick(e, 'ActivitiesDisplay');
  const text = htmlToText(pick(e, 'Description', 'Text') ?? '');
  const date = localStamp(pick(e, 'StartTimeISO', 'StartTime', 'start'));
  return {
    child: ctx.label(child),
    source,
    // No course on an item means a notice ("Vigtig information"), not a lesson.
    kind: kind === 'plan' && !courses ? 'note' : kind,
    ...(date ? { date } : {}),
    ...(courses || activities ? { subject: [courses, activities].filter(Boolean).join(' / ') } : {}),
    ...(pick(e, 'ChapterTitle', 'Title') ? { title: pick(e, 'ChapterTitle', 'Title') } : {}),
    ...(text ? { text } : {}),
  };
}

export const easyiqLegacy: Vendor = {
  id: 'easyiq',
  name: 'EasyIQ Ugeplan',
  widgetIds: ['0001'],
  async fetch(ctx, widgetId) {
    const out: VendorResult = { items: [], warnings: [] };
    for (const child of ctx.children) {
      try {
        await legacyChild(ctx, widgetId, child, out);
      } catch (e) {
        out.warnings.push(`EasyIQ (${ctx.label(child)}): ${(e as Error).message}`);
      }
    }
    return out;
  },
};

async function legacyChild(ctx: VendorContext, widgetId: string, child: Child, out: VendorResult): Promise<void> {
  const res = await ctx.tokens.withToken(widgetId, (token) =>
    shared.request('https://api.easyiqcloud.dk/api/aula/weekplaninfo', {
      method: 'POST',
      bare: true,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        ...AULA_ORIGIN,
        'x-aula-institutionfilter': child.institutionCode ?? ctx.family.institutionCodes.join(','),
        'x-aula-userprofile': 'guardian',
      },
      body: JSON.stringify({
        sessionId: ctx.family.guardianUserId,
        currentWeekNr: ctx.week,
        userProfile: 'guardian',
        institutionFilter: child.institutionCode ? [child.institutionCode] : ctx.family.institutionCodes,
        childFilter: [child.id],
      }),
    }),
  );
  const data = vendorJson<{ Events?: Array<Record<string, unknown>>; ErrorCode?: string; ErrorDescription?: string }>('EasyIQ', res);
  if (data.ErrorCode && data.ErrorCode !== '0') {
    out.warnings.push(`EasyIQ (${ctx.label(child)}): ${data.ErrorDescription ?? `error ${data.ErrorCode}`}`);
    return;
  }
  for (const e of data.Events ?? []) {
    const date = localStamp(pick(e, 'start'));
    const text = htmlToText(pick(e, 'description') ?? '');
    out.items.push({
      child: ctx.label(child),
      source: 'EasyIQ',
      kind: String(e.itemType) === '5' ? 'note' : 'plan',
      ...(date ? { date } : {}),
      ...(pick(e, 'ownername') ? { subject: pick(e, 'ownername') } : {}),
      ...(pick(e, 'title') ? { title: pick(e, 'title') } : {}),
      ...(text ? { text } : {}),
    });
  }
}

export const easyiqSkoleportal: Vendor = {
  id: 'easyiq-skoleportal',
  name: 'EasyIQ SkolePortal',
  widgetIds: ['0128'],
  async fetch(ctx, widgetId) {
    const out: VendorResult = { items: [], warnings: [] };
    for (const child of ctx.children) {
      if (!child.userId) {
        out.warnings.push(`EasyIQ SkolePortal (${ctx.label(child)}): Aula has no unilogin id for this child.`);
        continue;
      }
      try {
        // The portal keys its session on cookies, so each child gets its own jar.
        const http = freshHttp();
        const token = await ctx.tokens.get(widgetId);
        const opts = portalHeaders(token, ctx, 'UgeplanWidget', {
          'x-childfilter': child.userId,
          'x-login': ctx.username,
          'x-requested-with': 'XMLHttpRequest',
        });
        const auth = vendorJson<{ loginId?: string | number; LoginId?: string | number; child?: string; Child?: string }>(
          'EasyIQ SkolePortal',
          await http.request(`${PORTAL}/Aula/AuthenticateAulaUser`, { ...opts, method: 'POST' }),
        );
        const authChild = auth.child ?? auth.Child;
        // Without a licence for this child the portal answers for a sibling (Casperjuel #121).
        if (authChild && String(authChild).toLowerCase() !== child.userId.toLowerCase()) {
          out.warnings.push(`EasyIQ SkolePortal (${ctx.label(child)}): no weekly plan licence for this child.`);
          continue;
        }
        const loginId = auth.loginId ?? auth.LoginId;
        if (loginId === undefined) throw new VendorError('no login id in the authentication answer');
        const date = `${ctx.monday}T00:00:00.000Z`;
        const q = new URLSearchParams({ loginId: String(loginId), date, courseFilter: '-1', textFilter: '', ownWeekPlan: 'false' });
        const events = vendorJson<unknown>('EasyIQ SkolePortal', await http.request(`${PORTAL}/Calendar/CalendarGetWeekplanEvents?${q}`, opts));
        for (const e of asList(events)) out.items.push(portalItem(ctx, child, 'EasyIQ', e, 'plan'));

        const noteRes = await http.request(
          `${PORTAL}/Calendar/WeekPlan?${new URLSearchParams({ loginId: String(loginId), date: `${ctx.monday}T00:00:00` })}`,
          opts,
        );
        if (noteRes.status === 200) {
          const note = safeParse<{ Show?: boolean; WeekPlans?: Array<{ ActivityName?: string; Text?: string; IsVisible?: boolean }> }>(noteRes.body);
          for (const wp of note?.WeekPlans ?? []) {
            const text = htmlToText(wp.Text ?? '');
            if (!text || wp.IsVisible === false) continue;
            out.items.push({ child: ctx.label(child), source: 'EasyIQ', kind: 'note', title: wp.ActivityName ? `Generelt om ugen: ${wp.ActivityName}` : 'Generelt om ugen', text });
          }
        }
      } catch (e) {
        out.warnings.push(`EasyIQ SkolePortal (${ctx.label(child)}): ${(e as Error).message}`);
      }
    }
    return out;
  },
};

export const easyiqLektier: Vendor = {
  id: 'easyiq-lektier',
  name: 'EasyIQ Lektier',
  widgetIds: ['0142'],
  async fetch(ctx, widgetId) {
    const out: VendorResult = { items: [], warnings: [] };
    const withIds = ctx.children.filter((c) => c.userId);
    if (withIds.length === 0) return { items: [], warnings: ['EasyIQ Lektier: Aula has no unilogin ids for the children.'] };
    const http = freshHttp();
    const token = await ctx.tokens.get(widgetId);
    const base = {
      'x-childfilter': withIds.map((c) => c.userId).join(','),
      'x-login': ctx.family.guardianUserId ?? '',
      'x-requested-with': 'Fetch',
    };
    const opts = (child: Child) => portalHeaders(token, ctx, 'LektierWidget', { ...base, 'x-child': child.userId ?? '' });
    await http.request(`${PORTAL}/Aula/AuthenticateAulaUser`, { ...opts(withIds[0]!), method: 'POST' });
    // The per-child login id comes from GetChildren; the auth answer's id returns [] for everyone.
    const kids = vendorJson<{ Children?: Array<{ Id?: string | number; Login?: string }> }>(
      'EasyIQ Lektier',
      await http.request(`${PORTAL}/Aula/GetChildren`, opts(withIds[0]!)),
    );
    for (const child of withIds) {
      const entry = kids.Children?.find((k) => k.Login?.toLowerCase() === child.userId!.toLowerCase());
      if (entry?.Id === undefined) {
        out.warnings.push(`EasyIQ Lektier (${ctx.label(child)}): not listed by EasyIQ.`);
        continue;
      }
      const q = new URLSearchParams({ loginId: String(entry.Id), date: `${ctx.monday}T00:00:00.000Z`, activityFilter: 'null' });
      try {
        const events = vendorJson<unknown>('EasyIQ Lektier', await http.request(`${PORTAL}/AulaHuskeliste/GetWeekplanEvents?${q}`, opts(child)));
        for (const e of asList(events)) out.items.push(portalItem(ctx, child, 'EasyIQ Lektier', e, 'homework'));
      } catch (e) {
        out.warnings.push(`EasyIQ Lektier (${ctx.label(child)}): ${(e as Error).message}`);
      }
    }
    return out;
  },
};

function asList(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  if (v && typeof v === 'object') {
    for (const k of ['Events', 'events', 'data', 'items', 'WeekPlan']) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function safeParse<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

