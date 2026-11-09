import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLedgerNumbers, checkTerminalReconcile, runLedgerNumbers } from './ledger-numbers.js';

interface Fixture {
  cards?: string;
  progress?: string;
  problems?: string;
}

/** 造一个临时评审目录；用完即删 */
function withReview<T>(f: Fixture, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'scs-ledger-numbers-'));
  if (f.cards !== undefined) writeFileSync(join(dir, 'cards.md'), f.cards, 'utf8');
  if (f.progress !== undefined) writeFileSync(join(dir, 'progress.md'), f.progress, 'utf8');
  if (f.problems !== undefined) writeFileSync(join(dir, 'problems.md'), f.problems, 'utf8');
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 合规夹具：9 / 22 / 22 = 53，且 progress 小节内不写副本数字 */
function compliantFixture(): Required<Fixture> {
  const levels = [...Array(9).fill('P0'), ...Array(22).fill('P1'), ...Array(22).fill('P2')];
  const seats = ['BE', 'FE', 'QA', 'AI', 'RD', 'AU'];
  const cards = [
    '# 卡片：夹具（第 1 轮）',
    '',
    '> 共 **53 张**（**卡级** P0 9 / P1 22 / P2 22），另候选 21 条。',
    '',
    ...levels.map((lv, i) => {
      const seat = seats[i % 6];
      return `#### ${seat}-1-${String(i + 1).padStart(2, '0')} 【${lv}】夹具卡 ${i + 1}`;
    }),
    '',
    '- **P1 族 2 个**：F3 甲（BE-1-01）；F4 乙（FE-1-02）',
    '- **P2 族 1 个 + 候选 1 个**：F18 丙（QA-1-03）；**候选 F26** 丁（FE-1-04）',
  ].join('\n');

  const progress = [
    '# 议会评审：夹具',
    '',
    '## 轮次账',
    '',
    '| 轮 | 起止（HH:MM:SS） | 耗时 | 席位 | 出卡数 | 各席结论 | 侦探 | 审计 | 本轮核销 |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 10:00:00~10:10:00 | 10m | 6 席 | 53 张（**卡级** P0 9 / P1 22 / P2 22） | 全 FAIL | 未起跑 | 未起跑 | ⬜ |',
    '',
    '## 第 1 轮',
    '',
    '### 段一 · 评审',
    '',
    '- **出卡**：6 席并行独立出卡 → 原始卡见 `cards.md`（数量见轮次账第 1 行）',
    '- **答辩**：全部承认',
  ].join('\n');

  const problems = [
    '# 问题台账：夹具',
    '',
    '## 第 1 轮',
    '',
    '### 一、P0（2 个问题，均已修）',
    '',
    '| 族 | 成员卡 | 处置 |',
    '|---|---|---|',
    '| F1 | BE-1-01 | 已修 |',
    '| F2 | FE-1-01 | 已修 |',
  ].join('\n');

  return { cards, progress, problems };
}

const ROW =
  '| 1 | 10:00:00~10:10:00 | 10m | 6 席 | 53 张（**卡级** P0 9 / P1 22 / P2 22） | 全 FAIL | 未起跑 | 未起跑 | ⬜ |';

/** 造一个只含指定文件的临时目录；用完即删 */
function withFiles<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'scs-c5-'));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t, 'utf8');
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('C5 终态对账', () => {
  it('求和相等 → 无 fail / 无 warn', () => {
    withFiles({
      'cards.md': '#### AA-1-01 【P0】x\n#### AA-1-02 【P1】y\n#### AA-1-03 【P2】z\n',
      'round-check.md': '| 第 3 项 | 本轮终态对账 | 过 | 已修=1 关闭=1 候选=0 升级=1 带往下轮=0 |\n',
    }, (dir) => {
      expect(checkTerminalReconcile(dir)).toEqual({});
    });
  });

  it('求和不等 → fail', () => {
    withFiles({
      'cards.md': '#### AA-1-01 【P0】x\n',
      'round-check.md': '| 第 3 项 | 本轮终态对账 | 过 | 已修=1 关闭=1 候选=0 升级=0 带往下轮=0 |\n',
    }, (dir) => {
      expect(checkTerminalReconcile(dir).fail).toMatch(/C5 终态对账不符：求和 2 ≠ 卡片数 1/);
    });
  });

  it('缺行 / 空文件 → 只 warn', () => {
    withFiles({ 'cards.md': '#### AA-1-01 【P0】x\n', 'round-check.md': '' }, (dir) => {
      expect(checkTerminalReconcile(dir).warn).toMatch(/C5 未取数/);
      expect(checkTerminalReconcile(dir).fail).toBeUndefined();
    });
  });

  it('缺 cards.md → 只 warn', () => {
    withFiles({ 'round-check.md': '| 第 3 项 | x | 过 | 已修=0 关闭=0 候选=0 升级=0 带往下轮=0 |\n' }, (dir) => {
      expect(checkTerminalReconcile(dir).warn).toMatch(/缺 cards\.md/);
    });
  });
});

describe('C2 新声明形态（卡片数 N（P0 a / P1 b / P2 c））', () => {
  it('新形态命中且相符 → 不报 C2', () => {
    const f = compliantFixture();
    const cards = f.cards.replace('共 **53 张**（**卡级** P0 9 / P1 22 / P2 22）', '卡片数 53（P0 9 / P1 22 / P2 22）');
    withReview({ ...f, cards }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C2'))).toEqual([]);
    });
  });

  it('新形态不符 → 必红', () => {
    const f = compliantFixture();
    const cards = f.cards.replace('共 **53 张**（**卡级** P0 9 / P1 22 / P2 22）', '卡片数 53（P0 6 / P1 22 / P2 25）');
    withReview({ ...f, cards }, (dir) => {
      const c2 = checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C2'));
      expect(c2).toHaveLength(1);
      expect(c2[0]?.msg).toContain('P0 写 6，实为 9');
    });
  });

  it('同一行两种形态不双计 → 只报 1 条 C2', () => {
    const f = compliantFixture();
    const cards = f.cards.replace(
      '共 **53 张**（**卡级** P0 9 / P1 22 / P2 22）',
      '共 **53 张**（**卡级** P0 6 / P1 22 / P2 25）；卡片数 53（P0 6 / P1 22 / P2 25）',
    );
    withReview({ ...f, cards }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C2'))).toHaveLength(1);
    });
  });

  it('半角括号变体也命中', () => {
    const f = compliantFixture();
    const cards = f.cards.replace('共 **53 张**（**卡级** P0 9 / P1 22 / P2 22）', '卡片数 53(P0 9 / P1 22 / P2 22)');
    withReview({ ...f, cards }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C2'))).toEqual([]);
    });
  });

  it('旧形态仍命中（回归）', () => {
    const f = compliantFixture();
    const cards = f.cards.replace('P0 9 / P1 22 / P2 22', 'P0 6 / P1 22 / P2 25');
    withReview({ ...f, cards }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.some((x) => x.msg.includes('C2'))).toBe(true);
    });
  });
});

describe('scs ledger numbers', () => {
  it('合规账本 → 0 处不一致', () => {
    const f = compliantFixture();
    withReview(f, (dir) => {
      expect(checkLedgerNumbers(dir).fails).toEqual([]);
    });
  });

  it('C2 实数校准：声明 P0 6 张，实际 9 张 → 必红', () => {
    const f = compliantFixture();
    const cards = f.cards.replace('P0 9 / P1 22 / P2 22', 'P0 6 / P1 22 / P2 25');
    withReview({ ...f, cards }, (dir) => {
      const { fails } = checkLedgerNumbers(dir);
      expect(fails.some((x) => x.msg.includes('C2'))).toBe(true);
      expect(fails.some((x) => x.msg.includes('P0 写 6，实为 9'))).toBe(true);
    });
  });

  it('C1 算术自检：45 个问题（P0 5 / P1 13 / P2 26）→ 必红（5+13+26=44）', () => {
    const f = compliantFixture();
    const progress = f.progress.replace(ROW, '| 1 | 10:00:00~10:10:00 | 10m | 6 席 | 45 个问题（P0 5 / P1 13 / P2 26） | 全 FAIL | 未起跑 | 未起跑 | ⬜ |');
    withReview({ ...f, progress }, (dir) => {
      const { fails } = checkLedgerNumbers(dir);
      expect(fails.some((x) => x.msg.includes('C1'))).toBe(true);
      expect(fails.some((x) => x.msg.includes('=44'))).toBe(true);
    });
  });

  it('C3 族号计数：P1 族写 17 个但只列 15 个 F → 必红', () => {
    const f = compliantFixture();
    const ids = Array.from({ length: 15 }, (_, i) => `F${i + 3}`).join('、');
    const cards = f.cards.replace('- **P1 族 2 个**：F3 甲（BE-1-01）；F4 乙（FE-1-02）', `- **P1 族 17 个**：${ids}`);
    withReview({ ...f, cards }, (dir) => {
      const { fails } = checkLedgerNumbers(dir);
      expect(fails.some((x) => x.msg.includes('C3'))).toBe(true);
      expect(fails.some((x) => x.msg.includes('列出了 15 个'))).toBe(true);
    });
  });

  it('C3 族号计数：候选族不计入该级（P2 写 8 个、列 10 个 + 候选 F26 → 报 10）', () => {
    const f = compliantFixture();
    const ids = Array.from({ length: 11 }, (_, i) => `F${i + 18}`)
      .filter((x) => x !== 'F26')
      .join('、');
    const cards = f.cards.replace(
      '- **P2 族 1 个 + 候选 1 个**：F18 丙（QA-1-03）；**候选 F26** 丁（FE-1-04）',
      `- **P2 族 8 个**：${ids}；**候选 F26** 戊（FE-1-05）`,
    );
    withReview({ ...f, cards }, (dir) => {
      const { fails } = checkLedgerNumbers(dir);
      expect(fails.some((x) => x.msg.includes('C3'))).toBe(true);
      expect(fails.some((x) => x.msg.includes('列出了 10 个'))).toBe(true);
    });
  });

  it('C4 副本禁令：轮次小节内重复写「共 N 张（P0 …）」→ 必红', () => {
    const f = compliantFixture();
    const progress = f.progress.replace(
      '- **出卡**：6 席并行独立出卡 → 原始卡见 `cards.md`（数量见轮次账第 1 行）',
      '- **出卡**：共 **6 张**（P0 0 / P1 4 / P2 2）',
    );
    withReview({ ...f, progress }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.some((x) => x.msg.includes('C4'))).toBe(true);
    });
  });

  it('C4 副本禁令：「归并：P0 …」也是副本 → 必红', () => {
    const f = compliantFixture();
    const progress = f.progress.replace(
      '- **答辩**：全部承认',
      '- **答辩**：全部承认\n- **归并**：P0 5 / P1 14 条（13 族）/ P2 26',
    );
    withReview({ ...f, progress }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.some((x) => x.msg.includes('C4'))).toBe(true);
    });
  });

  it('不覆盖：语义合并类（28 处引用 → 13 族还是 14 条）脚本不判', () => {
    const f = compliantFixture();
    const problems = [
      '# 问题台账：夹具',
      '',
      '## 第 1 轮',
      '',
      '### 二、P1（14 条 / 13 族 / 28 处引用，均已修）',
      '',
      '| 族 | 成员卡 | 处置 |',
      '|---|---|---|',
      '| F1 | BE-1-01 | 已修 |',
    ].join('\n');
    withReview({ ...f, problems }, (dir) => {
      expect(checkLedgerNumbers(dir).fails).toEqual([]);
    });
  });

  it('CLI：目录不存在 → exit 2', () => {
    expect(runLedgerNumbers(join(tmpdir(), 'scs-definitely-not-a-dir-xyz')).code).toBe(2);
  });

  it('CLI：合规目录 → exit 0 且打印「0 处不一致」', () => {
    const f = compliantFixture();
    withReview(f, (dir) => {
      const r = runLedgerNumbers(dir);
      expect(r.code).toBe(0);
      expect(r.out.join('\n')).toContain('0 处不一致');
    });
  });

  it('CLI：有错误 → exit 1', () => {
    const f = compliantFixture();
    const cards = f.cards.replace('P0 9 / P1 22 / P2 22', 'P0 6 / P1 22 / P2 25');
    withReview({ ...f, cards }, (dir) => {
      expect(runLedgerNumbers(dir).code).toBe(1);
    });
  });

  it('问题1：缺 progress.md → check() 报 FAIL，CLI exit 2（不再静默通过）', () => {
    withReview({ problems: '# 只有台账\n' }, (dir) => {
      const { fails, warns } = checkLedgerNumbers(dir);
      expect(fails.some((f) => f.msg.includes('缺 progress.md'))).toBe(true);
      expect(warns.some((w) => w.includes('缺 progress.md'))).toBe(true);
      expect(runLedgerNumbers(dir).code).toBe(2);
    });
  });

  it('问题2：未写「卡级」的分布不被当成卡级声明（总数碰撞不再误报）', () => {
    const f = compliantFixture();
    const progress = f.progress.replace(ROW, '| 1 | 10:00:00~10:10:00 | 10m | 6 席 | 53 个问题（P0 0 / P1 22 / P2 31） | 全 FAIL | 未起跑 | 未起跑 | ⬜ |');
    withReview({ ...f, progress }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C2'))).toEqual([]);
    });
  });

  it('问题3：卡标题一位序号、或缺【P0/P1/P2】时，不假红', () => {
    const progress = ['# 账本', '', '## 第 1 轮', '', '- **出卡**：见轮次账'].join('\n');
    const oneDigit = [
      '> 共 **2 张**（**卡级** P0 1 / P1 1 / P2 0）',
      '#### BE-1-1 【P0】甲',
      '#### FE-1-2 【P1】乙',
    ].join('\n');
    withReview({ cards: oneDigit, progress }, (dir) => {
      expect(checkLedgerNumbers(dir).fails).toEqual([]);
    });

    const missingLevel = [
      '> 共 **2 张**（**卡级** P0 1 / P1 1 / P2 0）',
      '#### BE-1-01 甲',
      '#### FE-1-02 【P1】乙',
    ].join('\n');
    withReview({ cards: missingLevel, progress }, (dir) => {
      const { fails, warns } = checkLedgerNumbers(dir);
      expect(fails).toEqual([]);
      expect(warns.some((w) => w.includes('C2 已跳过'))).toBe(true);
    });
  });

  it('问题4：C3 不把他级族号（括号旁注）与同行第二个标题算进来', () => {
    const f = compliantFixture();
    const progress = ['# 账本', '', '## 第 1 轮', '', '- **出卡**：见轮次账'].join('\n');

    const cardsA = f.cards.replace(
      '- **P1 族 2 个**：F3 甲（BE-1-01）；F4 乙（FE-1-02）',
      '- **P1 族 2 个**：F3 甲（同 F1、F2 见上）；F4 乙',
    );
    withReview({ ...f, cards: cardsA, progress }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C3'))).toEqual([]);
    });

    const cardsB = f.cards.replace(
      '- **P1 族 2 个**：F3 甲（BE-1-01）；F4 乙（FE-1-02）',
      '- **P1 族 2 个**：F3 甲、F4 乙；**P2 族 1 个**：F18 丙',
    );
    withReview({ ...f, cards: cardsB, progress }, (dir) => {
      expect(checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C3'))).toEqual([]);
    });
  });

  it('问题5：C4 对普通叙述也判红（有意为之，固定行为并给出改写提示）', () => {
    const f = compliantFixture();
    const progress = f.progress.replace('- **答辩**：全部承认', '- **答辩**：全部承认\n- 本节共 2 处笔误已修');
    withReview({ ...f, progress }, (dir) => {
      const c4 = checkLedgerNumbers(dir).fails.filter((x) => x.msg.includes('C4'));
      expect(c4).toHaveLength(1);
      expect(c4[0]?.msg).toContain('若只是普通叙述');
    });
  });
});

