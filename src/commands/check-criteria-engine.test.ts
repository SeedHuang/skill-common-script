import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCriteriaEngine } from './check-criteria-engine.js';

interface Fixture {
  judgeMatch?: boolean;
  ruleBody?: string;
}

/** 造一个最小项目根：假引擎模块 + 一条 rule + 一条 testcase */
function withRoot<T>(f: Fixture, fn: (root: string) => Promise<T>): Promise<T> {
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
  writeFileSync(join(engine, 'r1.json'), JSON.stringify({ id: 'r1' }));
  writeFileSync(join(engine, 'r1.testcase.json'), JSON.stringify({ rule: 'r1', cases: [{ input: 'a', expect: 'a' }] }));
  writeFileSync(join(engine, 'rules.json'), JSON.stringify({ rules: [] }));
  writeFileSync(
    join(root, 'rules', 'r1.md'),
    f.ruleBody ??
      '# 规则\n\n触发：有人要写结论时。必须给出路径锚与取数命令。例外：纯翻译类不改判据。验证：跑 `exit 0`；判据 = 命令退出码为 0 且计数 = 1。补充说明：本条判据只服务测试夹具，用于把规则正文的非空白字符数撑过预算下限（≥100），并同时命中结构闸所需的四个要素——触发、义务、例外、判定动作。\n',
  );
  writeFileSync(
    join(root, 'tools', 'quality', 'observable-terms.json'),
    JSON.stringify({ terms: ['t'], criterionTerms: ['c'], markers: [{ kind: 'k', pattern: 'p' }], samples: [], sharedPhrases: [] }),
  );

  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
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
