import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateLedgerText, runLedgerGate } from './ledger-gate.js';

const tpl = (rows: string[]): string =>
  `# 样本\n\n## 轮次账\n\n| 轮 | 起止（HH:MM:SS） | 耗时 | 席位 | 本轮核销 |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;

const run = (rows: string[]) => evaluateLedgerText('progress.md', tpl(rows));
const text = (rows: string[]) => {
  const r = run(rows);
  return r.out.join('\n');
};

describe('scs ledger gate', () => {
  it('完整起止对 + 耗时 → exit 0', () => {
    const r = run(['| 1 | 14:00:00~14:10:00 | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/轮次账完整性：1 行全过/);
  });

  it('HH:MM 短格式起止对 → exit 0', () => {
    expect(run(['| 1 | 14:00~14:10 | 10m | 后端 | ✅ |']).code).toBe(0);
  });

  it('起止列留空 → exit 1', () => {
    const r = run(['| 1 |  | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/起止列留空/);
  });

  it('耗时列留空 → exit 1', () => {
    const r = run(['| 1 | 14:00~14:10 |  | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/耗时列留空/);
  });

  it('只填一端「13:41~」→ exit 1', () => {
    const r = run(['| 1 | 13:41~ | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/只填了一端/);
  });

  it('只填一端「~13:41」→ exit 1', () => {
    const r = run(['| 1 | ~13:41 | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/只填了一端/);
  });

  it('裸单时间点无 ~ 分隔「12:39」→ exit 1（2026-10-20 病根变体）', () => {
    const r = run(['| 1 | 12:39 | 39m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/缺「~」分隔/);
  });

  it('起止一端格式非法「12:39~12:50abc」→ exit 1', () => {
    const r = run(['| 1 | 12:39~12:50abc | 39m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/一端格式非法/);
  });

  it('显式「未取数」标注 → exit 0 + WARN', () => {
    const r = run(['| 1 | 未取数~未取数 | 未取数 | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/未取数/);
  });

  it('一端时间一端未取数「13:41~未取数」→ exit 0 + WARN', () => {
    const r = run(['| 1 | 13:41~未取数 | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/未取数/);
  });

  it('加粗装饰「**14:00~14:10**」→ exit 0 + WARN', () => {
    const r = run(['| 1 | **14:00~14:10** | **10m** | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/装饰/);
  });

  it('括号注释「12:31~16:54（跨 session）」→ exit 0 + WARN', () => {
    const r = run(['| 1 | 12:31~16:54（跨 session） | 12m | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/装饰/);
  });

  it('表头缺失 → exit 2', () => {
    const r = evaluateLedgerText('progress.md', '# 无表头\n');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/未找到轮次账表/);
  });

  it('表头缺「耗时」列 → exit 2', () => {
    const r = evaluateLedgerText(
      'progress.md',
      '# 样本\n\n## 轮次账\n\n| 轮 | 起止 | 席位 |\n|---|---|---|\n| 1 | 14:00~14:10 | 后端 |\n',
    );
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/缺「起止」或「耗时」列/);
  });

  it('轮次账行数 vs 小节数不符 → exit 0 + WARN', () => {
    const content = `${tpl(['| 1 | 14:00~14:10 | 10m | 后端 | ✅ |', '| 2 | 14:10~14:20 | 10m | 后端 | ✅ |'])}\n## 第 1 轮\n`;
    const r = evaluateLedgerText('progress.md', content);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/小节.*不一致/);
  });

  it('小节标题带括号说明也计入小节数，不报假 WARN', () => {
    const content = `${tpl(['| 1 | 14:00~14:10 | 10m | 后端 | ✅ |', '| 2 | 14:10~14:20 | 10m | 后端 | ✅ |'])}\n## 第 1 轮（确认轮，14:00~14:10；判 FAIL）\n\n## 第 2 轮\n`;
    const r = evaluateLedgerText('progress.md', content);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).not.toMatch(/小节.*不一致/);
  });

  it('起止整格「未取数」→ exit 0 + WARN', () => {
    const r = run(['| 1 | 未取数 | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/起止整格标「未取数」/);
  });

  it('耗时无 N m 但有说明「跨 session」→ exit 0 + WARN', () => {
    const r = run(['| 1 | 14:00~14:10 | 跨 session | 后端 | ✅ |']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/耗时无 N m 但有说明/);
  });

  it('起止格式非法「abc~def」→ exit 1', () => {
    const r = run(['| 1 | abc~def | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/起止格式非法/);
  });

  it('表头缺「起止」列 → exit 2', () => {
    const r = evaluateLedgerText(
      'progress.md',
      '# 样本\n\n## 轮次账\n\n| 轮 | 耗时 | 席位 |\n|---|---|---|\n| 1 | 10m | 后端 |\n',
    );
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/未找到轮次账表/);
  });

  it('无参数调用 → exit 2 + 用法提示', () => {
    const r = runLedgerGate(undefined);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/用法/);
  });

  it('文件不存在 → exit 2', () => {
    const r = runLedgerGate(join(tmpdir(), 'scs-gate-missing-xxx.md'));
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/读取.*失败/);
  });

  it('表头存在但无数据行 → exit 2', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/轮次账表下无数据行/);
  });

  it('列顺序调换（耗时列非固定列位）仍正确判 → exit 0', () => {
    const content = `# 样本\n\n## 轮次账\n\n| 轮 | 耗时 | 起止（HH:MM:SS） | 席位 | 本轮核销 |\n|---|---|---|---|---|\n| 1 | 10m | 14:00~14:10 | 后端 | ✅ |\n`;
    expect(evaluateLedgerText('progress.md', content).code).toBe(0);
  });

  it('无时间点的只填一端「abc~」→ exit 1', () => {
    const r = run(['| 1 | abc~ | 10m | 后端 | ✅ |']);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/只填了一端/);
  });

  it('辅助函数：多行输出稳定含汇总行', () => {
    expect(text(['| 1 | 14:00~14:10 | 10m | 后端 | ✅ |'])).toContain('轮次账完整性：1 行全过');
  });
});
