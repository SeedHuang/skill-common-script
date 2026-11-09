import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ObservableFail, runObservable } from './check-observable.js';
import { runCriteriaEngine } from './check-criteria-engine.js';
import { checkLandings } from './check-landings.js';
import { checkRules } from './check-rules.js';
import { checkSkills } from './check-skills.js';

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
    .command('landings')
    .description('核对账本里的 path:line 是否真实存在')
    .option('--ledger <dir>', '账本目录（必填；按 cwd 解析）')
    .option('--root <dir>', '项目根（默认当前目录）', process.cwd())
    .action((options: { ledger?: string; root: string }) => {
      if (!options.ledger) {
        console.error('用法：scs check landings --root <项目根> --ledger <账本目录>');
        process.exitCode = 2;
        return;
      }
      const r = checkLandings({ root: resolve(options.root), ledger: resolve(options.ledger) });
      for (const line of r.out) console.log(line);
      for (const line of r.err) console.error(line);
      process.exitCode = r.code;
    });

  check
    .command('skills')
    .description('技能体检：跨技能路径引用 / 自引用带前缀 / 守卫路径字符串比较')
    .option('--root <dir>', '项目根（技能目录 = <root>/skills；默认当前目录）')
    .option('--manifest <file>', '技能清单 JSON（可选；无默认值）')
    .option('--json', '以 JSON 输出明细', false)
    .action((options: { root?: string; manifest?: string; json?: boolean }) => {
      const r = checkSkills({ root: resolve(options.root ?? process.cwd()), manifest: options.manifest, json: options.json });
      for (const line of r.out) console.log(line);
      for (const line of r.err) console.error(line);
      process.exitCode = r.code;
    });

  check
    .command('rules')
    .description('规则体检：按 criteria 评分（单条或全库）')
    .option('--root <dir>', '项目根（规则库 = <root>/rules；默认当前目录）')
    .option('--terms <file>', '可观察词表 JSON（必填）')
    .option('--file <file>', '只评单条规则')
    .option('--rules-dir <dir>', '规则库目录（默认 <root>/rules；--file 模式下默认该文件所在目录）')
    .option('--json', '以 JSON 输出明细', false)
    .option('--tri-check', '三检验报告已做（AI 判）', false)
    .option('--cognitive', '规则含认知动作（AI 判）', false)
    .option('--baseline <file>', '体积基线 JSON')
    .option('--type <type>', '规则类型：持续适用 / 条件触发 / 模式门控 / 待拆未定')
    .option('--annotations <file>', '标注 JSON（可选；无仓级默认值）')
    .action((options: {
      root?: string; terms?: string; file?: string; rulesDir?: string; json?: boolean;
      triCheck?: boolean; cognitive?: boolean; baseline?: string; type?: string; annotations?: string;
    }) => {
      const r = checkRules({
        root: resolve(options.root ?? process.cwd()),
        terms: options.terms ? resolve(options.terms) : '',
        file: options.file ? resolve(options.file) : undefined,
        rulesDir: options.rulesDir ? resolve(options.rulesDir) : undefined,
        json: options.json,
        triCheck: options.triCheck,
        cognitive: options.cognitive,
        baseline: options.baseline ? resolve(options.baseline) : undefined,
        type: options.type,
        annotations: options.annotations ? resolve(options.annotations) : undefined,
      });
      for (const line of r.out) console.log(line);
      for (const line of r.err) console.error(line);
      process.exitCode = r.code;
    });

  check
    .command('criteria-engine')
    .description('校验判据引擎：schema / testcase / 渲染物一致性 + 分层预算')
    .option('--root <dir>', '项目根（默认当前目录）')
    .option('--engine <dir>', '引擎模块目录（默认 tools/quality/criteria-engine）')
    .option('--data <dir>', '判据数据目录（默认 = --engine）')
    .option('--projection <dir>', '渲染投影目录（默认 = --engine）')
    .option('--terms <file>', '共享片段词表（默认 tools/quality/observable-terms.json）')
    .option('--surface <dir>', '承接面扫描目录（可重复；默认 skills + tools/quality）', collectDirs, [])
    .action(
      async (options: {
        root?: string;
        engine?: string;
        data?: string;
        projection?: string;
        terms?: string;
        surface?: string[];
      }) => {
        const r = await runCriteriaEngine(resolve(options.root ?? process.cwd()), {
          engineDir: options.engine,
          dataDir: options.data,
          projectionDir: options.projection,
          termsFile: options.terms,
          surfaces: options.surface && options.surface.length > 0 ? options.surface : undefined,
        });
        for (const line of r.stdout) console.log(line);
        for (const line of r.stderr) console.error(line);
        process.exitCode = r.code;
      },
    );
}

/** 可重复旗标：`--surface a --surface b` 累加成数组（commander 默认后值覆盖前值） */
function collectDirs(value: string, previous: string[]): string[] {
  return [...previous, value];
}
