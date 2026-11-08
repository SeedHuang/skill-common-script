import inquirer from 'inquirer';
import type { Command } from 'commander';

export interface HelloOptions {
  greeting?: string;
  uppercase?: boolean;
}

const DEFAULT_NAME = 'World';
const DEFAULT_GREETING = 'Hello';

/** 根据名字与选项拼出问候语，空名字/空问候语回退到默认值 */
export function buildGreeting(name: string | undefined, options: HelloOptions = {}): string {
  const target = name?.trim() || DEFAULT_NAME;
  const greeting = options.greeting?.trim() || DEFAULT_GREETING;
  const message = `${greeting}, ${target}!`;
  return options.uppercase ? message.toUpperCase() : message;
}

/** 命令行未提供名字时：交互式终端走 inquirer 询问，非交互场景直接用默认值 */
export async function resolveName(name?: string): Promise<string> {
  if (name?.trim()) {
    return name.trim();
  }
  if (!process.stdin.isTTY) {
    return DEFAULT_NAME;
  }
  const answer = await inquirer.prompt<{ name: string }>([
    {
      type: 'input',
      name: 'name',
      message: '请输入你的名字：',
      default: DEFAULT_NAME,
    },
  ]);
  return answer.name?.trim() || DEFAULT_NAME;
}

export function registerHelloCommand(program: Command): void {
  program
    .command('hello [name]')
    .description('输出一句问候语')
    .option('-g, --greeting <text>', '自定义问候语', DEFAULT_GREETING)
    .option('-u, --uppercase', '将输出转为大写', false)
    .action(async (name: string | undefined, options: HelloOptions) => {
      const target = await resolveName(name);
      console.log(buildGreeting(target, options));
    });
}
