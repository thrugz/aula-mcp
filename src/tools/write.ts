/**
 * Write tools, registered only with AULA_ENABLE_WRITE=1. Each one acts on the
 * account's own children only (names are resolved against the family) and
 * checks preconditions before writing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { threadsPage } from '../aula/messages.js';
import { ACTIVITY, presenceNow, STATUS, templateBody } from '../aula/presence.js';
import { cphDate, labelDate } from '../aula/time.js';
import { InputError } from '../errors.js';
import { addTool, type App } from './app.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerWriteTools(server: McpServer, app: App): void {
  addTool(
    server,
    'aula_report_sick',
    {
      title: 'Report a child sick in Aula',
      description:
        'Report a child sick for today (sick=true), or undo it (sick=false, only while the child is currently reported sick). Changes what the institution sees. Confirm with the user first.',
      input: {
        child: z.string().describe('Child name.'),
        sick: z.boolean().optional().describe('true (default) reports sick, false undoes a sick report.'),
      },
      write: true,
      idempotent: true,
    },
    async ({ child, sick }) => {
      const { children, label } = await app.children(child);
      if (children.length !== 1) throw new InputError('Name exactly one child.');
      const c = children[0]!;
      const reportSick = sick ?? true;
      const now = (await presenceNow(app.client, [c])).get(c.id);
      if (!reportSick && now?.status !== 1) {
        throw new InputError(`${label(c)} is not reported sick (status: ${STATUS[now?.status ?? -1] ?? 'unknown'}), so there is nothing to undo.`);
      }
      if (reportSick && now?.status === 1) return `${label(c)} is already reported sick today.`;
      // Undoing sets "not arrived", as the Aula app does.
      await app.client.post('presence.updateStatusByInstitutionProfileIds', { institutionProfileIds: [c.id], status: reportSick ? 1 : 0 });
      app.client.invalidate();
      const after = (await presenceNow(app.client, [c])).get(c.id);
      return `${label(c)} ${reportSick ? 'reported sick' : 'sick report removed'} for ${labelDate(cphDate())}. Aula now shows: ${STATUS[after?.status ?? -1] ?? 'unknown'}.`;
    },
  );

  addTool(
    server,
    'aula_set_pickup',
    {
      title: 'Set drop-off/pick-up in Aula',
      description:
        'Register how and when a child is dropped off and picked up on a date (komme/gå): picked_up_by <person>, go_home_with <person>, send_home, or self_decider (goes home on own between two times). Optionally repeat weekly. Overwrites that day\'s plan; confirm with the user first.',
      input: {
        child: z.string().describe('Child name.'),
        date: z.string().regex(DATE).describe('Day, YYYY-MM-DD (for repeats, also the weekday that repeats).'),
        activity: z.enum(Object.keys(ACTIVITY) as [keyof typeof ACTIVITY, ...Array<keyof typeof ACTIVITY>]),
        entryTime: z.string().regex(HHMM).optional().describe('Drop-off time HH:mm.'),
        exitTime: z.string().regex(HHMM).optional().describe('Pick-up / leave time HH:mm (not for self_decider).'),
        with: z.string().max(100).optional().describe('Who picks up (picked_up_by) or who the child goes home with (go_home_with).'),
        selfDeciderStart: z.string().regex(HHMM).optional().describe('self_decider: earliest time to leave.'),
        selfDeciderEnd: z.string().regex(HHMM).optional().describe('self_decider: latest time to leave.'),
        comment: z.string().max(250).optional(),
        repeat: z.enum(['never', 'weekly', 'every_2_weeks']).optional(),
        repeatUntil: z.string().regex(DATE).optional().describe('Last date of the repeat (required when repeating).'),
      },
      write: true,
      idempotent: true,
    },
    async (args) => {
      const problems: string[] = [];
      if ((args.activity === 'picked_up_by' || args.activity === 'go_home_with') && !args.with) problems.push(`${args.activity} needs "with" (a person).`);
      if (args.activity === 'self_decider' && !(args.selfDeciderStart && args.selfDeciderEnd)) problems.push('self_decider needs selfDeciderStart and selfDeciderEnd.');
      if (args.activity === 'self_decider' && args.selfDeciderStart && args.selfDeciderEnd && args.selfDeciderEnd < args.selfDeciderStart) problems.push('selfDeciderEnd is before selfDeciderStart.');
      if (args.entryTime && args.exitTime && args.exitTime < args.entryTime) problems.push('exitTime is before entryTime.');
      if (args.repeat && args.repeat !== 'never' && !args.repeatUntil) problems.push('Repeating needs repeatUntil.');
      if (args.date < cphDate()) problems.push('The date is in the past.');
      if (problems.length) throw new InputError(problems.join(' '));

      const { children, label } = await app.children(args.child);
      if (children.length !== 1) throw new InputError('Name exactly one child.');
      const c = children[0]!;
      const body = templateBody({
        childId: c.id,
        date: args.date,
        activity: args.activity,
        ...(args.entryTime ? { entryTime: args.entryTime } : {}),
        ...(args.exitTime ? { exitTime: args.exitTime } : {}),
        ...(args.with ? { with: args.with } : {}),
        ...(args.selfDeciderStart ? { selfDeciderStart: args.selfDeciderStart } : {}),
        ...(args.selfDeciderEnd ? { selfDeciderEnd: args.selfDeciderEnd } : {}),
        ...(args.comment ? { comment: args.comment } : {}),
        ...(args.repeat ? { repeat: args.repeat } : {}),
        ...(args.repeatUntil ? { repeatUntil: args.repeatUntil } : {}),
      });
      await app.client.post('presence.updatePresenceTemplate', body);
      app.client.invalidate();
      return `Saved for ${label(c)} on ${labelDate(args.date)}${args.repeat && args.repeat !== 'never' ? ` (${args.repeat.replace(/_/g, ' ')} until ${args.repeatUntil})` : ''}. Check it with aula_presence.`;
    },
  );

  addTool(
    server,
    'aula_mark_read',
    {
      title: 'Mark an Aula thread read',
      description: 'Move the thread\'s read marker to its newest message, as opening it in the Aula app would. Cannot be undone through the API.',
      input: { threadId: z.number().int().positive() },
      write: true,
      idempotent: true,
    },
    async ({ threadId }) => {
      // The thread list's latestMessage.id is what the Aula app moves the marker to.
      let messageId: string | undefined;
      for (let page = 0; page < 10 && !messageId; page++) {
        const { threads, more } = await threadsPage(app.client, page);
        const hit = threads.find((t) => t.id === threadId);
        if (hit) {
          messageId = hit.latestMessageId;
          if (!messageId) throw new InputError(`Thread ${threadId} lists no latest message to mark.`);
        }
        if (!more) break;
      }
      if (!messageId) throw new InputError(`Thread ${threadId} is not among the 200 newest threads.`);
      await app.client.post('messaging.setLastReadMessage', { threadId, messageId, commonInboxId: null, otpInboxId: null });
      app.client.invalidate();
      return `Thread #${threadId} marked read.`;
    },
  );
}
