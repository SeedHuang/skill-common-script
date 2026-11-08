import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkObservableCommand } from './check.js';
import { evaluateText } from './check-observable.js';

/**
 * 本文件只测**机制**：块的边界、标记识别、前置断言、豁免、退出码。
 * 词表 / 标记表 / 正反例是夹具（与任何具体项目无关）；项目的权威词表由项目自己的测试守。
 */
const FIXTURE_TERMS = ['自省', '客观', '诚实', '宽松', '严格', '清晰', '准确', '显著', '良好'];

const FIXTURE_MARKERS = [
  { kind: 'compare', pattern: '(>=|<=|==|===|!=|≥|≤|＝|>|<)\\s*[^，。；\\s]+' },
  { kind: 'pathline', pattern: '(path:line|[A-Za-z0-9_./\\\\-]+\\.(md|mjs|js|json|ts|tsx|yml|yaml|tpl):\\d+)' },
  { kind: 'exit', pattern: '(exit|退出码|退出状态)\\s*(code|码)?\\s*([=:：]|为|是)?\\s*[0-9]+' },
  { kind: 'diff', pattern: 'diff\\s*(命令|--|输出|检查)' },
  { kind: 'count', pattern: '计数\\s*=\\s*[0-9]+' },
  { kind: 'empty', pattern: '(?<![不非假])(?<!要求)为空' },
  { kind: 'nonempty', pattern: '(?<![不非假])(?<!要求)非空' },
  { kind: 'enum', pattern: '枚举[：:]\\s*[A-Za-z0-9_]' },
];

const FIXTURE_SAMPLES = [
  { term: '自省', positive: { input: '每轮收尾必须写自省结论：逐条附 docs/a.md:12。', expect: 'pass' }, negative: { input: '每轮收尾要自省，想清楚。', expect: 'fail' }, residual: { who: 'qa', sample: 1 } },
  { term: '客观', positive: { input: '评审必须客观：结论附 docs/a.md:12 逐条可追。', expect: 'pass' }, negative: { input: '评审要客观公正。', expect: 'fail' }, residual: null },
  { term: '诚实', positive: { input: '报告必须诚实：未覆盖项计数 = 3 条。', expect: 'pass' }, negative: { input: '报告要诚实。', expect: 'fail' }, residual: null },
  { term: '宽松', positive: { input: '宽松放行：退出码 exit 0 即可。', expect: 'pass' }, negative: { input: '判据写得太宽松。', expect: 'fail' }, residual: null },
  { term: '严格', positive: { input: '严格判定：每条用例必须 exit 1。', expect: 'pass' }, negative: { input: '执行要严格。', expect: 'fail' }, residual: null },
  { term: '清晰', positive: { input: '输出要清晰：形如 枚举：hit。', expect: 'pass' }, negative: { input: '文案要清晰易懂。', expect: 'fail' }, residual: null },
  { term: '准确', positive: { input: '计数要准确：计数 = 21 行。', expect: 'pass' }, negative: { input: '数字要准确。', expect: 'fail' }, residual: null },
  { term: '显著', positive: { input: '差异必须显著：diff 输出逐行贴。', expect: 'pass' }, negative: { input: '提升要显著。', expect: 'fail' }, residual: null },
  { term: '良好', positive: { input: '状态良好：findings 为空。', expect: 'pass' }, negative: { input: '运行情况良好。', expect: 'fail' }, residual: null },
];

const fixtureData = (): Record<string, unknown> => ({
  terms: FIXTURE_TERMS,
  criterionTerms: ['处置', '依据', '充分', '合理', '及时', '适当'],
  sharedPhrases: [],
  markers: FIXTURE_MARKERS,
  samples: FIXTURE_SAMPLES,
});

const BASE_FILES: Record<string, string> = {
  'rules/keep.md': '# 保底\n\n- 落点 `docs/a.md:12`。\n',
  'skills/keep/SKILL.md': '# 保底\n\n- 落点 `docs/a.md:12`。\n',
};

interface RunOptions {
  json?: boolean;
  bare?: boolean;
  emptyDirs?: string[];
  /** 词表内容：对象按 JSON 写盘；字符串原样写（用于截断 JSON 用例） */
  data?: Record<string, unknown> | string;
  exemptEntries?: unknown[];
}

interface CliResult {
  code: number;
  out: string;
  json: {
    scanned: string[];
    hits: { path: string; line: number; terms: string[] }[];
    exemptedLines: number;
    stale: { path: string; contains: string }[];
    ok: boolean;
  } | null;
  last: string;
}

function invoke(root: string, json: boolean): CliResult {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as never);
  let code = 0;
  try {
    code = checkObservableCommand({ root, json });
  } finally {
    spy.mockRestore();
  }
  const out = chunks.join('');
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  let parsed: CliResult['json'] = null;
  if (json) {
    try {
      parsed = JSON.parse(lines[0] ?? '') as CliResult['json'];
    } catch {
      parsed = null;
    }
  }
  return { code, out, json: parsed, last: lines[lines.length - 1] ?? '' };
}

function withRoot(files: Record<string, string>, opts: RunOptions = {}): CliResult {
  const root = mkdtempSync(join(tmpdir(), 'scs-obs-'));
  try {
    const all = opts.bare ? files : { ...BASE_FILES, ...files };
    for (const [rel, content] of Object.entries(all)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
    for (const d of opts.emptyDirs ?? []) mkdirSync(join(root, d), { recursive: true });
    mkdirSync(join(root, 'tools', 'quality'), { recursive: true });
    const data = opts.data ?? fixtureData();
    writeFileSync(join(root, 'tools', 'quality', 'observable-terms.json'), typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    writeFileSync(join(root, 'tools', 'quality', 'observable-exempt.json'), JSON.stringify({ entries: opts.exemptEntries ?? [] }), 'utf8');
    return invoke(root, opts.json ?? false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('扫描面与前置断言（B 组）', () => {
  it('B01 空扫描根 → exit 2 + P-1 + 无 term= 行', () => {
    const r = withRoot({}, { bare: true, emptyDirs: ['rules', 'skills'] });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/check-observable error（P-1/);
    expect(r.out).not.toMatch(/term=/);
  });

  it('B05 截断 JSON / 空 terms → 各 exit 2 + P-2（不抛栈）', () => {
    const truncated = withRoot({}, { data: JSON.stringify(fixtureData()).replace(/\}\s*$/, '') });
    expect(truncated.code).toBe(2);
    expect(truncated.last).toMatch(/error（P-2/);
    const empty = withRoot({}, { data: { ...fixtureData(), terms: [] } });
    expect(empty.code).toBe(2);
    expect(empty.last).toMatch(/error（P-2/);
  });

  it('B06 markers 为空 → exit 2 + P-2', () => {
    const r = withRoot({}, { data: { ...fixtureData(), markers: [] } });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/error（P-2/);
  });

  it('B07 samples 缺一词 → exit 2 + P-2', () => {
    const data = fixtureData();
    data.samples = (data.samples as { term: string }[]).filter((s) => s.term !== '良好');
    const r = withRoot({}, { data });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/error（P-2/);
  });

  it('B09 反例改成合格句 → exit 2 + P-3', () => {
    const data = structuredClone(fixtureData()) as { samples: { negative: { input: string } }[] };
    const first = data.samples[0];
    if (first) first.negative.input = '每轮收尾必须写自省结论：附 docs/a.md:12';
    const r = withRoot({}, { data });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/error（P-3/);
  });

  it('B10 反例不含该词 → exit 2 + P-3；P-3 不落盘', () => {
    const data = structuredClone(fixtureData()) as { samples: { negative: { input: string } }[] };
    const first = data.samples[0];
    if (first) first.negative.input = '逐条附 docs/a.md:12';
    const r = withRoot({}, { data });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/error（P-3/);
  });

  it('B12 不存在根 → exit 2；删 skills → exit 2；单文件根 → exit 0', () => {
    expect(invoke(join(tmpdir(), 'scs-obs-does-not-exist-xyz'), false).code).toBe(2);

    const root = mkdtempSync(join(tmpdir(), 'scs-obs-'));
    try {
      mkdirSync(join(root, 'rules'), { recursive: true });
      mkdirSync(join(root, 'skills'), { recursive: true });
      mkdirSync(join(root, 'tools', 'quality'), { recursive: true });
      writeFileSync(join(root, 'tools', 'quality', 'observable-terms.json'), JSON.stringify(fixtureData()));
      writeFileSync(join(root, 'tools', 'quality', 'observable-exempt.json'), JSON.stringify({ entries: [] }));
      rmSync(join(root, 'skills'), { recursive: true, force: true });
      const r2 = invoke(root, false);
      expect(r2.code).toBe(2);
      expect(r2.last).toMatch(/error（P-1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const single = withRoot({ 'rules/only.md': '- 落点 `docs/a.md:12`。\n' }, { bare: true, emptyDirs: ['skills'], json: true });
    expect(single.code).toBe(0);
    expect(single.json?.scanned.length).toBe(1);
  });

  it('B08 samples 双向（verdict + matched 含该词、matched 不去重）', () => {
    const data = fixtureData() as { terms: string[]; markers: { pattern: string }[]; samples: { term: string; positive: { input: string }; negative: { input: string } }[] };
    for (const s of data.samples) {
      const pos = evaluateText(s.positive.input, data);
      expect(pos.verdict, `${s.term} 正例应 pass`).toBe('pass');
      expect(pos.matched.some((m) => m.term === s.term), `${s.term} 正例 matched 必须含该词`).toBe(true);
      const neg = evaluateText(s.negative.input, data);
      expect(neg.verdict, `${s.term} 反例应 fail`).toBe('fail');
      expect(neg.matched.some((m) => m.term === s.term), `${s.term} 反例 matched 必须含该词`).toBe(true);
    }
    const twice = evaluateText(`${data.terms[0]} 与 ${data.terms[0]}`, data);
    expect(twice.matched.filter((m) => m.term === data.terms[0]).length).toBe(2);
  });

  it('B13 正例空转（不含该词）→ exit 2 + P-3', () => {
    const data = structuredClone(fixtureData()) as { samples: { positive: { input: string } }[] };
    const first = data.samples[0];
    if (first) first.positive.input = '逐条附 docs/a.md:12';
    const r = withRoot({}, { data });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/error（P-3/);
  });
});

describe('块边界与标记识别（C 组）', () => {
  it('C01 仅主观词 → exit 1 + hit 行逐字 + 末行计数', () => {
    const r = withRoot({ 'rules/x.md': '本规则要求每轮收尾都要自省结论。\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('rules/x.md:1  term=自省  无结构化可观察标记');
    expect(r.last).toBe('check-observable fail（命中 1 行 / stale 0 条）');
  });

  it('C02 同块带 path:line → exit 0', () => {
    const r = withRoot({ 'rules/x.md': '本规则要求每轮收尾都要自省结论：交付物 `docs/a.md:12` 逐条可追\n' });
    expect(r.code).toBe(0);
    expect(r.last).toBe('check-observable ok');
    expect(r.out).not.toMatch(/term=/);
  });

  it('C03 bullet 续行带 计数 = 3 → exit 0（跨行同块）', () => {
    expect(withRoot({ 'rules/x.md': '- 每轮收尾要写自省结论。\n  计数 = 3 条逐条附依据。\n' }).code).toBe(0);
  });

  it('C04 紧随连续表格属同块 → exit 0', () => {
    expect(withRoot({ 'rules/x.md': '存在自省结论的要求如下：\n| 项 | 值 |\n|---|---|\n| 条数 | ≥ 3 条 |\n' }).code).toBe(0);
  });

  it('C05 跨同级标题不救活 → exit 1（命中 1 行）', () => {
    const r = withRoot({ 'rules/x.md': '- 要写自省结论。\n\n## 另一节\n\n本节的验收 exit=1。\n' });
    expect(r.code).toBe(1);
    expect(r.last).toMatch(/命中 1 行/);
  });

  it('C06 同缩进兄弟 bullet 另起一块 → exit 1', () => {
    expect(withRoot({ 'rules/x.md': '- 要写自省结论。\n- 验收：exit=1。\n' }).code).toBe(1);
  });

  it('C07 缩进子 bullet 属同块 → exit 0', () => {
    expect(withRoot({ 'rules/x.md': '- 要写自省结论。\n    - 验收：exit=1。\n' }).code).toBe(0);
  });

  it('C08 空行截断块 → exit 1', () => {
    expect(withRoot({ 'rules/x.md': '- 要写自省结论。\n\n纯文字续段，无标记。\n' }).code).toBe(1);
  });

  it('C09 裸 = 不算标记 → exit 1 + term=客观', () => {
    const r = withRoot({ 'rules/x.md': '- 检查要客观 = 全部覆盖。\n' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/term=客观/);
  });

  it('C10 出现 / 命令 / 词表 不算标记（三句各 exit 1）', () => {
    const statuses = [
      withRoot({ 'rules/a.md': '- 自省后要检查是否出现遗漏。\n' }).code,
      withRoot({ 'rules/b.md': '- 自省结论按命令输出贴。\n' }).code,
      withRoot({ 'rules/c.md': '- 自省与词表口径一致。\n' }).code,
    ];
    expect(statuses).toEqual([1, 1, 1]);
  });

  it('C11 8 类标记逐类生效（含全角 ≤ / ＝）', () => {
    const files: Record<string, string> = {
      'rules/m0.md': '- 自省后每条都要 ≥ 3 条。\n',
      'rules/m1.md': '- 自省结论附 `docs/a.md:12`。\n',
      'rules/m2.md': '- 自省后核对 exit=1。\n',
      'rules/m3.md': '- 自省后贴 diff 命令。\n',
      'rules/m4.md': '- 自省条目计数 = 3。\n',
      'rules/m5.md': '- 自省后输出为空。\n',
      'rules/m6.md': '- 自省后输出非空。\n',
      'rules/m7.md': '- 自省后枚举：hit/miss。\n',
      'rules/m8.md': '- 自省后每类 ≤ 1 处。\n',
      'rules/m9.md': '- 自省后共 ＝3 类。\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      expect(withRoot({ [rel]: content }).code, `${rel} 应 exit 0`).toBe(0);
    }
    const combined = withRoot(files, { json: true });
    expect(combined.code).toBe(0);
    expect(combined.json?.hits.length).toBe(0);
  });

  it('C13 exit 四形态全绿', () => {
    const codes = [
      withRoot({ 'rules/a.md': '- 自省后核对 exit 0。\n' }).code,
      withRoot({ 'rules/b.md': '- 自省后核对 exit code 0。\n' }).code,
      withRoot({ 'rules/c.md': '- 自省后核对退出码为 0。\n' }).code,
      withRoot({ 'rules/d.md': '- 自省后核对退出状态是 0。\n' }).code,
    ];
    expect(codes).toEqual([0, 0, 0, 0]);
  });

  it('C15 同行两词聚合为 1 条 hit、terms 长度 2', () => {
    const r = withRoot({ 'rules/x.md': '要求自省且客观达标。\n' }, { json: true });
    expect(r.json?.hits.length).toBe(1);
    expect(r.json?.hits[0]?.line).toBe(1);
    expect(r.json?.hits[0]?.terms.length).toBe(2);
    expect(r.json?.hits[0]?.terms.slice().sort()).toEqual(['客观', '自省'].sort());
  });

  it('C16 --json 键序 + 输出顺序（path 字典序 / 行号升序）', () => {
    const r = withRoot(
      {
        'skills/z/m.md': '- 自省结论。\n\n- 自省结论。\n\n- 自省结论。\n',
        'rules/a.md': '- 自省结论。\n\n- 自省结论。\n',
      },
      { json: true },
    );
    expect(Object.keys(r.json ?? {})).toEqual(['scanned', 'hits', 'exemptedLines', 'stale', 'ok']);
    const order = (r.json?.hits ?? []).map((h) => `${h.path}:${h.line}`);
    expect(order).toEqual(['rules/a.md:1', 'rules/a.md:3', 'skills/z/m.md:1', 'skills/z/m.md:3', 'skills/z/m.md:5']);
    expect(r.code).toBe(1);
  });

  it('C17 扫描根只换扫描面（docs/README/.txt/.mjs 不扫）', () => {
    const r = withRoot(
      {
        'docs/tmp/x.md': '- 自省结论。\n',
        'README.md': '- 自省结论。\n',
        'skills/y/a.txt': '- 自省结论。\n',
        'skills/y/a.mjs': '- 自省结论。\n',
        'skills/y/references/z.md': '- 自省结论。\n',
      },
      { json: true },
    );
    expect((r.json?.scanned ?? []).some((p) => p.startsWith('docs/') || p === 'README.md' || p.endsWith('.txt') || p.endsWith('.mjs'))).toBe(false);
    expect(r.json?.hits.length).toBe(1);
    expect(r.json?.hits[0]?.path).toBe('skills/y/references/z.md');
  });

  it('C19 exit 无数字 / 裸枚举：四构造各 exit 1', () => {
    const codes = [
      withRoot({ 'rules/a.md': '- 自省后核对 exit。\n' }).code,
      withRoot({ 'rules/b.md': '- 自省后核对退出码：见上。\n' }).code,
      withRoot({ 'rules/c.md': '- 自省后核对退出码是 通过。\n' }).code,
      withRoot({ 'rules/d.md': '- 自省后按枚举：核对。\n' }).code,
    ];
    expect(codes).toEqual([1, 1, 1, 1]);
  });

  it('C20 更深标题不截断 + 围栏内行不参与', () => {
    expect(withRoot({ 'rules/a.md': '- 要写自省结论。\n#### 细则\n  exit=1。\n' }).code).toBe(0);
    const b = withRoot({ 'rules/b.md': '```\n本规则要求自省。\n```\n\n- 落点 `docs/a.md:12`。\n' }, { json: true });
    expect(b.code).toBe(0);
    expect(b.json?.hits.length).toBe(0);
  });

  it('C22 裸 diff / 「不要求非空」不算标记', () => {
    const codes = [
      withRoot({ 'rules/a.md': '- 自省后顺手 diff 了一下。\n' }).code,
      withRoot({ 'rules/b.md': '- 自省后不要求非空。\n' }).code,
    ];
    expect(codes).toEqual([1, 1]);
  });

  it('C23 标题行不产出 hit', () => {
    const r = withRoot({ 'rules/x.md': '## 自省必须给长期方案\n\n- 落点 `docs/a.md:12`。\n' }, { json: true });
    expect(r.code).toBe(0);
    expect(r.json?.hits.length).toBe(0);
  });

  it('C24 pathline 收紧：docs/a.md:12 绿、20:23 红', () => {
    const codes = [
      withRoot({ 'rules/a.md': '- 自省结论附 docs/a.md:12。\n' }).code,
      withRoot({ 'rules/b.md': '- 自省结论在 20:23 前后。\n' }).code,
    ];
    expect(codes).toEqual([0, 1]);
  });

  it('C25 正文同词必判（标题不扫 ≠ 可逃）', () => {
    const r = withRoot({ 'rules/x.md': '## 自省必须给长期方案\n\n- 自省必须给长期方案。\n' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/term=自省/);
  });
});

describe('豁免清单（D 组）', () => {
  const contains = '本节结论必须自省后落笔（术语引用）。';

  it('D01 正文行豁免生效（exemptedLines 1 / stale 空）', () => {
    const r = withRoot(
      { 'rules/x.md': `${contains}\n` },
      { json: true, exemptEntries: [{ path: 'rules/x.md', contains, reason: '术语引用', reviewed: '2026-10-31' }] },
    );
    expect(r.code).toBe(0);
    expect(r.json?.hits.length).toBe(0);
    expect(r.json?.exemptedLines).toBe(1);
    expect(r.json?.stale).toEqual([]);
  });

  it('D02 缺 reason → exit 2 + P-4 + 无 hit 行', () => {
    const r = withRoot({}, { exemptEntries: [{ path: 'rules/keep.md', contains: '落点', reviewed: '2026-10-31' }] });
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/check-observable error（P-4/);
    expect(r.out).not.toMatch(/term=/);
  });

  it('D03 不存在的 path → stale → exit 1', () => {
    const r = withRoot(
      {},
      { json: true, exemptEntries: [{ path: 'rules/nope.md', contains: 'x', reason: 'r', reviewed: '2026-10-31' }] },
    );
    expect(r.code).toBe(1);
    expect(r.json?.stale.length).toBe(1);
    expect(r.last).toMatch(/stale 1 条/);
  });

  it('D04 contains 0 命中 → stale → exit 1、exemptedLines 0', () => {
    const r = withRoot(
      { 'rules/x.md': `${contains}\n` },
      { json: true, exemptEntries: [{ path: 'rules/x.md', contains: `${contains}（已删）`, reason: 'r', reviewed: '2026-10-31' }] },
    );
    expect(r.code).toBe(1);
    expect(r.json?.exemptedLines).toBe(0);
    expect(r.last).toMatch(/stale 1 条/);
  });

  it('D05 contains 恰 1 处 → exit 0、exemptedLines 1', () => {
    const r = withRoot(
      { 'rules/x.md': `${contains}\n` },
      { json: true, exemptEntries: [{ path: 'rules/x.md', contains, reason: 'r', reviewed: '2026-10-31' }] },
    );
    expect(r.code).toBe(0);
    expect(r.json?.exemptedLines).toBe(1);
  });

  it('D06 contains 2 / 3 处 → exit 2；近似串不误红', () => {
    const mk = (content: string) =>
      withRoot(
        { 'rules/x.md': content },
        { bare: true, emptyDirs: ['skills'], exemptEntries: [{ path: 'rules/x.md', contains, reason: 'r', reviewed: '2026-10-31' }] },
      );
    const r1 = mk(`${contains}\n${contains}\n`);
    const r2 = mk(`${contains}\n${contains}\n${contains}\n`);
    const r3 = mk(`${contains}\n本节结论必须自省后落笔（术语引用）（补）见 \`docs/a.md:12\`\n`);
    expect(r1.code).toBe(2);
    expect(r2.code).toBe(2);
    expect(r1.last).toMatch(/error（P-4/);
    expect(r3.code).toBe(0);
  });

  it('D08 同 path 两条不同 contains → exemptedLines 2', () => {
    const a = '第一条自省术语引用。';
    const b = '第二条自省术语引用。';
    const r = withRoot(
      { 'rules/x.md': `${a}\n${b}\n` },
      {
        json: true,
        exemptEntries: [
          { path: 'rules/x.md', contains: a, reason: 'r1', reviewed: '2026-10-31' },
          { path: 'rules/x.md', contains: b, reason: 'r2', reviewed: '2026-10-31' },
        ],
      },
    );
    expect(r.code).toBe(0);
    expect(r.json?.exemptedLines).toBe(2);
    expect(r.json?.stale).toEqual([]);
  });

  it('D09 同 path 同 contains 两条 → exit 2 + P-4', () => {
    const r = withRoot(
      { 'rules/x.md': '本节结论必须自省后落笔。\n' },
      {
        exemptEntries: [
          { path: 'rules/x.md', contains: '本节结论必须自省后落笔。', reason: 'r1', reviewed: '2026-10-31' },
          { path: 'rules/x.md', contains: '本节结论必须自省后落笔。', reason: 'r2', reviewed: '2026-11-01' },
        ],
      },
    );
    expect(r.code).toBe(2);
    expect(r.last).toMatch(/error（P-4/);
  });

  it('D10 reviewed 可解析 + 下界（2026-10-31 / 2026-01-01 各 exit 0）', () => {
    const mk = (d: string) =>
      withRoot(
        { 'rules/x.md': '本节结论必须自省后落笔。\n' },
        { exemptEntries: [{ path: 'rules/x.md', contains: '本节结论必须自省后落笔。', reason: 'r', reviewed: d }] },
      ).code;
    expect(mk('2026-10-31')).toBe(0);
    expect(mk('2026-01-01')).toBe(0);
  });

  it('D11 早于下界 / 不可解析 / 非日期 → exit 2（P-4）', () => {
    const mk = (d: string) =>
      withRoot({}, { exemptEntries: [{ path: 'rules/keep.md', contains: '落点', reason: 'r', reviewed: d }] }).code;
    expect([mk('2025-12-31'), mk('2026-13-45'), mk('昨天')]).toEqual([2, 2, 2]);
  });

  it('D12 未满 365 天 exit 0', () => {
    const r = withRoot(
      { 'rules/x.md': '本节结论必须自省后落笔。\n' },
      { exemptEntries: [{ path: 'rules/x.md', contains: '本节结论必须自省后落笔。', reason: 'r', reviewed: '2026-01-05' }] },
    );
    expect(r.code).toBe(0);
  });

  it('D13 行级粒度：只摘命中行，不整文件放行', () => {
    const a = '第一行自省结论。';
    const b = '第二行自省结论。';
    const r = withRoot(
      { 'rules/x.md': `${a}\n\n${b}\n` },
      { json: true, exemptEntries: [{ path: 'rules/x.md', contains: a, reason: 'r', reviewed: '2026-10-31' }] },
    );
    expect(r.code).toBe(1);
    expect(r.json?.hits.length).toBe(1);
    expect(r.json?.exemptedLines).toBe(1);
  });
});
