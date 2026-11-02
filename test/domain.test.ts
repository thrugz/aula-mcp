import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedHost, download, safeName } from '../src/aula/attachments.js';
import { formatDays, normaliseEvents, type RawEvent } from '../src/aula/calendar.js';
import { AulaClient } from '../src/aula/client.js';
import { childLabel, parseFamily } from '../src/aula/family.js';
import { formatMessages, formatNotification, formatThread } from '../src/aula/messages.js';
import { formatPlan, formatPresence, templateBody } from '../src/aula/presence.js';
import { easyiqSkoleportal } from '../src/aula/vendors/easyiq.js';
import { meebookDate, muTasks, unwrapMuLink } from '../src/aula/vendors/others.js';
import { WidgetTokens, type VendorContext } from '../src/aula/vendors/types.js';
import { FakeFetch, json } from './helpers/fake-fetch.js';

const family = parseFamily(
  {
    profiles: [
      {
        displayName: 'Parent',
        institutionProfiles: [{ id: 900, institutionCode: 'G1' }],
        children: [
          { id: 101, name: 'Ørn Eksempel', userId: 'barn1', institutionProfile: { institutionCode: 'G1' } },
          { id: 102, name: 'Måge Eksempel', userId: 'barn2', institutionProfile: { institutionCode: 'G1' } },
        ],
      },
    ],
  },
  { userId: 77, pageConfiguration: { widgetConfigurations: [] } },
);
const label = (c: Parameters<typeof childLabel>[1]) => childLabel(family, c);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('calendar', () => {
  const lesson = (teacher: string, lessonId: number): RawEvent => ({
    id: lessonId,
    type: 'lesson',
    title: 'Dansk',
    startDateTime: '2026-10-12T06:00:00+00:00',
    endDateTime: '2026-10-12T06:45:00+00:00',
    belongsToProfiles: [101],
    primaryResource: { name: 'A12' },
    lesson: { lessonStatus: 'normal', participants: [{ teacherInitials: teacher, participantRole: 'primaryTeacher' }] },
  });

  it('shows Copenhagen time and merges one-lesson-per-teacher duplicates', () => {
    const events = normaliseEvents([lesson('LB', 1), lesson('KM', 2)], family, label);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start: '2026-10-12 08:00', end: '2026-10-12 08:45', teachers: ['LB', 'KM'], who: ['Ørn'] });
    expect(formatDays(events, true)[0]).toBe('2026-10-12 (man)\n  08:00-08:45  Ørn: Dansk (A12, LB/KM)');
  });

  it('flags substitutes, moved lessons, replies and attributes parent events', () => {
    const events = normaliseEvents(
      [
        { ...lesson('VK', 3), lesson: { lessonStatus: 'substitute', participants: [{ teacherInitials: 'VK', participantRole: 'substituteTeacher' }] }, oldStartDateTime: '2026-10-12T05:00:00+00:00' },
        { id: 9, type: 'parental_meeting', title: 'Forældremøde', startDateTime: '2026-10-13T16:00:00+00:00', endDateTime: '2026-10-13T17:30:00+00:00', belongsToProfiles: [900], responseRequired: true, responseDeadline: '2026-10-11T21:59:00+00:00' },
      ],
      family,
      label,
    );
    const text = formatDays(events, true).join('\n');
    expect(text).toContain('[SUBSTITUTE; MOVED]');
    expect(text).toContain('18:00-19:30  parent: Forældremøde [parental meeting; REPLY NEEDED by 2026-10-11 23:59] #9');
  });

  it('drops events of other children when one child is asked for', () => {
    const other = { ...lesson('X', 5), belongsToProfiles: [102], title: 'Matematik' };
    expect(normaliseEvents([lesson('LB', 1), other], family, label, new Set([101])).map((e) => e.title)).toEqual(['Dansk']);
  });
});

describe('family widgets', () => {
  it('normalises widget ids, including the 00142 variant', () => {
    const f = parseFamily({ profiles: [] }, { pageConfiguration: { widgetConfigurations: [{ widgetId: '00142' }, { widgetId: 142 }, { widget: { widgetId: '0029' } }] } });
    expect(f.widgets).toEqual(['0029', '0142']);
  });
});

describe('presence', () => {
  it('describes status, check-in and plan', () => {
    expect(formatPresence('Ørn', { status: 3, checkInTime: '07:42:00', exitTime: '15:00:00', exitWith: 'Mormor', activityType: 0 })).toBe(
      'Ørn: present (kommet), checked in 07:42, plan: leaves 15:00, picked up by Mormor',
    );
    expect(formatPresence('Måge', { status: 7, location: { name: 'Hallen' } })).toBe('Måge: at a location (Hallen)');
    expect(formatPresence('Måge', undefined)).toMatch(/no check-in data/);
  });

  it('lists the plan per day, including holidays and self-decider windows', () => {
    const text = formatPlan(
      'Ørn',
      [
        { byDate: '2026-10-13', entryTime: '08:00:00', activityType: 1, selfDeciderStartTime: '14:00:00', selfDeciderEndTime: '15:00:00' },
        { byDate: '2026-10-12', isOnVacation: true },
      ],
      { from: '2026-10-12', to: '2026-10-18' },
    );
    expect(text).toBe('Ørn:\n  2026-10-12 (man): on holiday (ferie registreret)\n  2026-10-13 (tir): arrives 08:00, goes home on own 14:00-15:00');
  });

  it('builds the presence template body the Aula web app sends', () => {
    expect(templateBody({ childId: 101, date: '2026-10-20', activity: 'picked_up_by', entryTime: '07:30', exitTime: '15:00', with: 'Farmor' })).toEqual({
      institutionProfileId: 101,
      byDate: '2026-10-20',
      presenceActivity: { activityType: 0, pickup: { entryTime: '07:30', exitTime: '15:00', exitWith: 'Farmor' } },
      comment: null,
      repeatPattern: 'never',
      expiresAt: null,
    });
    expect(templateBody({ childId: 1, date: '2026-10-20', activity: 'self_decider', selfDeciderStart: '14:00', selfDeciderEnd: '15:00', repeat: 'weekly', repeatUntil: '2026-12-18' })).toMatchObject({
      presenceActivity: { activityType: 1, selfDecider: { entryTime: null, exitStartTime: '14:00', exitEndTime: '15:00' } },
      repeatPattern: 'weekly',
      expiresAt: '2026-12-18',
    });
  });
});

describe('messages', () => {
  it('formats threads with unread flag, sender and local time', () => {
    expect(formatThread({ id: 5, subject: 'Tur', unread: true, date: '2026-10-09 14:02', from: 'Lise', preview: 'Husk madpakke', sensitive: false })).toBe(
      '#5 [UNREAD] 2026-10-09 14:02  Tur (started by Lise)\n    Husk madpakke',
    );
  });

  it('keeps the newest messages of a long thread and says what it left out', () => {
    const msg = (day: number, text: string) => ({ id: String(day), messageType: 'Message', sendDateTime: `2026-10-0${day}T10:00:00+00:00`, sender: { fullName: `P${day}` }, text: { html: text } });
    const out = formatMessages('Tur', [msg(3, 'c'.repeat(300)), msg(1, 'a'.repeat(300)), msg(2, 'b'.repeat(300))], false, 9, 6000, 700);
    expect(out).toContain('[1 older message(s) on this page not shown');
    expect(out).toContain('P3');
    expect(out).toContain('P2');
    expect(out).not.toContain('P1');
    expect(out.indexOf('P2')).toBeLessThan(out.indexOf('P3'));
  });

  it('formats notifications of unknown shape from their meaningful fields', () => {
    expect(formatNotification({ notificationEventType: 'PostSharedWithMe', triggered: '2026-10-09T08:00:00+00:00', postTitle: 'Høstfest', postId: 42 })).toBe(
      '2026-10-09 10:00 Post Shared With Me: Høstfest [postId=42]',
    );
  });
});

describe('vendors', () => {
  beforeEach(async () => {
    vi.stubEnv('AULA_MCP_DIR', await mkdtemp(join(tmpdir(), 'aula-mcp-vendor-')));
  });

  const ctxWith = (client: AulaClient): VendorContext => ({
    client,
    family,
    children: family.children,
    week: '2026-W42',
    monday: '2026-10-12',
    username: 'parent01',
    label,
    tokens: new WidgetTokens(client),
  });
  const aula = (f: FakeFetch) =>
    f
      .on('GET', (u) => u.host === 'www.aula.dk' && u.searchParams.get('method') === 'profiles.getProfilesByLogin', () => json({ status: { code: 0 }, data: {} }))
      .on('GET', (u) => u.host === 'www.aula.dk' && u.searchParams.get('method') === 'profiles.getProfileContext', () => json({ status: { code: 0 }, data: {} }))
      .on('GET', (u) => u.host === 'www.aula.dk' && u.searchParams.get('method') === 'aulaToken.getAulaToken', () => json({ status: { code: 0 }, data: 'widget-jwt' }));
  const tokens = { accessToken: async () => 't', renew: async () => 't', record: async () => undefined };

  it('maps Meebook weekday labels onto the requested week', () => {
    expect(meebookDate('onsdag 14. okt.', '2026-10-12')).toBe('2026-10-14');
    expect(meebookDate('hello', '2026-10-12')).toBeUndefined();
  });

  it('unwraps Min Uddannelse redirect links', () => {
    const target = 'https://www.minuddannelse.net/Node/minuge/123?uge=2026-W42';
    const wrapped = `https://api.minuddannelse.net/aula/redirect/1/${Buffer.from(encodeURIComponent(target)).toString('base64').replace(/=+$/, '')}`;
    expect(unwrapMuLink(wrapped)).toBe(target);
  });

  it('sends unilogin ids to Min Uddannelse and attributes tasks to children', async () => {
    const f = aula(new FakeFetch()).on('GET', 'https://api.minuddannelse.net/aula/opgaveliste', (r) => {
      expect(r.url.searchParams.get('childFilter')).toBe('barn1,barn2');
      expect(r.url.searchParams.get('sessionUUID')).toBe('77');
      expect(r.headers.get('authorization')).toBe('Bearer widget-jwt');
      return json({ opgaver: [{ title: 'Læs side 4', kuvertnavn: 'Måge Eksempel', ugedag: 'Tirsdag', hold: [{ fagNavn: 'Dansk' }], erFaerdig: false }] });
    });
    f.install();
    const res = await muTasks.fetch(ctxWith(new AulaClient(tokens)), '0030');
    expect(res.items).toEqual([{ child: 'Måge', source: 'Min Uddannelse', kind: 'task', date: '2026-10-13', subject: 'Dansk', title: 'Læs side 4' }]);
  });

  it('refuses a sibling\'s SkolePortal plan for an unlicensed child (Casperjuel #121)', async () => {
    const f = aula(new FakeFetch())
      .on('POST', 'https://skoleportal.easyiqcloud.dk/Aula/AuthenticateAulaUser', (r) =>
        json({ loginId: 5, child: r.headers.get('x-childfilter') === 'barn2' ? 'barn1' : 'barn1' }),
      )
      .on('GET', 'https://skoleportal.easyiqcloud.dk/Calendar/CalendarGetWeekplanEvents', (r) => {
        expect(r.url.searchParams.get('courseFilter')).toBe('-1');
        expect(r.url.searchParams.get('date')).toBe('2026-10-12T00:00:00.000Z');
        return json([{ CoursesDisplay: 'Dansk', ChapterTitle: 'Eventyr', Description: '<p>Læs <b>H.C.</b></p>', StartTimeISO: '2026-10-12T06:00:00Z' }]);
      })
      .on('GET', 'https://skoleportal.easyiqcloud.dk/Calendar/WeekPlan', () => json({ WeekPlans: [{ ActivityName: '3.A', Text: '<p>Tur fredag</p>' }] }));
    f.install();
    const res = await easyiqSkoleportal.fetch(ctxWith(new AulaClient(tokens)), '0128');
    expect(res.items.map((i) => [i.child, i.kind, i.subject ?? i.title])).toEqual([
      ['Ørn', 'plan', 'Dansk'],
      ['Ørn', 'note', 'Generelt om ugen: 3.A'],
    ]);
    expect(res.items[0]?.date).toBe('2026-10-12 08:00');
    expect(res.items[0]?.text).toBe('Læs H.C.');
    expect(res.warnings).toEqual(['EasyIQ SkolePortal (Måge): no weekly plan licence for this child.']);
  });
});

describe('attachments', () => {
  it('only allows https Aula media hosts (exact suffix, no tricks)', () => {
    expect(allowedHost(new URL('https://media-prod.aula.dk/a.pdf?sig=1'))).toBe(true);
    for (const bad of [
      'http://media-prod.aula.dk/a.pdf',
      'https://media-prod.aula.dk.evil.tld/a.pdf',
      'https://evilaula.dk/a.pdf',
      'https://user:pw@media-prod.aula.dk/a.pdf',
      'https://media-prod.aula.dk:8443/a.pdf',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      expect(allowedHost(new URL(bad)), bad).toBe(false);
    }
  });

  it('refuses a redirect off the allowed hosts', async () => {
    vi.stubEnv('AULA_MCP_DOWNLOAD_DIR', await mkdtemp(join(tmpdir(), 'aula-dl-')));
    new FakeFetch().on('GET', 'https://media-prod.aula.dk/file.pdf', () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })).install();
    await expect(download('https://media-prod.aula.dk/file.pdf', 'file.pdf')).rejects.toThrow(/not an Aula media host/);
  });

  it('downloads into the scoped dir with a safe name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aula-dl-'));
    vi.stubEnv('AULA_MCP_DOWNLOAD_DIR', dir);
    new FakeFetch().on('GET', 'https://media-prod.aula.dk/f', () => new Response('PDFDATA', { status: 200, headers: { 'content-type': 'application/pdf' } })).install();
    const res = await download('https://media-prod.aula.dk/f', '../../Bålhytten plan.pdf');
    expect(res.path.startsWith(dir)).toBe(true);
    expect(res.path).toMatch(/Bålhytten plan\.pdf$/);
    expect(res.bytes).toBe(7);
    expect(safeName('../../etc/passwd')).toBe('_.._etc_passwd');
  });
});
