import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerTimeCommand } from './commands/time.js';
import { registerLedgerCommands } from './commands/ledger.js';
import { registerCheckCommands } from './commands/check.js';
import { registerHelpCommand } from './commands/help.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export function createProgram(): Command {
  const program = new Command();

  program
    .name('scs')
    .description('常用脚本 CLI 工具')
    .version(version);

  registerTimeCommand(program);
  registerLedgerCommands(program);
  registerCheckCommands(program);
  registerHelpCommand(program);

  return program;
}
