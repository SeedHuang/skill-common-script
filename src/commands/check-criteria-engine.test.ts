import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCriteriaEngine } from './check-criteria-engine.js';

interface Fixture {
  judgeMatch?: boolean;
  ruleBody?: string;
  nested?: boolean;
}

/** 规则正文：非空白字符 > 100，且命中结构闸四件（触发 / 义务 / 例外 / 判定动作） */
const RULE_BODY =
  '# 规则\n\n触发：有人要写结论时。必须给出路径锚与取数命令。例外：纯翻译类不改判据。验证：跑 `exit 0`；判据 = 命令退出码为 0 且计数 = 1。补充说明：本条判据只服务测试夹具，用于把规则正文的非空白字符数撑过预算下限（≥100），并同时命中结构闸所需的四个要素——触发、义务、例外、判定动作。\n';

/** 造一个最小项目根：假引擎模块 + 一条 rule + 一条 testcase（nested 时数据落 jsons/<id>/） */
function withRoot<T>(f: Fixture, fn: (root: string, opts: Record<string, string>) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'scs-criteria-'));
  const engine = join(root, 'tools', 'quality', 'criteria-engine');
  mkdirSync(engine, { recursive: true });
  mkdirSync(join(root, 'rules'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'tools', 'quality'), { recursive: true });

  writeFileSync(
    join(engine, 'schema.mjs'),
    [
      'export function check() {}',
      'export function checkTestcase() {}',
      `export function judge(rule, input) { return ${f.judgeMatch === false ? "'mismatch'" : 'input'} }`,
    ].join('\n'),
  );
  writeFileSync(join(engine, 'interpreters.mjs'), 'export const interpreters = []\n');
  writeFileSync(join(engine, 'rules.mjs'), 'export function renderRuleData() { return "" }\n');
  const dataDir = f.nested ? join(engine, 'jsons') : engine;
  if (f.nested) {
    mkdirSync(join(dataDir, 'r1'), { recursive: true });
    writeFileSync(join(dataDir, 'r1', 'index.json'), JSON.stringify({ id: 'r1' }));
    writeFileSync(join(dataDir, 'r1', 'testcase.json'), JSON.stringify({ rule: 'r1', cases: [{ input: 'a', expect: 'a' }] }));
    writeFileSync(join(dataDir, 'rules.json'), JSON.stringify({ rules: [] }));
  } else {
    writeFileSync(join(engine, 'r1.json'), JSON.stringify({ id: 'r1' }));
    writeFileSync(join(engine, 'r1.testcase.json'), JSON.stringify({ rule: 'r1', cases: [{ input: 'a', expect: 'a' }] }));
    writeFileSync(join(engine, 'rules.json'), JSON.stringify({ rules: [] }));
  }
  writeFileSync(
    join(root, 'rules', 'r1.md'),
    f.ruleBody ?? RULE_BODY,
  );
  writeFileSync(
    join(root, 'tools', 'quality', 'observable-terms.json'),
    JSON.stringify({ terms: ['t'], criterionTerms: ['c'], markers: [{ kind: 'k', pattern: 'p' }], samples: [], sharedPhrases: [] }),
  );

  return fn(root, f.nested ? { dataDir: 'tools/quality/criteria-engine/jsons' } : {}).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('scs check criteria-engine', () => {
  it('引擎在 → 首行契约成立、末行 ok、exit 0', async () => {
    await withRoot({}, async (root) => {
      const r = await runCriteriaEngine(root);
      expect(r.code).toBe(0);
      expect(r.stdout[0]).toMatch(/^判据 \d+ 条 \/ 绿 \d+ \/ 红 \d+$/);
      expect(r.stdout).toContain('criteria-engine ok');
    });
  });

  it('nested 布局 → 与 flat 同契约（向后兼容）', async () => {
    await withRoot({ nested: true }, async (root, opts) => {
      const r = await runCriteriaEngine(root, opts);
      expect(r.code).toBe(0);
      expect(r.stdout[0]).toMatch(/^判据 \d+ 条 \/ 绿 \d+ \/ 红 \d+$/);
      expect(r.stdout).toContain('criteria-engine ok');
    });
  });

  it('case 不匹配 → exit 1 且报 CaseMismatch', async () => {
    await withRoot({ judgeMatch: false }, async (root) => {
      const r = await runCriteriaEngine(root);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('criteria-engine fail');
      expect(r.stderr.join('\n')).toMatch(/CaseMismatch/);
    });
  });

  it('规则正文低于预算下限 → exit 1 且报 RuleUnderBudget', async () => {
    await withRoot({ ruleBody: '# 短规则\n' }, async (root) => {
      const r = await runCriteriaEngine(root);
      expect(r.code).toBe(1);
      expect(r.stderr.join('\n')).toMatch(/RuleUnderBudget/);
    });
  });

  it('引擎目录缺失 → exit 2 且给出原因', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scs-criteria-missing-'));
    try {
      const r = await runCriteriaEngine(root);
      expect(r.code).toBe(2);
      expect(r.stderr.join('\n')).toMatch(/判据引擎目录不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** 造一个「引擎模块 / 判据数据 / 渲染投影」三目录分离的项目根（新仓布局） */
function withSplitRoot<T>(cfg: { projection?: boolean }, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'scs-criteria-split-'));
  const engine = join(root, 'builders', 'rules');
  const data = join(root, 'dsl', 'rules');
  const vocab = join(data, 'vocab');
  mkdirSync(engine, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(vocab, { recursive: true });
  mkdirSync(join(root, 'rules'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'keep.md'), '# keep\n');

  writeFileSync(
    join(engine, 'schema.mjs'),
    [
      'export function check() {}',
      'export function checkTestcase() {}',
      'export function judge(rule, input) { return input }',
    ].join('\n'),
  );
  writeFileSync(join(engine, 'interpreters.mjs'), "export const interpreters = [{ ext: 'md', render: () => '# 投影\\n' }]\n");
  writeFileSync(join(engine, 'rules.mjs'), 'export function renderRuleData() { return "" }\n');
  if (cfg.projection !== false) writeFileSync(join(engine, 'r1.md'), '# 投影\n');

  writeFileSync(join(data, 'r1.json'), JSON.stringify({ id: 'r1' }));
  writeFileSync(join(data, 'r1.testcase.json'), JSON.stringify({ rule: 'r1', cases: [{ input: 'a', expect: 'a' }] }));
  writeFileSync(join(data, 'rules.json'), JSON.stringify({ rules: [] }));
  // 词表放子目录：判据数据目录的枚举口径是「顶层 .json 即一条判据」，词表混在顶层会被当成 rule
  writeFileSync(join(vocab, 'terms.json'), JSON.stringify({ sharedPhrases: [] }));

  writeFileSync(join(root, 'rules', 'r1.md'), RULE_BODY);
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const SPLIT_OPTIONS = {
  engineDir: 'builders/rules',
  dataDir: 'dsl/rules',
  projectionDir: 'builders/rules',
  termsFile: 'dsl/rules/vocab/terms.json',
  surfaces: ['skills'],
};

describe('scs check criteria-engine（布局参数）', () => {
  it('引擎 / 数据 / 投影三目录分离 → exit 0', async () => {
    await withSplitRoot({}, async (root) => {
      const r = await runCriteriaEngine(root, SPLIT_OPTIONS);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('criteria-engine ok');
    });
  });

  it('投影目录缺件 → exit 1 且报 ProjectionMissing', async () => {
    await withSplitRoot({ projection: false }, async (root) => {
      const r = await runCriteriaEngine(root, SPLIT_OPTIONS);
      expect(r.code).toBe(1);
      expect(r.stderr.join('\n')).toMatch(/ProjectionMissing/);
    });
  });

  it('数据目录不存在 → exit 2 且点名目录', async () => {
    await withSplitRoot({}, async (root) => {
      const r = await runCriteriaEngine(root, { ...SPLIT_OPTIONS, dataDir: 'dsl/missing' });
      expect(r.code).toBe(2);
      expect(r.stderr.join('\n')).toMatch(/判据数据目录不存在：dsl\/missing/);
    });
  });
});
