import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../program.js';
import {
  anchorResolves,
  measureText,
  scoreAgentAnswers,
  scoreRuleAnswers,
  type AgentCase,
  type AgentAnswer,
  type RuleAnswer,
  type RuleCase,
} from './eval.js';

const RULE_CASES: RuleCase[] = [
  { id: 'S1', expect: { trigger: 'yes', verdict: 'pass', violations: [] } },
  { id: 'S2', expect: { trigger: 'yes', verdict: 'fail', violations: [1] } },
];

const casesAnswers: RuleAnswer[] = [
  { id: 'S1', trigger: 'yes', verdict: 'pass', violations: [] },
  { id: 'S2', trigger: 'yes', verdict: 'fail', violations: [1] },
  { id: 'T1', anchor: 'package.json', applicability: '本仓', target: '确认' },
];

describe('scoreRuleAnswers', () => {
  it('R1–R3 全过', () => {
    const r = scoreRuleAnswers(casesAnswers, RULE_CASES, process.cwd());
    expect(r.ok).toBe(true);
    expect(r.dimensions.R1.passed).toBe(2);
    expect(r.dimensions.R3.passed).toBe(1);
  });

  it('R1 判定不符即失败并点名', () => {
    const answers = casesAnswers.map((a) => (a.id === 'S2' ? { ...a, violations: [] } : a));
    const r = scoreRuleAnswers(answers, RULE_CASES, process.cwd());
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('S2');
  });

  it('R2 缺义务字段失败', () => {
    const answers = [...casesAnswers.slice(0, 2), { id: 'T1', anchor: 'package.json', target: '确认' }];
    const r = scoreRuleAnswers(answers, RULE_CASES, process.cwd());
    expect(r.failures.some((f) => f.includes('T1') && f.includes('applicability'))).toBe(true);
  });

  it('有数字但缺取数命令失败', () => {
    const answers = [...casesAnswers, { id: 'T2', anchor: 'package.json', applicability: '本仓', target: '计数', hasNumbers: true }];
    const r = scoreRuleAnswers(answers, RULE_CASES, process.cwd());
    expect(r.failures.some((f) => f.includes('T2') && f.includes('numberCommand'))).toBe(true);
  });

  it('假锚在 R3 失败', () => {
    const answers = [...casesAnswers, { id: 'T3', anchor: 'definitely-missing.md', applicability: '本仓', target: '确认' }];
    const r = scoreRuleAnswers(answers, RULE_CASES, process.cwd());
    expect(r.failures.some((f) => f.includes('T3') && f.includes('锚不可解析'))).toBe(true);
  });
});

describe('anchorResolves', () => {
  it('识别 path:line / 引用路径 / 命令 + 输出首行', () => {
    expect(anchorResolves('package.json:1', process.cwd())).toBe(true);
    expect(anchorResolves('package.json', process.cwd())).toBe(true);
    expect(anchorResolves('命令：node -v；输出首行：v22', process.cwd())).toBe(true);
    expect(anchorResolves('命令：node -v', process.cwd())).toBe(false);
    expect(anchorResolves('', process.cwd())).toBe(false);
  });
});

const AGENT_CASES: AgentCase[] = [
  { id: 'A1-1', dim: 'A1' },
  { id: 'A2-1', dim: 'A2' },
];
const agentOk: AgentAnswer[] = [
  { id: 'A1-1', pass: true, evidence: '回放#1' },
  { id: 'A2-1', pass: true, evidence: '回放#2' },
];

describe('scoreAgentAnswers', () => {
  it('全过时按维度汇总', () => {
    const r = scoreAgentAnswers(agentOk, AGENT_CASES);
    expect(r.ok).toBe(true);
    expect(r.dimensions.A1?.passed).toBe(1);
    expect(r.dimensions.A2?.passed).toBe(1);
  });

  it('缺答案 / 未通过 / 缺证据都失败', () => {
    const r = scoreAgentAnswers([{ id: 'A1-1', pass: false, evidence: 'x' }], AGENT_CASES);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(2);
    expect(r.failures.some((f) => f.includes('缺答案'))).toBe(true);
    expect(r.failures.some((f) => f.includes('未通过'))).toBe(true);
  });

  it('证据为空失败', () => {
    const r = scoreAgentAnswers([{ id: 'A1-1', pass: true, evidence: ' ' }, agentOk[1]!], AGENT_CASES);
    expect(r.failures.some((f) => f.includes('缺证据'))).toBe(true);
  });
});

describe('measureText', () => {
  it('统计字符 / 行 / 字节 / token 估算', () => {
    const m = measureText('你好\nabc');
    expect(m.chars).toBe(6);
    expect(m.lines).toBe(2);
    expect(m.bytes).toBe(10);
    expect(m.tokensBy4).toBe(2);
    expect(m.tokensUpper).toBe(6);
  });
});

describe('scs eval CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('eval rule 读取文件并按退出码返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scs-eval-'));
    const answers = join(dir, 'answers.json');
    const cases = join(dir, 'cases.json');
    writeFileSync(answers, JSON.stringify({ answers: casesAnswers }));
    writeFileSync(cases, JSON.stringify({ cases: RULE_CASES }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync([
      'node', 'scs', 'eval', 'rule', '--answers', answers, '--cases', cases, '--root', process.cwd(),
    ]);

    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('PASS');
    expect(process.exitCode).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
