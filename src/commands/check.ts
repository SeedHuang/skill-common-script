import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ObservableFail, runObservable } from './check-observable.js';
import { runCriteriaEngine } from './check-criteria-engine.js';

export interface CheckObservableCliOptions {
  json?: boolean;
  root?: string;
  terms?: string;
  exempt?: string;
}

/**
 * CLI 入口：可观察判据校验器。
 * 退出码：0 无未豁免命中且无 stale / 1 有命中或 stale 或规则文档复制词表 / 2 前置不过。
 */
export function checkObservableCommand(options: CheckObservableCliOptions = {}): number {
  const root = resolve(options.root ?? process.cwd());
  const termsFile = resolve(options.terms ?? join(root, 'tools', 'quality', 'observable-terms.json'));
  const exemptFile = resolve(options.exempt ?? join(root, 'tools', 'quality', 'observable-exempt.json'));

  try {
    const { report } = runObservable({ root, strictRoot: options.root === undefined, termsFile, exemptFile });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      for (const h of report.hits) process.stdout.write(`${h.path}:${h.line}  term=${h.terms.join(',')}  无结构化可观察标记\n`);
      for (const c of report.copyProblems ?? []) process.stdout.write(`[copy] ${c}\n`);
      for (const s of report.stale) process.stdout.write(`[stale] ${s.path}  contains 未命中：${s.contains}\n`);
    }
    if (report.ok) {
      process.stdout.write('check-observable ok\n');
      return 0;
    }
    process.stdout.write(`check-observable fail（命中 ${report.hits.length} 行 / stale ${report.stale.length} 条）\n`);
    return 1;
  } catch (e) {
    const code = e instanceof ObservableFail ? e.code : 'UNEXPECTED';
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(`check-observable error（${code}: ${msg}）\n`);
    return 2;
  }
}

export function registerCheckCommands(program: Command): void {
  const check = program.command('check').description('项目自检：可观察判据 / 判据引擎');

  check
    .command('observable')
    .description('扫描 rules/ 与 skills/：主观词命中且无可观察标记即失败')
    .option('--check', '兼容旧调用（本命令默认即检查模式）', false)
    .option('--json', '以 JSON 输出报告（结果在首行）', false)
    .option('--root <dir>', '扫描根（默认当前目录）')
    .option('--terms <file>', '词表 JSON（默认 <root>/tools/quality/observable-terms.json）')
    .option('--exempt <file>', '豁免清单 JSON（默认 <root>/tools/quality/observable-exempt.json）')
    .action((options: CheckObservableCliOptions) => {
      process.exitCode = checkObservableCommand(options);
    });

  check
    .command('criteria-engine')
    .description('校验判据引擎：schema / testcase / 渲染物一致性 + 分层预算')
    .option('--root <dir>', '项目根（默认当前目录）')
    .action(async (options: { root?: string }) => {
      const r = await runCriteriaEngine(resolve(options.root ?? process.cwd()));
      for (const line of r.stdout) console.log(line);
      for (const line of r.stderr) console.error(line);
      process.exitCode = r.code;
    });
}
