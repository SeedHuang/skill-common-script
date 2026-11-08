import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 项目侧引擎模块（按 --root 动态加载，不随 CLI 分发）──────────────────────
interface SchemaFinding {
  code: string;
  message?: string;
}

interface SchemaModule {
  check(rule: unknown, name: string, errs: SchemaFinding[]): void;
  checkTestcase(tc: unknown, name: string, ids: Set<string>, errs: string[]): void;
  judge(rule: unknown, input: unknown): unknown;
}

interface Interpreter {
  ext?: string;
  render(rule: unknown): string;
}

interface InterpretersModule {
  interpreters: Interpreter[];
}

interface RulesModule {
  renderRuleData(rule: unknown): string;
}

interface RuleJson {
  id: string;
}

interface TestcaseJson {
  rule: string;
  cases: { input: unknown; expect: unknown }[];
}

export class CriteriaEngineFail extends Error {}

const BUDGET = { minChars: 100, maxChars: 500, maxCount: 9, maxTotal: 26513 };
const RULES_DIR = 'rules';
// 布局默认值 = 旧仓（tools/quality/criteria-engine）形态，保证既有调用零改动可跑。
// 目录不写死在逻辑里：scs 是独立 CLI，不该知道任何具体项目的目录结构，新仓用入参覆盖。
const DEFAULT_ENGINE_DIR = 'tools/quality/criteria-engine';
const DEFAULT_TERMS_FILE = 'tools/quality/observable-terms.json';
const DEFAULT_SURFACES = ['skills', 'tools/quality'];

export interface CriteriaEngineOptions {
  /** 引擎模块目录（schema.mjs / interpreters.mjs / rules.mjs），默认 tools/quality/criteria-engine */
  engineDir?: string;
  /** 判据数据目录（`<id>.json` / `<id>.testcase.json` / `rules.json`），默认 = engineDir */
  dataDir?: string;
  /** 渲染投影目录（`<id>.md`），默认 = engineDir */
  projectionDir?: string;
  /** 共享片段词表，默认 tools/quality/observable-terms.json */
  termsFile?: string;
  /** 承接面扫描目录（共享片段复制检查），默认 ['skills', 'tools/quality'] */
  surfaces?: string[];
}

const strip = (t: string): string => t.replace(/^\uFEFF/, '');
const nonWs = (t: string): string => t.replace(/\s/g, '');
const loadJson = <T>(p: string): T => JSON.parse(strip(readFileSync(p, 'utf8'))) as T;

function walkMd(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// 结构闸：保留 rule 的「触发 / 义务 / 例外 / 判定动作」四件
const ACTION_GATE = /(path:line|退出码|\bexit\b|命令|计数\s*=|非空|为空|枚举[：:]|diff|运行 `|检查 `|读取 `|统计 `|列出文件名)/;
function structureGate(text: string, file: string): { file: string; code: string; missing: string[] }[] {
  const missing: string[] = [];
  if (!/触发/.test(text)) missing.push('触发');
  if (!/(义务|必须|禁止|不得)/.test(text)) missing.push('义务');
  if (!/(例外|除非|只许|不再|不得)/.test(text)) missing.push('例外');
  if (!ACTION_GATE.test(text)) missing.push('判定动作');
  return missing.length ? [{ file, code: 'RuleStructureIncomplete', missing }] : [];
}

export interface CriteriaEngineResult {
  code: 0 | 1 | 2;
  stdout: string[];
  stderr: string[];
}

async function loadEngine(dir: string, label: string): Promise<{ schema: SchemaModule; interp: InterpretersModule; rules: RulesModule }> {
  if (!existsSync(dir)) throw new CriteriaEngineFail(`判据引擎目录不存在：${label}`);
  const load = async <T>(file: string): Promise<T> =>
    (await import(pathToFileURL(join(dir, file)).href)) as unknown as T;
  return {
    schema: await load<SchemaModule>('schema.mjs'),
    interp: await load<InterpretersModule>('interpreters.mjs'),
    rules: await load<RulesModule>('rules.mjs'),
  };
}

/**
 * 判据引擎校验器 + 分层预算闸（门禁 ⑨ 段）。
 * 判定语义不复制：全部委托给 `options.engineDir` 的 schema / interpreters / rules。
 * 布局三目录（引擎模块 / 判据数据 / 渲染投影）可分离，默认全部落在旧仓的
 * `tools/quality/criteria-engine`，既有调用无需改动。
 * 输出契约：首行固定 `判据 N 条 / 绿 M / 红 K`；末行 `criteria-engine ok` 且 exit 0 才算过。
 */
export async function runCriteriaEngine(
  root: string,
  options: CriteriaEngineOptions = {},
): Promise<CriteriaEngineResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const engineRel = options.engineDir ?? DEFAULT_ENGINE_DIR;
  const dataRel = options.dataDir ?? engineRel;
  const projectionRel = options.projectionDir ?? engineRel;
  const termsRel = options.termsFile ?? DEFAULT_TERMS_FILE;
  const surfaces = options.surfaces ?? DEFAULT_SURFACES;
  const joinRel = (dir: string, file: string): string => `${dir.replace(/[\\/]+$/, '')}/${file}`;
  try {
    const { schema, interp, rules: rulesMod } = await loadEngine(resolve(root, engineRel), engineRel);
    const findings: { file?: string; code: string; message?: string; missing?: string[]; rule?: string; phrase?: string }[] = [];

    const dataAbs = resolve(root, dataRel);
    const projectionAbs = resolve(root, projectionRel);
    const rulesAbs = resolve(root, RULES_DIR);
    if (!existsSync(dataAbs)) throw new CriteriaEngineFail(`判据数据目录不存在：${dataRel}`);
    const ruleFiles = readdirSync(dataAbs).filter((n) => n.endsWith('.json') && !n.endsWith('.testcase.json') && n !== 'rules.json');
    const tcFiles = readdirSync(dataAbs).filter((n) => n.endsWith('.testcase.json'));
    const rules = ruleFiles.map((name) => ({ name, rule: loadJson<RuleJson>(join(dataAbs, name)) }));
    const tcs = tcFiles.map((name) => ({ name, tc: loadJson<TestcaseJson>(join(dataAbs, name)) }));
    const ids = new Set(rules.map((r) => r.rule.id));

    let green = 0;
    let red = 0;
    for (const { name, tc } of tcs) {
      if (!ids.has(tc.rule)) findings.push({ file: name, code: 'UnknownRuleRef', rule: tc.rule });
    }
    for (const { name, rule } of rules) {
      const errs: SchemaFinding[] = [];
      schema.check(rule, name, errs);
      for (const e of errs) findings.push({ file: name, code: e.code, message: e.message });

      const entry = tcs.find((t) => t.tc.rule === rule.id);
      if (!entry) {
        findings.push({ file: name, code: 'TestcaseMissing', message: rule.id });
        red += 1;
        continue;
      }
      const tcErrs: string[] = [];
      schema.checkTestcase(entry.tc, entry.name, ids, tcErrs);
      for (const e of tcErrs) findings.push({ file: entry.name, code: 'TestcaseSchema', message: e });
      entry.tc.cases.forEach((c, i) => {
        const got = schema.judge(rule, c.input);
        if (got === c.expect) green += 1;
        else {
          red += 1;
          findings.push({ file: entry.name, code: 'CaseMismatch', message: `case ${i} expect: ${String(c.expect)} got: ${String(got)}` });
        }
      });

      // 逐字节比对渲染物：手改即红，缺件也红
      for (const it of interp.interpreters) {
        if (!it.ext) continue;
        const projRel = joinRel(projectionRel, `${rule.id}.${it.ext}`);
        const projAbs = join(projectionAbs, `${rule.id}.${it.ext}`);
        const expected = it.render(rule);
        if (!existsSync(projAbs)) {
          findings.push({ file: projRel, code: 'ProjectionMissing' });
          continue;
        }
        if (strip(readFileSync(projAbs, 'utf8')) !== expected) {
          findings.push({ file: projRel, code: 'ProjectionDrift', message: '手改渲染物（重渲染结果与磁盘不一致）' });
        }
      }
    }

    // 分层预算闸：rule 逐条非空白字符 + 条数 + 总量
    const ruleMd = existsSync(rulesAbs) ? readdirSync(rulesAbs).filter((n) => n.endsWith('.md')) : [];
    let total = 0;
    for (const f of ruleMd) {
      const text = readFileSync(join(rulesAbs, f), 'utf8');
      const n = nonWs(text).length;
      total += n;
      if (n > BUDGET.maxChars) findings.push({ file: `rules/${f}`, code: 'RuleOverBudget', message: `chars=${n} max: ${BUDGET.maxChars}` });
      if (n < BUDGET.minChars) findings.push({ file: `rules/${f}`, code: 'RuleUnderBudget', message: `chars=${n} min: ${BUDGET.minChars}` });
      for (const g of structureGate(text, `rules/${f}`)) findings.push(g);
    }
    if (ruleMd.length > BUDGET.maxCount) findings.push({ code: 'RuleCountOverBudget', message: `count=${ruleMd.length} max: ${BUDGET.maxCount}` });
    if (total > BUDGET.maxTotal) findings.push({ code: 'RuleTotalOverBudget', message: `chars=${total} max: ${BUDGET.maxTotal}` });

    // rule 正文投影：必须由判据 json 渲染得出
    const rulesJsonAbs = join(dataAbs, 'rules.json');
    const registered = existsSync(rulesJsonAbs) ? (loadJson<{ rules?: string[] }>(rulesJsonAbs).rules ?? []) : [];
    for (const id of registered) {
      const ruleAbs = join(dataAbs, `${id}.json`);
      if (!existsSync(ruleAbs)) {
        findings.push({ file: joinRel(dataRel, `${id}.json`), code: 'RuleDataMissing' });
        continue;
      }
      let rule: unknown;
      try {
        rule = loadJson<unknown>(ruleAbs);
      } catch (e) {
        findings.push({ file: joinRel(dataRel, `${id}.json`), code: 'RuleDataUnreadable', message: (e as Error).message });
        continue;
      }
      const projRel = `${RULES_DIR}/${id}.md`;
      const projAbs = resolve(root, projRel);
      if (!existsSync(projAbs)) {
        findings.push({ file: projRel, code: 'RuleProjectionMissing' });
        continue;
      }
      if (strip(readFileSync(projAbs, 'utf8')) !== rulesMod.renderRuleData(rule)) {
        findings.push({ file: projRel, code: 'RuleProjectionDrift', message: '手改 rule 正文（与判据 json 渲染结果不一致）' });
      }
    }

    // 承接面（默认 skills/** + tools/quality/**）不得出现共享片段
    const phrases = loadJson<{ sharedPhrases?: string[] }>(resolve(root, termsRel)).sharedPhrases ?? [];
    for (const surface of surfaces) {
      for (const abs of walkMd(resolve(root, surface))) {
        const text = strip(readFileSync(abs, 'utf8'));
        for (const phrase of phrases) {
          if (text.includes(phrase)) {
            findings.push({ file: relative(root, abs).split('\\').join('/'), code: 'SharedPhraseCopy', phrase });
          }
        }
      }
    }

    stdout.push(`判据 ${rules.length} 条 / 绿 ${green} / 红 ${red}`);
    for (const f of findings) {
      let detail = f.message;
      if (!detail && Array.isArray(f.missing)) detail = `missing: ${f.missing.join(' / ')}`;
      if (!detail) detail = f.rule ?? f.phrase ?? '';
      stderr.push(`[criteria-engine] ${f.file ?? ''} ${f.code}${detail ? `：${detail}` : ''}`);
    }
    if (findings.length === 0) {
      stdout.push('criteria-engine ok');
      return { code: 0, stdout, stderr };
    }
    stdout.push('criteria-engine fail');
    return { code: 1, stdout, stderr };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stderr.push(`check-criteria-engine error：${msg}`);
    return { code: 2, stdout, stderr };
  }
}
