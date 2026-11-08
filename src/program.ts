import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerHelloCommand } from './commands/hello.js';
import { registerTimeCommand } from './commands/time.js';
import { registerLedgerCommands } from './commands/ledger.js';
import { registerCheckCommands } from './commands/check.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export function createProgram(): Command {
  const program = new Command();

  program
    .name('scs')
    .description('常用脚本 CLI 工具')
    .version(version);

  registerHelloCommand(program);
  registerTimeCommand(program);
  registerLedgerCommands(program);
  registerCheckCommands(program);

  return program;
}
