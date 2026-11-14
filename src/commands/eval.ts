import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';

// 通用能力评测：scs 只做机制（schema / 判分 / 度量 / 退出码）。
// 不写死项目路径、阈值、角色名；cases、answers、limit 均由调用方传入。

export interface RuleCase {
  id: string;
  expect: { trigger: string; verdict: string; violations: number[] };
}

export interface RuleAnswer {
  id: string;
  trigger?: string;
  verdict?: string;
  violations?: number[];
  anchor?: string;
  applicability?: string;
  target?: string;
  hasNumbers?: boolean;
  numberCommand?: string;
  lookupHit?: boolean;
  missReport?: string;
}

export interface AgentCase {
  id: string;
  dim: string;
  intent?: string;
  expected?: string;
}

export interface AgentAnswer {
  id: string;
  pass?: boolean;
  evidence?: string;
}

export interface CheckItem {
  id: string;
  ok: boolean;
  reason: string;
}

export interface Dimension {
  passed: number;
  total: number;
  items: CheckItem[];
}

export interface TextMetrics {
  chars: number;
  lines: number;
  bytes: number;
  tokensBy4: number;
  tokensUpper: number;
}

export interface RuleEvalResult {
  dimensions: { R1: Dimension; R2: Dimension; R3: Dimension };
  metrics?: TextMetrics;
  failures: string[];
  ok: boolean;
}

export interface AgentEvalResult {
  dimensions: Record<string, Dimension>;
  failures: string[];
  ok: boolean;
}

function dimension(items: CheckItem[]): Dimension {
  return { passed: items.filter((i) => i.ok).length, total: items.length, items };
}

function sorted(values: number[]): string {
  return [...values].sort((a, b) => a - b).join(',');
}

/** 锚可解析：path:line / 命令 + 输出首行 / 引用件路径；root 由调用方给，不假定项目布局 */
export function anchorResolves(anchor: string | undefined, root: string): boolean {
  if (typeof anchor !== 'string' || anchor.trim() === '') return false;
  const m = anchor.match(/^([^\s:]+):(\d+)(?:-\d+)?$/);
  if (m && m[1]) return existsSync(resolve(root, m[1]));
  if (/^命令\s*[:：]/.test(anchor)) return /输出首行\s*[:：]\s*\S/.test(anchor);
  return existsSync(resolve(root, anchor));
}

function requiredFields(a: RuleAnswer): string[] {
  const missing: string[] = [];
  for (const key of ['anchor', 'applicability', 'target'] as const) {
    if (typeof a[key] !== 'string' || a[key]!.trim() === '') missing.push(key);
  }
  if (a.hasNumbers === true && (typeof a.numberCommand !== 'string' || a.numberCommand.trim() === '')) {
    missing.push('numberCommand');
  }
  if (a.lookupHit === false && (typeof a.missReport !== 'string' || a.missReport.trim() === '')) {
    missing.push('missReport');
  }
  return missing;
}

export function scoreRuleAnswers(answers: RuleAnswer[], cases: RuleCase[], root = process.cwd()): RuleEvalResult {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const caseIds = new Set(cases.map((c) => c.id));

  const r1 = cases.map((c) => {
    const got = byId.get(c.id);
    if (!got) return { id: c.id, ok: false, reason: '缺答案' };
    const gotViolations = Array.isArray(got.violations) ? got.violations : [];
    const ok =
      got.trigger === c.expect.trigger &&
      got.verdict === c.expect.verdict &&
      sorted(gotViolations) === sorted(c.expect.violations);
    return {
      id: c.id,
      ok,
      reason: ok ? '' : `期望 trigger=${c.expect.trigger} verdict=${c.expect.verdict} violations=${c.expect.violations.join(',') || '无'}`,
    };
  });

  const fieldAnswers = answers.filter(
    (a) => !caseIds.has(a.id) && (a.anchor !== undefined || a.applicability !== undefined || a.target !== undefined),
  );
  const r2 = fieldAnswers.map((a) => {
    const missing = requiredFields(a);
    return { id: a.id, ok: missing.length === 0, reason: missing.length ? `缺字段 ${missing.join(',')}` : '' };
  });
  const r3 = fieldAnswers.map((a) => ({
    id: a.id,
    ok: anchorResolves(a.anchor, root),
    reason: anchorResolves(a.anchor, root) ? '' : '锚不可解析',
  }));

  const failures = [...r1, ...r2, ...r3].filter((i) => !i.ok).map((i) => `${i.id} ${i.reason}`);
  return {
    dimensions: { R1: dimension(r1), R2: dimension(r2), R3: dimension(r3) },
    failures,
    ok: failures.length === 0,
  };
}

export function scoreAgentAnswers(answers: AgentAnswer[], cases: AgentCase[]): AgentEvalResult {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const items = cases.map((c) => {
    const got = byId.get(c.id);
    if (!got) return { id: c.id, dim: c.dim, ok: false, reason: '缺答案' };
    if (got.pass !== true) return { id: c.id, dim: c.dim, ok: false, reason: '未通过' };
    if (typeof got.evidence !== 'string' || got.evidence.trim() === '') {
      return { id: c.id, dim: c.dim, ok: false, reason: '缺证据' };
    }
    return { id: c.id, dim: c.dim, ok: true, reason: '' };
  });
  const buckets: Record<string, CheckItem[]> = {};
  for (const item of items) {
    (buckets[item.dim] ??= []).push({ id: item.id, ok: item.ok, reason: item.reason });
  }
  const grouped: Record<string, Dimension> = {};
  for (const [dim, list] of Object.entries(buckets)) grouped[dim] = dimension(list);
  const failures = items.filter((i) => !i.ok).map((i) => `${i.id} ${i.reason}`);
  return { dimensions: grouped, failures, ok: failures.length === 0 };
}

export function measureText(text: string): TextMetrics {
  const chars = [...text].length;
  return {
    chars,
    lines: text === '' ? 0 : text.split(/\r?\n/).length,
    bytes: Buffer.byteLength(text, 'utf8'),
    tokensBy4: Math.ceil(chars / 4),
    tokensUpper: chars,
  };
}

function readJson(file: string): unknown {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw) as unknown;
}

function asRuleCases(value: unknown): RuleCase[] {
  const list = Array.isArray(value) ? value : (value as { cases?: unknown }).cases;
  if (!Array.isArray(list)) throw new Error('cases 必须是数组或 { cases: [] }');
  return list as RuleCase[];
}

function asRuleAnswers(value: unknown): RuleAnswer[] {
  const list = Array.isArray(value) ? value : (value as { answers?: unknown }).answers;
  if (!Array.isArray(list)) throw new Error('answers 必须是数组或 { answers: [] }');
  return list as RuleAnswer[];
}

function asAgentCases(value: unknown): AgentCase[] {
  const list = Array.isArray(value) ? value : (value as { cases?: unknown }).cases;
  if (!Array.isArray(list)) throw new Error('cases 必须是数组或 { cases: [] }');
  return list as AgentCase[];
}

function asAgentAnswers(value: unknown): AgentAnswer[] {
  const list = Array.isArray(value) ? value : (value as { answers?: unknown }).answers;
  if (!Array.isArray(list)) throw new Error('answers 必须是数组或 { answers: [] }');
  return list as AgentAnswer[];
}

function printDimension(name: string, d: Dimension): void {
  console.log(`${name} ${d.passed}/${d.total}`);
}

function finish(result: { failures: string[]; ok: boolean }): number {
  for (const f of result.failures) console.log(`FAIL ${f}`);
  console.log(result.ok ? 'PASS' : `FAIL ${result.failures.length}`);
  return result.ok ? 0 : 1;
}

interface RuleCliOptions {
  answers?: string;
  cases?: string;
  root?: string;
  limits?: string;
  file?: string;
  json?: boolean;
}

interface AgentCliOptions {
  answers?: string;
  cases?: string;
  json?: boolean;
}

export function registerEvalCommands(program: Command): void {
  const evalCmd = program.command('eval').description('能力评测：rule 判定 / agent 行为回放（机制层，无项目默认值）');

  evalCmd
    .command('rule')
    .description('rule 评测：R1 理解力 / R2 形式执行 / R3 语义可核')
    .option('--answers <file>', '答案 JSON（必填）')
    .option('--cases <file>', '用例 JSON（必填）')
    .option('--root <dir>', '锚解析根（默认当前目录）')
    .option('--limits <file>', '阈值 JSON（如 {"tokensUpper":250}；需同时给 --file）')
    .option('--file <file>', '被评 rule 文件（可选；给了才度量 token/字符/行）')
    .option('--json', '以 JSON 输出', false)
    .action((options: RuleCliOptions) => {
      try {
        if (!options.answers || !options.cases) throw new Error('必须同时提供 --answers 与 --cases');
        if (options.limits && !options.file) throw new Error('--limits 需要同时给 --file');
        const result = scoreRuleAnswers(
          asRuleAnswers(readJson(resolve(options.answers))),
          asRuleCases(readJson(resolve(options.cases))),
          resolve(options.root ?? process.cwd()),
        );
        if (options.file) {
          result.metrics = measureText(readFileSync(resolve(options.file), 'utf8'));
          if (options.limits) {
            const limits = readJson(resolve(options.limits)) as { tokensUpper?: number };
            if (typeof limits.tokensUpper === 'number' && result.metrics.tokensUpper > limits.tokensUpper) {
              result.failures.push(`R4 token 超线 ${result.metrics.tokensUpper}/${limits.tokensUpper}`);
              result.ok = false;
            }
          }
        }
        if (options.json) {
          console.log(JSON.stringify({ kind: 'rule', ...result }, null, 2));
        } else {
          printDimension('R1', result.dimensions.R1);
          printDimension('R2', result.dimensions.R2);
          printDimension('R3', result.dimensions.R3);
          if (result.metrics) console.log(`R4 chars ${result.metrics.chars}；lines ${result.metrics.lines}；tokensUpper ${result.metrics.tokensUpper}`);
        }
        process.exitCode = finish(result);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });

  evalCmd
    .command('agent')
    .description('agent 评测：A1–A5 用例判分（证据非空才算过）')
    .option('--answers <file>', '答案 JSON（必填）')
    .option('--cases <file>', '用例 JSON（必填）')
    .option('--json', '以 JSON 输出', false)
    .action((options: AgentCliOptions) => {
      try {
        if (!options.answers || !options.cases) throw new Error('必须同时提供 --answers 与 --cases');
        const result = scoreAgentAnswers(
          asAgentAnswers(readJson(resolve(options.answers))),
          asAgentCases(readJson(resolve(options.cases))),
        );
        if (options.json) {
          console.log(JSON.stringify({ kind: 'agent', ...result }, null, 2));
        } else {
          for (const [dim, d] of Object.entries(result.dimensions)) printDimension(dim, d);
        }
        process.exitCode = finish(result);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });

  const measure = program.command('measure').description('文本度量：字符 / 行 / token 估算（无项目默认值）');
  measure
    .command('text')
    .description('度量一个文本文件的字符数、行数、字节数与 token 估算')
    .option('--file <file>', '文本文件（必填）')
    .option('--json', '以 JSON 输出', false)
    .action((options: { file?: string; json?: boolean }) => {
      try {
        if (!options.file) throw new Error('必须提供 --file');
        const metrics = measureText(readFileSync(resolve(options.file), 'utf8'));
        console.log(options.json ? JSON.stringify({ kind: 'text', ...metrics }) : JSON.stringify(metrics));
        process.exitCode = 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    });
}
