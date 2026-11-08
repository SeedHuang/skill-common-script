import type { Command } from 'commander';
import { runLedgerGate } from './ledger-gate.js';
import { runLedgerNumbers } from './ledger-numbers.js';

/** 输出命令行结果并按判据设置退出码（0 全过 / 1 有问题 / 2 用法或读取错误） */
function emit(out: string[], err: string[], code: number): void {
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exitCode = code;
}

export function registerLedgerCommands(program: Command): void {
  const ledger = program.command('ledger').description('审查账本核对：轮次账完整性 / 账本数字一致性');

  ledger
    .command('gate')
    .argument('<progressPath>', 'progress.md 路径')
    .description('核对 progress.md 轮次账的起止与耗时是否填全')
    .action((progressPath: string) => {
      const r = runLedgerGate(progressPath);
      emit(r.out, r.err, r.code);
    });

  ledger
    .command('numbers')
    .argument('<dir>', '评审目录（含 progress.md；problems.md / cards.md 可选）')
    .description('核对账本数字：算术自洽 / 卡片实数 / 族号计数 / 副本禁令')
    .action((dir: string) => {
      const r = runLedgerNumbers(dir);
      emit(r.out, r.err, r.code);
    });
}
