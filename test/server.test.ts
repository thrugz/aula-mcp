import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
import { saveRecord } from '../src/store/tokens.js';
import { FakeFetch, json } from './helpers/fake-fetch.js';

const READ_TOOLS = [
  'aula_status',
  'aula_today',
  'aula_presence',
  'aula_calendar',
  'aula_messages',
  'aula_thread',
  'aula_posts',
  'aula_notifications',
  'aula_weekplan',
  'aula_gallery',
  'aula_download',
];
const WRITE_TOOLS = ['aula_report_sick', 'aula_set_pickup', 'aula_mark_read'];

async function connect(writeEnabled: boolean) {
  const server = createServer({ writeEnabled });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const ok = (data: unknown) => json({ status: { code: 0, message: 'OK' }, data });
const method = (u: URL) => u.searchParams.get('method');

function fakeAula() {
  return new FakeFetch()
    .on('GET', (u) => method(u) === 'profiles.getProfilesByLogin', () =>
      ok({
        profiles: [
          {
            displayName: 'Forælder',
            institutionProfiles: [{ id: 900, institutionCode: 'G1' }],
            children: [
              { id: 101, name: 'Ørn Eksempel', userId: 'barn1', institutionProfile: { institutionName: 'Skolen', institutionCode: 'G1', metadata: '2A' } },
              { id: 102, name: 'Måge Eksempel', userId: 'barn2', institutionProfile: { institutionName: 'Børnehuset', institutionCode: 'D1' } },
            ],
          },
        ],
      }),
    )
    .on('GET', (u) => method(u) === 'profiles.getProfileContext', () =>
      ok({ userId: 77, pageConfiguration: { widgetConfigurations: [{ widget: { widgetId: '0029' } }, { widget: { widgetId: '0108' } }] } }),
    )
    .on('POST', (u) => method(u) === 'calendar.getEventsByProfileIdsAndResourceIds', (r) => {
      const body = JSON.parse(r.body);
      expect(body.start).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00\.0000\+0[12]00$/);
      return ok([{ id: 1, type: 'event', title: 'Skovtur', startDateTime: '2026-10-12T07:00:00+00:00', endDateTime: '2026-10-12T12:00:00+00:00', belongsToProfiles: [101] }]);
    })
    .on('GET', (u) => method(u) === 'messaging.getThreads', (r) => {
      const page = Number(r.url.searchParams.get('page'));
      if (page === 0) return ok({ moreMessagesExist: true, threads: Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, subject: `S${i}`, read: true })) });
      return ok({ moreMessagesExist: false, threads: [{ id: 7, subject: 'Gammel ulæst', read: false, latestMessage: { id: 'm1', sendDateTime: '2026-09-01T10:00:00+00:00' }, creator: { fullName: 'Lærer' }, regardingChildren: [{ displayName: 'Ørn Eksempel' }] }] });
    });
}

beforeEach(async () => {
  vi.stubEnv('AULA_MCP_DIR', await mkdtemp(join(tmpdir(), 'aula-mcp-server-')));
  vi.stubEnv('AULA_MCP_KEY', 'c'.repeat(64));
  const now = Math.floor(Date.now() / 1000);
  await saveRecord({ version: 1, username: 'parent01', tokens: { access_token: 'acc', refresh_token: 'ref', expires_at: now + 3600, obtained_at: now }, saved_at: now });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('MCP server', () => {
  it('lists read tools as read-only, and hides write tools unless enabled', async () => {
    const read = await (await connect(false)).listTools();
    expect(read.tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(read.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(read.tools.every((t) => /^[a-z_]+$/.test(t.name))).toBe(true);

    const all = await (await connect(true)).listTools();
    const writes = all.tools.filter((t) => WRITE_TOOLS.includes(t.name));
    expect(writes).toHaveLength(3);
    expect(writes.every((t) => t.annotations?.destructiveHint === true && t.annotations.readOnlyHint === false)).toBe(true);
  });

  it('never accepts a URL for downloads', async () => {
    const tools = (await (await connect(false)).listTools()).tools;
    const props = Object.keys((tools.find((t) => t.name === 'aula_download')!.inputSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(['attachmentId', 'itemId', 'source']);
  });

  it('answers aula_status with children, sources and unsupported widgets', async () => {
    fakeAula().install();
    const res = await (await connect(false)).callTool({ name: 'aula_status', arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(res.isError).toBeFalsy();
    expect(text).toContain('- Ørn Eksempel (Ørn): Skolen, class 2A');
    expect(text).toContain('Weekly plan sources (aula_weekplan): Min Uddannelse ugebrev');
    expect(text).toContain('not readable by this server: Meddelelsesbog');
  });

  it('resolves a child by name and shows local times', async () => {
    fakeAula().install();
    const res = await (await connect(false)).callTool({ name: 'aula_calendar', arguments: { child: 'orn', from: '2026-10-12', to: '2026-10-12' } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('09:00-14:00  Skovtur #1');
  });

  it('finds an unread thread beyond the first page', async () => {
    fakeAula().install();
    const res = await (await connect(false)).callTool({ name: 'aula_messages', arguments: { unreadOnly: true } });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('#7 [UNREAD] 2026-09-01 12:00  Gammel ulæst (started by Lærer; re Ørn Eksempel)');
    expect(text).toContain("that is all of them");
  });

  it('returns isError with the candidates for an unknown child', async () => {
    fakeAula().install();
    const res = await (await connect(false)).callTool({ name: 'aula_presence', arguments: { child: 'Ugle' } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/No child called "Ugle".*Ørn Eksempel, Måge Eksempel/);
  });

  it('tells the model to have the user log in when there are no tokens', async () => {
    vi.stubEnv('AULA_MCP_DIR', await mkdtemp(join(tmpdir(), 'aula-mcp-empty-')));
    const res = await (await connect(false)).callTool({ name: 'aula_calendar', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/Not logged in[\s\S]*aula-mcp login/);
  });
});
