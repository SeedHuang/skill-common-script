import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Command } from 'commander';

// 通用能力评测：scs 只做机制（schema / 判分 / 度量 / 退出码）。
// 不写死项目路径、阈值、角色名；cases、answers、limit 均由调用方传入。

export type AnchorKind = 'path' | 'command' | 'ref' | 'any';

/** write case 的逐项期望：只声明「这条任务必须满足哪些义务」，阈值仍由调用方给 */
export interface RuleRequire {
  anchor?: AnchorKind;
  applicability?: boolean;
  target?: boolean;
  numberCommand?: boolean;
  missReport?: boolean;
  conclusionIncludes?: string;
}

export interface RuleCase {
  id: string;
  kind?: 'judge' | 'write';
  /** 用例来源：common = 各 rule 共用的覆盖点；specific = 该 rule 专属场景 */
  scope?: 'common' | 'specific';
  scenario?: string;
  expect?: { trigger: string; verdict: string; violations: number[] };
  require?: RuleRequire;
}

export interface RuleAnswer {
  id: string;
  trigger?: string;
  verdict?: string;
  violations?: number[];
  conclusion?: string;
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
  /** 按用例来源分组：公共覆盖点 / 该 rule 专属场景；未标 scope 的进 unscoped */
  byScope: Record<'common' | 'specific' | 'unscoped', { R1: Dimension; R2: Dimension; R3: Dimension }>;
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

/** 锚路径必须是仓内相对路径：绝对路径（盘符 / UNC / 根开头）与 ../ 越界一律不认 */
function repoPath(p: string, root: string): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p)) return null;
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

/** 锚类型：命令 / path:line / 引用件路径；都不成立返回 null */
export function anchorKind(anchor: string | undefined, root: string): AnchorKind | null {
  if (typeof anchor !== 'string' || anchor.trim() === '') return null;
  if (/^命令\s*[:：]?\s*\S/.test(anchor)) return 'command';
  const m = anchor.match(/^(.*):(\d+)(?:-\d+)?$/);
  const pathPart = m?.[1] ? repoPath(m[1], root) : null;
  if (pathPart && existsSync(pathPart)) return 'path';
  const ref = repoPath(anchor, root);
  if (ref && existsSync(ref)) return 'ref';
  return null;
}

export function anchorResolves(anchor: string | undefined, root: string): boolean {
  if (typeof anchor !== 'string' || anchor.trim() === '') return false;
  if (/^命令\s*[:：]?\s*\S/.test(anchor)) return /输出首行\s*[:：]?\s*\S/.test(anchor);
  const m = anchor.match(/^(.*):(\d+)(?:-\d+)?$/);
  if (m && m[1]) {
    const p = repoPath(m[1], root);
    return p !== null && existsSync(p);
  }
  const p = repoPath(anchor, root);
  return p !== null && existsSync(p);
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
  const judgeCases = cases.filter((c) => c.expect);
  const writeCases = cases.filter((c) => c.require);
  const scopeOf = (c: RuleCase): 'common' | 'specific' | 'unscoped' => c.scope ?? 'unscoped';
  const buckets = {
    common: { r1: [] as CheckItem[], r2: [] as CheckItem[], r3: [] as CheckItem[] },
    specific: { r1: [] as CheckItem[], r2: [] as CheckItem[], r3: [] as CheckItem[] },
    unscoped: { r1: [] as CheckItem[], r2: [] as CheckItem[], r3: [] as CheckItem[] },
  };

  for (const c of judgeCases) {
    const got = byId.get(c.id);
    const item = !got
      ? { id: c.id, ok: false, reason: '缺答案' }
      : (() => {
          const gotViolations = Array.isArray(got.violations) ? got.violations : [];
          const ok =
            got.trigger === c.expect!.trigger &&
            got.verdict === c.expect!.verdict &&
            sorted(gotViolations) === sorted(c.expect!.violations);
          return {
            id: c.id,
            ok,
            reason: ok ? '' : `期望 trigger=${c.expect!.trigger} verdict=${c.expect!.verdict} violations=${c.expect!.violations.join(',') || '无'}`,
          };
        })();
    buckets[scopeOf(c)].r1.push(item);
  }

  // write case：按 require 逐项判「义务是否补齐」（R2）与「锚/结论是否可核」（R3）
  for (const c of writeCases) {
    const req = c.require!;
    const got = byId.get(c.id);
    const b = buckets[scopeOf(c)];
    if (!got) {
      b.r2.push({ id: c.id, ok: false, reason: '缺答案' });
      b.r3.push({ id: c.id, ok: false, reason: '缺答案' });
      continue;
    }
    const missing: string[] = [];
    if (req.anchor && !(got.anchor ?? '').trim()) missing.push('anchor');
    if (req.applicability && !(got.applicability ?? '').trim()) missing.push('applicability');
    if (req.target && !(got.target ?? '').trim()) missing.push('target');
    if (req.numberCommand && !(got.numberCommand ?? '').trim()) missing.push('numberCommand');
    if (req.missReport && !(got.missReport ?? '').trim()) missing.push('missReport');
    b.r2.push({ id: c.id, ok: missing.length === 0, reason: missing.length ? `缺字段 ${missing.join(',')}` : '' });

    const kinds = req.anchor && req.anchor !== 'any' ? [req.anchor] : ['path', 'command', 'ref'];
    const kind = anchorKind(got.anchor, root);
    const anchorOk = req.anchor ? kind !== null && kinds.includes(kind) && anchorResolves(got.anchor, root) : true;
    const conclusionOk = req.conclusionIncludes ? (got.conclusion ?? '').includes(req.conclusionIncludes) : true;
    const reason = !anchorOk
      ? `锚类型不符或不可解析（期望 ${req.anchor ?? 'any'}，实得 ${kind ?? '无'}）`
      : !conclusionOk
        ? `结论缺关键词 ${req.conclusionIncludes}`
        : '';
    b.r3.push({ id: c.id, ok: anchorOk && conclusionOk, reason });
  }

  // 兼容旧输入：未登记为 case 的字段答案按「义务字段是否齐全」判
  const fieldAnswers = answers.filter(
    (a) => !caseIds.has(a.id) && (a.anchor !== undefined || a.applicability !== undefined || a.target !== undefined),
  );
  for (const a of fieldAnswers) {
    const missing = requiredFields(a);
    buckets.unscoped.r2.push({ id: a.id, ok: missing.length === 0, reason: missing.length ? `缺字段 ${missing.join(',')}` : '' });
    buckets.unscoped.r3.push({
      id: a.id,
      ok: anchorResolves(a.anchor, root),
      reason: anchorResolves(a.anchor, root) ? '' : '锚不可解析',
    });
  }

  const dimsOf = (b: { r1: CheckItem[]; r2: CheckItem[]; r3: CheckItem[] }) => ({
    R1: dimension(b.r1),
    R2: dimension(b.r2),
    R3: dimension(b.r3),
  });
  const byScope = { common: dimsOf(buckets.common), specific: dimsOf(buckets.specific), unscoped: dimsOf(buckets.unscoped) };
  const dimensions = {
    R1: dimension([...buckets.common.r1, ...buckets.specific.r1, ...buckets.unscoped.r1]),
    R2: dimension([...buckets.common.r2, ...buckets.specific.r2, ...buckets.unscoped.r2]),
    R3: dimension([...buckets.common.r3, ...buckets.specific.r3, ...buckets.unscoped.r3]),
  };
  const failures = [...dimensions.R1.items, ...dimensions.R2.items, ...dimensions.R3.items]
    .filter((i) => !i.ok)
    .map((i) => `${i.id} ${i.reason}`);

  // 无 pilot = 未评测；声明了 scope 就必须公共/专属两池都在
  if (cases.length === 0) failures.push('无用例（未评测）');
  const hasScope = cases.some((c) => c.scope !== undefined);
  const count = (d: { R1: Dimension; R2: Dimension; R3: Dimension }) =>
    d.R1.total + d.R2.total + d.R3.total;
  if (hasScope && count(byScope.common) === 0) failures.push('缺 common 用例（未评测）');
  if (hasScope && count(byScope.specific) === 0) failures.push('缺 specific 用例（未评测）');

  return { dimensions, byScope, failures, ok: failures.length === 0 };
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

const toArray = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** 按文件角色给用例打 scope；用例自带不同 scope 视为冲突 */
function tagScope(cases: RuleCase[], scope: 'common' | 'specific'): RuleCase[] {
  return cases.map((c) => {
    if (c.scope !== undefined && c.scope !== scope) {
      throw new Error(`用例 ${c.id} 自带 scope=${c.scope}，与所在文件角色 ${scope} 冲突`);
    }
    return { ...c, scope };
  });
}

/** 合并多个 answers 文件；重复 id 直接报错，避免静默覆盖 */
function mergeAnswers(files: string[]): RuleAnswer[] {
  const out: RuleAnswer[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const a of asRuleAnswers(readJson(resolve(f)))) {
      if (seen.has(a.id)) throw new Error(`answers 重复 id：${a.id}（${f}）`);
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
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
  answers?: string[] | string;
  cases?: string[] | string;
  commonCases?: string[] | string;
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

  const collect = (value: string, previous: string[]) => previous.concat(value);

  evalCmd
    .command('rule')
    .description('rule 评测：R1 理解力 / R2 形式执行 / R3 语义可核')
    .option('--answers <file>', '答案 JSON（可重复，按 id 合并）', collect, [])
    .option('--cases <file>', '该 rule 专属用例 JSON（可重复）', collect, [])
    .option('--common-cases <file>', '公共用例 JSON（可重复；给了才判 common 池）', collect, [])
    .option('--root <dir>', '锚解析根（默认当前目录）')
    .option('--limits <file>', '阈值 JSON（如 {"tokensUpper":250}；需同时给 --file）')
    .option('--file <file>', '被评 rule 文件（可选；给了才度量 token/字符/行）')
    .option('--json', '以 JSON 输出', false)
    .action((options: RuleCliOptions) => {
      try {
        const answerFiles = toArray(options.answers);
        const caseFiles = toArray(options.cases);
        const commonFiles = toArray(options.commonCases);
        if (answerFiles.length === 0 || caseFiles.length === 0) throw new Error('必须同时提供 --answers 与 --cases');
        if (options.limits && !options.file) throw new Error('--limits 需要同时给 --file');
        const specific = caseFiles.flatMap((f) => asRuleCases(readJson(resolve(f))));
        const cases = commonFiles.length === 0
          ? specific
          : [
              ...commonFiles.flatMap((f) => tagScope(asRuleCases(readJson(resolve(f))), 'common')),
              ...tagScope(specific, 'specific'),
            ];
        const answers = mergeAnswers(answerFiles);
        const result = scoreRuleAnswers(answers, cases, resolve(options.root ?? process.cwd()));
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
          for (const scope of ['common', 'specific', 'unscoped'] as const) {
            const d = result.byScope[scope];
            if (d.R1.total + d.R2.total + d.R3.total === 0) continue;
            console.log(`[${scope}] R1 ${d.R1.passed}/${d.R1.total}；R2 ${d.R2.passed}/${d.R2.total}；R3 ${d.R3.passed}/${d.R3.total}`);
          }
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
