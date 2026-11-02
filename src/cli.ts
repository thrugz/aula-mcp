/**
 * Terminal commands: login (MitID QR in the terminal), status, doctor, logout.
 * The MCP server never logs in by itself; MitID approval needs a human.
 */

import { createInterface } from 'node:readline/promises';
import qrcode from 'qrcode-terminal';
import { login, type AppPrompt, type IdentityOption } from './auth/login.js';
import { AulaClient } from './aula/client.js';
import { fetchEvents } from './aula/calendar.js';
import { FamilyCache } from './aula/family.js';
import { fetchAlbums, fetchNotifications, fetchPosts, threadsPage } from './aula/messages.js';
import { presenceNow } from './aula/presence.js';
import { TokenSession } from './aula/session.js';
import { cphDate, isoWeek, isoWeekMonday, localDateTime } from './aula/time.js';
import { enabledVendors, WidgetTokens } from './aula/vendors/index.js';
import { AulaError } from './errors.js';
import { configDir } from './store/files.js';
import { resolveKey } from './store/key.js';
import { clearRecord, loadRecord, saveRecord } from './store/tokens.js';
import { VERSION } from './version.js';

const HELP = `aula-mcp ${VERSION}: MCP server for Aula (Danish school and daycare platform)

Usage:
  aula-mcp                 Run the MCP server on stdio (what MCP clients start)
  aula-mcp login [--username <mitid-user>] [--method app|token]
                           Log in with MitID (QR/OTP in the MitID app, or code token + password)
  aula-mcp status          Show login state and the children on the account
  aula-mcp doctor          Call every endpoint once and report what works
  aula-mcp logout          Delete the saved tokens

Environment:
  AULA_MITID_USERNAME      MitID user ID (login default)
  AULA_MCP_KEY             Token encryption key (64 hex chars or a passphrase); default: macOS Keychain
  AULA_MCP_DIR             Config dir (default ~/.config/aula-mcp)
  AULA_ENABLE_WRITE=1      Register the write tools (report sick, set pick-up, mark read)
  AULA_MCP_DEBUG=1         Request log on stderr (tokens redacted)
`;

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    switch (command) {
      case 'login':
        return await loginCommand(flags);
      case 'status':
        return await statusCommand();
      case 'doctor':
        return await doctorCommand();
      case 'logout':
        await clearRecord();
        console.log('Saved Aula tokens deleted.');
        return 0;
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return 0;
      case '--version':
        console.log(VERSION);
        return 0;
      default:
        console.error(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    if (e instanceof AulaError && e.hint) console.error(`Next step: ${e.hint}`);
    return 1;
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2);
    out[k!] = v ?? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true');
  }
  return out;
}

async function loginCommand(flags: Record<string, string>): Promise<number> {
  // Ctrl-C aborts the whole login, including the MitID long-poll.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  const qr = new QrAnimator();
  try {
    const username = (flags.username ?? process.env.AULA_MITID_USERNAME ?? (await ask('MitID user ID: ', controller))).trim();
    if (!username) throw new AulaError('A MitID user ID is required.');
    const method = flags.method === 'token' ? 'token' : 'app';
    const key = await resolveKey({ create: true });
    console.log(`Tokens will be stored encrypted in ${configDir()} (key: ${key?.source}).`);

    const result = await login({
      username,
      method,
      signal: controller.signal,
      onStep: (m) => console.log(`- ${m}`),
      onPrompt: (p) => qr.show(p),
      askCodeToken: () => ask('Code token (kodeviser) digits: ', controller),
      askPassword: () => askHidden('MitID password: ', controller),
      chooseIdentity: async (options: IdentityOption[]) => {
        qr.stop();
        console.log('\nThis MitID has several identities:');
        for (const o of options) console.log(`  ${o.index}. ${o.label}`);
        return Number(await ask('Pick a number: ', controller));
      },
    });

    await saveRecord({ version: 1, username, ...(result.identity ? { identity: result.identity } : {}), tokens: result.tokens, saved_at: Math.floor(Date.now() / 1000) });
    console.log('\nLogged in. Checking the account...');
    return await statusCommand();
  } catch (e) {
    if (controller.signal.aborted) throw new AulaError('Login cancelled.');
    throw e;
  } finally {
    qr.stop();
    process.off('SIGINT', onSigint);
  }
}

/**
 * One question, one short-lived readline. Keeping a readline open for the
 * whole login would echo the hidden password and swallow Ctrl-C.
 */
async function ask(question: string, controller: AbortController): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => controller.abort());
  try {
    return await rl.question(question, { signal: controller.signal });
  } finally {
    rl.close();
  }
}

/** Draws the two alternating MitID QR frames in place until the next prompt. */
class QrAnimator {
  private timer?: NodeJS.Timeout;
  private frames?: [string, string];
  private flip = 0;

  show(p: AppPrompt): void {
    if (p.kind === 'qr') {
      this.frames = p.frames;
      this.timer ??= setInterval(() => this.draw(), 1000);
      this.draw();
    } else {
      this.stop();
      if (p.kind === 'waiting') console.log('- Open the MitID app on your phone...');
      if (p.kind === 'otp') console.log(`\n  Enter this code in the MitID app: ${p.code}\n`);
      if (p.kind === 'verified') console.log('- Code accepted, approve in the MitID app.');
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private draw(): void {
    if (!this.frames) return;
    const frame = this.frames[this.flip++ % 2]!;
    qrcode.generate(frame, { small: true }, (art: string) => {
      process.stdout.write(`\x1b[H\x1b[2J  Scan with the MitID app (the code alternates between two frames):\n\n${art}\n`);
    });
  }
}

async function askHidden(prompt: string, controller: AbortController): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const done = () => {
      stdin.setRawMode?.(false);
      stdin.off('data', onData);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          controller.abort();
          reject(new AulaError('Login cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function statusCommand(): Promise<number> {
  const record = await loadRecord();
  if (!record) {
    console.log('Not logged in. Run: aula-mcp login');
    return 1;
  }
  const session = new TokenSession();
  const client = new AulaClient(session);
  const family = await new FamilyCache(client).get();
  const fresh = await session.record();
  console.log(`Logged in as ${family.guardianName || record.username} (MitID ${record.username}${record.identity ? `, ${record.identity}` : ''}).`);
  console.log(`Access token valid until ${localDateTime(new Date((fresh ?? record).tokens.expires_at * 1000).toISOString())}; API v${await client.apiVersion()}.`);
  console.log('Children:');
  for (const c of family.children) console.log(`  - ${c.name}${c.institutionName ? `, ${c.institutionName}` : ''}${c.className ? ` (${c.className})` : ''}`);
  const vendors = enabledVendors(family.widgets).map((v) => v.vendor.name);
  console.log(`Weekly-plan sources: ${vendors.join(', ') || 'none'}; widgets: ${family.widgets.join(', ') || 'none'}`);
  return 0;
}

async function doctorCommand(): Promise<number> {
  const session = new TokenSession();
  const client = new AulaClient(session);
  const family = await new FamilyCache(client).get();
  const ids = family.children.map((c) => c.id);
  const today = cphDate();
  const checks: Array<[string, () => Promise<unknown>]> = [
    ['presence.getDailyOverview', () => presenceNow(client, family.children)],
    ['calendar (today)', () => fetchEvents(client, ids, { from: today, to: today })],
    ['messaging.getThreads', () => threadsPage(client, 0)],
    ['posts.getAllPosts', () => fetchPosts(client, family, { page: 0, limit: 1, unreadOnly: false })],
    ['notifications', () => fetchNotifications(client, family)],
    ['gallery.getAlbums', () => fetchAlbums(client, family, 1)],
  ];
  const widgets = new WidgetTokens(client);
  const week = isoWeek(today);
  for (const { vendor, widgetId } of enabledVendors(family.widgets)) {
    checks.push([
      `${vendor.name} (widget ${widgetId})`,
      async () => {
        const r = await vendor.fetch(
          { client, family, children: family.children, week, monday: isoWeekMonday(week), username: (await session.record())?.username ?? '', label: (c) => c.firstName, tokens: widgets },
          widgetId,
        );
        if (r.warnings.length) throw new Error(r.warnings.join('; '));
        return r.items;
      },
    ]);
  }
  console.log(`API v${await client.apiVersion()}, ${family.children.length} children, widgets ${family.widgets.join(', ') || 'none'}`);
  let failed = 0;
  for (const [name, run] of checks) {
    const started = Date.now();
    try {
      const value = await run();
      const n = Array.isArray(value) ? ` (${value.length})` : value instanceof Map ? ` (${value.size})` : '';
      console.log(`  ok    ${name}${n}  ${Date.now() - started} ms`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}  ${Date.now() - started} ms  ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}
