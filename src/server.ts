/** MCP server assembly (stdio). */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { App, UNTRUSTED_NOTE } from './tools/app.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Aula is the Danish school and daycare platform. These tools read one family\'s Aula account.',
  'Children are addressed by name; omit the child to cover all of them. Times are Europe/Copenhagen local.',
  'For "what is happening today/tomorrow" call aula_today first; use the specific tools for detail.',
  'Answer in the user\'s language. Danish terms: ugeplan = weekly plan, lektier = homework, ugebrev = weekly letter, huskeliste = reminders, komme/gå = check-in/pick-up, opslag = posts, beskeder = messages.',
  UNTRUSTED_NOTE,
  'If a tool says the user must log in, tell them to run `aula-mcp login` in a terminal; you cannot do the MitID approval.',
].join('\n');

export function createServer(opts: { writeEnabled: boolean; app?: App }): McpServer {
  const server = new McpServer({ name: 'aula-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  const app = opts.app ?? new App({ writeEnabled: opts.writeEnabled });
  registerReadTools(server, app);
  if (opts.writeEnabled) registerWriteTools(server, app);
  return server;
}

export async function runStdio(): Promise<void> {
  const writeEnabled = /^(1|true|yes|on)$/i.test(process.env.AULA_ENABLE_WRITE ?? '');
  const server = createServer({ writeEnabled });
  await server.connect(new StdioServerTransport());
}
