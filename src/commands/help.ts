import type { Argument, Command, Option } from 'commander';

const EXIT_CODE_LINES = [
  '退出码',
  '  0 = 通过（无不合格项）',
  '  1 = 有不合格项',
  '  2 = 用法或读取错误',
];

/** 命令完整路径，如 scs ledger gate */
function commandPath(cmd: Command): string {
  const chain: string[] = [];
  let cur: Command | null = cmd;
  while (cur) {
    chain.unshift(cur.name());
    cur = cur.parent;
  }
  return chain.join(' ');
}

function argumentToken(arg: Argument): string {
  const name = `${arg.name()}${arg.variadic ? '...' : ''}`;
  return arg.required ? `<${name}>` : `[${name}]`;
}

function optionLines(cmd: Command): string[] {
  return cmd.options
    .filter((o) => !o.flags.includes('--help'))
    .map((o: Option) => {
      const pad = ' '.repeat(Math.max(2, 26 - o.flags.length));
      const def = o.defaultValue;
      const defText = def === undefined || def === false || def === '' ? '' : `（默认：${String(def)}）`;
      return `    ${o.flags}${pad}${o.description}${defText}`;
    });
}

function block(cmd: Command, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const args = cmd.registeredArguments.map(argumentToken).join(' ');
  const usage = [commandPath(cmd), args, '[选项]'].filter(Boolean).join(' ');

  const out = [`${indent}${commandPath(cmd)}`, `${indent}  ${cmd.description()}`, `${indent}  用法：${usage}`];

  if (cmd.registeredArguments.length > 0) {
    out.push(`${indent}  参数：`);
    for (const arg of cmd.registeredArguments) {
      out.push(`${indent}    ${argumentToken(arg)}${arg.description ? `  ${arg.description}` : ''}`);
    }
  }

  const options = optionLines(cmd);
  if (options.length > 0) out.push(`${indent}  选项：`, ...options.map((line) => `${indent}${line}`));

  for (const sub of cmd.commands) {
    if (sub.name() === 'help') continue;
    out.push('', ...block(sub, depth + 1));
  }
  return out;
}

export function resolveCommand(program: Command, path: string[]): Command | undefined {
  let cur: Command = program;
  for (const name of path) {
    const next = cur.commands.find((c) => c.name() === name || c.aliases().includes(name));
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

/** 渲染全部命令或指定命令的详细用法，纯函数，便于单测 */
export function renderHelp(program: Command, path: string[] = []): string {
  if (path.length > 0) {
    const target = resolveCommand(program, path);
    return target ? block(target, 0).join('\n') : `未知命令：${path.join(' ')}\n运行 ${program.name()} help 查看全部脚本`;
  }

  const out = [
    `${program.name()} — ${program.description()}`,
    '',
    '用法',
    `  ${program.name()} <command> [options]`,
    `  ${program.name()} help [command...]`,
    '',
    '脚本',
  ];
  for (const cmd of program.commands) {
    if (cmd.name() === 'help') continue;
    out.push('', ...block(cmd, 1));
  }
  out.push('', ...EXIT_CODE_LINES);
  return out.join('\n');
}

export function registerHelpCommand(program: Command): void {
  program
    .command('help [command...]')
    .description('查看全部脚本的详细用法，可按路径查看单个命令')
    .action((names: string[] | undefined) => {
      const path = names ?? [];
      if (resolveCommand(program, path) === undefined) {
        console.error(`未知命令：${path.join(' ')}`);
        console.error(`运行 ${program.name()} help 查看全部脚本`);
        process.exitCode = 1;
        return;
      }
      console.log(renderHelp(program, path));
    });
}
