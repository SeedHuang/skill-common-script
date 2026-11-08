import type { Command } from 'commander';

/**
 * 把时刻格式化为 HH:MM:SS（本地时区）。
 * 为什么要有它：agent 无内置时钟，账本里的时间必须经工具取，防凭感觉填。
 */
export function formatTime(date: Date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function registerTimeCommand(program: Command): void {
  program
    .command('time')
    .description('输出当前时间 HH:MM:SS（审查账本取数用）')
    .action(() => {
      console.log(formatTime());
    });
}
