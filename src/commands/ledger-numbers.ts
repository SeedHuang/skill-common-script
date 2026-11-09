import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface NumberIssue {
  file: string;
  line: number;
  msg: string;
}

export interface LedgerNumbersResult {
  fails: NumberIssue[];
  warns: string[];
  stats: {
    actual: { total: number; P0: number; P1: number; P2: number } | null;
    rounds: number;
    files?: string[];
    skipped?: boolean;
  };
}

/** 0 = 无 FAIL；1 = 有 FAIL；2 = 用法/读取错误 */
export type LedgerNumbersCode = 0 | 1 | 2;

export interface LedgerNumbersRun {
  code: LedgerNumbersCode;
  out: string[];
  err: string[];
  result?: LedgerNumbersResult;
}

// ── 判据用的正则（集中在此，便于核对）────────────────────────────────────
// C1：数字 + 单位 + 括号里的三级分布。允许 `**加粗**`、`（卡级 …）` 这类书写变体。
const RE_ARITH =
  /(\d+)\s*\*{0,2}\s*(?:个问题|张|条|处)\*{0,2}\s*[（(]\s*(?:\*{0,2}卡级\*{0,2}\s*)?P0\s*(\d+)\s*\/\s*P1\s*(\d+)\s*\/\s*P2\s*(\d+)/g;
// C2 新声明形态：模板写的是「卡片数 53（P0 9 / P1 22 / P2 22）」，原 RE_ARITH 只认「卡级 + 张」读不到。
const RE_CARD_COUNT = /卡片数\s*(\d+)\s*[（(]\s*P0\s*(\d+)\s*\/\s*P1\s*(\d+)\s*\/\s*P2\s*(\d+)\s*[）)]/;
// C5 终态对账：第 3 项证据栏的机读计数
const RE_C5 = /已修=(\d+)\s+关闭=(\d+)\s+候选=(\d+)\s+升级=(\d+)\s+带往下轮=(\d+)/;
// 卡片标题：`#### BE-1-01 【P0】…`；序号允许 1–3 位
const RE_CARD = /^####\s+[A-Z]{2}-\d-\d{1,3}\b/;
const RE_CARD_LEVEL = /^####\s+[A-Z]{2}-\d-\d{1,3}\s*【(P0|P1|P2)】/;
// C3：族汇总行 `- **P1 族 15 个**：F3 …；F17 …`
const RE_FAMILY = /\*\*P([012])\s*族\s*(\d+)\s*个[^*]*\*\*/g;
const RE_F_TOKEN = /\bF\d+\b/g;
// 候选段（不计入该级族数）
const RE_CANDIDATE = /\*\*候选[^*]*\*\*/g;
const RE_CANDIDATE_PLAIN = /候选\s*F\d+/g;
// C4：副本禁令
const RE_COPY: { re: RegExp; hint: string }[] = [
  {
    re: /共\s*\*{0,2}\d+\s*(?:张|个问题|处)/,
    hint: '本行疑似该轮总量副本（该轮总量只允许写在顶部轮次账）；若只是普通叙述，请改写措辞避免「共 N 张/个问题/处」',
  },
  { re: /\d+\s*张（(?:卡级\s*)?P0/, hint: '这一行的分布是轮次账的副本，删掉' },
  { re: /归并\*\*：P0\s*\d+/, hint: '「归并」行的分布数字是轮次账的副本，删掉' },
];
const RE_ROUND_HEAD = /^##\s*第\s*(\d+)\s*轮/;

/**
 * 核对一个评审目录下的三件套（progress.md 必需，problems.md / cards.md 可选）。
 * 不做语义判断：只查算术自洽、与 cards.md 实数、族号计数、副本禁令。
 */
export function checkLedgerNumbers(dir: string): LedgerNumbersResult {
  const fails: NumberIssue[] = [];
  const warns: string[] = [];
  const files: Record<string, string> = {};

  for (const name of ['progress.md', 'problems.md', 'cards.md']) {
    const p = join(dir, name);
    if (existsSync(p)) files[name] = readFileSync(p, 'utf8');
    else warns.push(`缺 ${name}（依赖它的检查已跳过）`);
  }

  // progress.md 是唯一必需件：缺它 = 没有可核对的轮次账，按 FAIL 报（不是静默通过）
  if (!files['progress.md']) {
    fails.push({
      file: 'progress.md',
      line: 0,
      msg: '缺 progress.md：没有轮次账就没有可核对的对象（CLI 会以 exit 2 拒绝，避免「没检查 = 通过」）',
    });
    return { fails, warns, stats: { skipped: true, rounds: 0, actual: null } };
  }

  const lines: Record<string, string[]> = {};
  for (const [name, text] of Object.entries(files)) lines[name] = text.split(/\r?\n/);

  // ── C2 真实值：数 cards.md 里的卡片标题，不信任任何手写声明 ──
  let actual: { total: number; P0: number; P1: number; P2: number } | null = null;
  if (files['cards.md']) {
    const real = { total: 0, P0: 0, P1: 0, P2: 0 };
    let unleveled = 0;
    for (const l of lines['cards.md'] ?? []) {
      if (!RE_CARD.test(l)) continue;
      real.total += 1;
      const m = l.match(RE_CARD_LEVEL);
      if (m && (m[1] === 'P0' || m[1] === 'P1' || m[1] === 'P2')) real[m[1]] += 1;
      else unleveled += 1;
    }
    if (real.total === 0) {
      warns.push('cards.md 里没有可识别的卡片标题（`#### XX-1-01 【P0】`）→ C2 已跳过');
    } else if (unleveled > 0) {
      warns.push(`cards.md 有 ${unleveled}/${real.total} 张卡标题缺【P0/P1/P2】标记 → C2 已跳过（否则会假红）`);
    } else {
      actual = real;
    }
  }

  // ── C1 算术自检（全文件）──
  for (const name of Object.keys(files)) {
    (lines[name] ?? []).forEach((l, i) => {
      for (const m of l.matchAll(RE_ARITH)) {
        const [all, total, p0, p1, p2] = m;
        const sum = Number(p0) + Number(p1) + Number(p2);
        if (sum !== Number(total)) {
          fails.push({
            file: name,
            line: i + 1,
            msg: `C1 算术不自洽：「${all}」→ ${p0}+${p1}+${p2}=${sum}，但写的是 ${total}`,
          });
        }
      }
    });
  }

  // ── C2 实数校准（两种声明形态：旧「N 张（卡级 …）」与新「卡片数 N（…）」；同一行只取第一个命中，不双计）──
  if (actual) {
    const real = actual;
    const checkDecl = (name: string, line: number, decl: string, total: string, p0: string, p1: string, p2: string) => {
      const bad: string[] = [];
      if (Number(p0) !== real.P0) bad.push(`P0 写 ${p0}，实为 ${real.P0}`);
      if (Number(p1) !== real.P1) bad.push(`P1 写 ${p1}，实为 ${real.P1}`);
      if (Number(p2) !== real.P2) bad.push(`P2 写 ${p2}，实为 ${real.P2}`);
      if (Number(total) !== real.total) bad.push(`总数写 ${total}，实为 ${real.total}`);
      if (bad.length) {
        fails.push({ file: name, line, msg: `C2 与 cards.md 实际计数不符：「${decl}」→ ${bad.join('；')}` });
      }
    };
    for (const name of Object.keys(files)) {
      (lines[name] ?? []).forEach((l, i) => {
        let used = false;
        for (const m of l.matchAll(RE_ARITH)) {
          const [all, total, p0, p1, p2] = m;
          if (!/卡级/.test(all ?? '') || !/张/.test(all ?? '')) continue;
          used = true;
          checkDecl(name, i + 1, all ?? '', total ?? '0', p0 ?? '0', p1 ?? '0', p2 ?? '0');
          break;
        }
        if (used) return;
        const m = l.match(RE_CARD_COUNT);
        if (m) checkDecl(name, i + 1, m[0], m[1] ?? '0', m[2] ?? '0', m[3] ?? '0', m[4] ?? '0');
      });
    }
  }

  // ── C3 族号计数（只数「本标题之后、下一个标题之前」的片段）──
  for (const name of Object.keys(files)) {
    (lines[name] ?? []).forEach((l, i) => {
      const fams = [...l.matchAll(RE_FAMILY)];
      for (let k = 0; k < fams.length; k += 1) {
        const m = fams[k];
        if (!m) continue;
        const segStart = (m.index ?? 0) + m[0].length;
        const next = fams[k + 1];
        const segEnd = next ? (next.index ?? l.length) : l.length;
        const seg = l
          .slice(segStart, segEnd)
          .replace(RE_CANDIDATE, '')
          .replace(RE_CANDIDATE_PLAIN, '')
          .replace(/[（(][^）)]*[）)]/g, '');
        const declared = Number(m[2]);
        const ids = new Set(seg.match(RE_F_TOKEN) ?? []);
        if (ids.size !== declared) {
          fails.push({
            file: name,
            line: i + 1,
            msg: `C3 族号数不符：「**P${m[1]} 族 ${declared} 个**」但该标题之后列出了 ${ids.size} 个不同 F 编号（候选段已剔除）`,
          });
        }
      }
    });
  }

  // ── C4 副本禁令（progress.md 的每个「## 第 N 轮」小节内）──
  const heads: { round: string; line: number }[] = [];
  const progressLines = lines['progress.md'] ?? [];
  progressLines.forEach((l, i) => {
    const m = l.match(RE_ROUND_HEAD);
    if (m) heads.push({ round: m[1] ?? '', line: i });
  });
  for (const head of heads) {
    // 小节范围 = 本标题行到下一个 `## ` 标题（`###` 子节不终止）
    let end = progressLines.length;
    for (let j = head.line + 1; j < progressLines.length; j += 1) {
      if (/^##\s+/.test(progressLines[j] ?? '')) {
        end = j;
        break;
      }
    }
    for (let j = head.line + 1; j < end; j += 1) {
      const l = progressLines[j] ?? '';
      for (const { re, hint } of RE_COPY) {
        if (re.test(l)) {
          fails.push({ file: 'progress.md', line: j + 1, msg: `C4 副本禁令（第 ${head.round} 轮小节）：${hint}` });
          break; // 同一行只报一次
        }
      }
    }
  }

  // ── C5 终态对账（缺行只 WARN：旧账本没有该行，判红会造成历史账本批量假红）──
  const c5 = checkTerminalReconcile(dir);
  if (c5.warn) warns.push(c5.warn);
  if (c5.fail) fails.push({ file: 'round-check.md', line: 0, msg: c5.fail });

  return { fails, warns, stats: { actual, rounds: heads.length, files: Object.keys(files) } };
}

/**
 * C5：`round-check.md` 第 3 项证据栏的机读计数求和 vs `cards.md` 卡片数。
 * 缺行 / 缺文件只 WARN（历史账本兼容）；有行且不等才 FAIL。
 */
export function checkTerminalReconcile(dir: string): { fail?: string; warn?: string } {
  const rc = join(dir, 'round-check.md');
  if (!existsSync(rc)) return { warn: 'C5 未取数（无第 3 项行）' };
  const line = readFileSync(rc, 'utf8').split(/\r?\n/).find((l) => l.includes('第 3 项'));
  const m = line?.match(RE_C5);
  if (!m) return { warn: 'C5 未取数（无第 3 项行）' };
  const cards = join(dir, 'cards.md');
  if (!existsSync(cards)) return { warn: '缺 cards.md（C5 已跳过）' };
  const count = readFileSync(cards, 'utf8').split(/\r?\n/).filter((l) => RE_CARD.test(l)).length;
  const sum = m.slice(1, 6).reduce((n, x) => n + Number(x), 0);
  return sum === count ? {} : { fail: `C5 终态对账不符：求和 ${sum} ≠ 卡片数 ${count}` };
}

/** 读目录后核对并给出 CLI 输出。缺 progress.md = 用法错误（exit 2），不是「检查通过」。 */
export function runLedgerNumbers(dir: string | undefined): LedgerNumbersRun {
  if (!dir) {
    return { code: 2, out: [], err: ['用法：scs ledger numbers <review 目录>'] };
  }
  if (!existsSync(dir)) {
    return { code: 2, out: [], err: [`目录不存在：${dir}`] };
  }
  if (!existsSync(join(dir, 'progress.md'))) {
    return { code: 2, out: [], err: [`不是评审账本目录（缺 progress.md）：${dir}`] };
  }

  const result = checkLedgerNumbers(dir);
  const out = [...result.warns.map((w) => `[WARN] ${w}`), ...result.fails.map((f) => `[FAIL] ${f.file}:${f.line} ${f.msg}`)];
  if (result.fails.length === 0) {
    const a = result.stats.actual;
    const tail = a ? `；cards.md 实际 ${a.total} 张（P0 ${a.P0} / P1 ${a.P1} / P2 ${a.P2}）` : '';
    out.push(`账本数字：0 处不一致（${result.stats.rounds} 个轮次小节${tail}）`);
  }
  return { code: result.fails.length > 0 ? 1 : 0, out, err: [], result };
}
