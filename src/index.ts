#!/usr/bin/env node
/** Entry point: no arguments runs the MCP server on stdio; otherwise a CLI command. */

import { runCli } from './cli.js';
import { runStdio } from './server.js';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === 'serve') {
  runStdio().catch((e) => {
    process.stderr.write(`aula-mcp: ${(e as Error).message}\n`);
    process.exit(1);
  });
} else {
  runCli(args).then((code) => process.exit(code));
}
