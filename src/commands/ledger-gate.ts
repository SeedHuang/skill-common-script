import { readFileSync } from 'node:fs';

/** 0 = 全过；1 = 有硬伤（留空 / 只填一端 / 格式非法）；2 = 用法或读取错误 */
export type LedgerGateCode = 0 | 1 | 2;

export interface LedgerGateResult {
  code: LedgerGateCode;
  /** 正常输出（[WARN] / [FAIL] / 汇总行） */
  out: string[];
  /** 用法或读取错误 */
  err: string[];
}

const NOT_TAKEN = '未取数';

/** 剥掉 markdown 加粗与中/英文括号注释，取纯文本（历史账本的合理变体，剥离后判端） */
const stripDeco = (s: string): string => s.replace(/\*\*/g, '').replace(/[（(].*?[）)]/g, '').trim();

interface DataRow {
  row: string;
  startStop: string;
  cost: string;
}

/**
 * 核对 progress.md 文本里的轮次账表。
 * 判据（硬判 FAIL）：每行「起止」「耗时」两列必须填——
 *   合法值 = HH:MM~HH:MM / HH:MM:SS~HH:MM:SS、N m，或显式「未取数」；
 *   整格留空、只填一端、非法格式 = FAIL。
 * 软判 WARN：出现「未取数」、带装饰/注释、轮次账行数 ≠ 「## 第 N 轮」小节数。
 */
export function evaluateLedgerText(target: string, text: string): LedgerGateResult {
  const lines = text.split(/\r?\n/);

  // 找轮次账表：表头行含「轮」与「起止」
  const headerIdx = lines.findIndex((l) => /^\|\s*轮\s*\|/.test(l) && l.includes('起止'));
  if (headerIdx === -1) {
    return { code: 2, out: [], err: [`未找到轮次账表（表头应为「| 轮 | 起止…」）：${target}`] };
  }

  // 按表头列名动态定位列位，不硬编码（模板加列/调序不静默错位）
  const headerCells = (lines[headerIdx] ?? '').split('|').map((s) => s.trim());
  const colStartStop = headerCells.findIndex((c) => c.includes('起止'));
  const colCost = headerCells.findIndex((c) => c.includes('耗时'));
  if (colStartStop === -1 || colCost === -1) {
    return { code: 2, out: [], err: [`轮次账表头缺「起止」或「耗时」列：${target}`] };
  }

  const dataRows: DataRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (/^\|[\s:|-]+\|$/.test(l)) continue; // 分隔行（|---|）跳过
    if (!/^\|\s*\d+\s*\|/.test(l)) break; // 非数据行 → 表结束
    const cells = l.split('|').map((s) => s.trim());
    dataRows.push({
      row: cells[1] || '(空)',
      startStop: cells[colStartStop] ?? '',
      cost: cells[colCost] ?? '',
    });
  }

  if (dataRows.length === 0) {
    return { code: 2, out: [], err: [`轮次账表下无数据行：${target}`] };
  }

  const fails: string[] = [];
  const warns: string[] = [];

  for (const r of dataRows) {
    const ss = r.startStop;
    const cost = r.cost;

    // ── 起止列 ──
    if (ss === '') {
      fails.push(`第 ${r.row} 轮：起止列留空（必须填 HH:MM:SS~HH:MM:SS 或显式「未取数」）`);
    } else if (ss === NOT_TAKEN) {
      warns.push(`第 ${r.row} 轮：起止整格标「未取数」（诚实记录合法，但不该成为常态——每轮起/止应各跑一次 scs time）`);
    } else if (/\d{1,2}:\d{2}(?::\d{2})?/.test(stripDeco(ss))) {
      const stripped = stripDeco(ss);
      if (!stripped.includes('~')) {
        fails.push(`第 ${r.row} 轮：起止缺「~」分隔「${ss}」（起~止必须成对，如 12:39~12:50；缺的那端标「未取数」）`);
      } else {
        const oneSideBlank = /~$/.test(stripped) || /^~/.test(stripped);
        const sides = stripped.split('~').map((s) => s.trim());
        const sidesOk =
          sides.length === 2 && sides.every((s) => s === NOT_TAKEN || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(s));
        if (oneSideBlank) {
          fails.push(`第 ${r.row} 轮：起止只填了一端「${ss}」（起/止必须成对，缺的那端标「未取数」）`);
        } else if (!sidesOk) {
          fails.push(`第 ${r.row} 轮：起止一端格式非法「${ss}」（~ 两端应为时间或「未取数」）`);
        } else if (ss.includes(NOT_TAKEN)) {
          warns.push(`第 ${r.row} 轮：起止一端标「未取数」（另一端起/止已实测；未取数端不应成为常态）`);
        } else if (stripDeco(ss) !== ss) {
          warns.push(`第 ${r.row} 轮：起止端带装饰/注释「${ss}」（时间主体在，仅提示格式）`);
        }
      }
    } else {
      const parts = ss.split('~').map((s) => s.trim());
      if (parts.length >= 1 && parts.every((p) => p === NOT_TAKEN)) {
        warns.push(`第 ${r.row} 轮：起止两端都标「未取数」（等同整格未取数；规范写法为整格「未取数」）`);
      } else {
        const bothEndsPresent = parts.length >= 2 && parts.every((p) => p !== '');
        if (bothEndsPresent) {
          fails.push(`第 ${r.row} 轮：起止格式非法「${ss}」（应为 HH:MM:SS~HH:MM:SS 或显式「未取数」）`);
        } else {
          fails.push(`第 ${r.row} 轮：起止只填了一端「${ss}」（起/止必须成对，缺的那端标「未取数」）`);
        }
      }
    }

    // ── 耗时列 ──
    if (cost === '') {
      fails.push(`第 ${r.row} 轮：耗时列留空（必须填 N m 或显式「未取数」）`);
    } else if (cost === NOT_TAKEN) {
      warns.push(`第 ${r.row} 轮：耗时标「未取数」（诚实记录合法，但不该成为常态）`);
    } else if (/\d+m/.test(stripDeco(cost))) {
      if (stripDeco(cost) !== cost) warns.push(`第 ${r.row} 轮：耗时带装饰/注释「${cost}」（数字 m 在，仅提示格式）`);
    } else {
      warns.push(`第 ${r.row} 轮：耗时无 N m 但有说明「${cost}」（按未取数理解；规范写法应为 N m 或显式「未取数」）`);
    }
  }

  // 软判：轮次账行数 vs 轮次小节数（小节标题允许带括号说明）
  const sections = lines.filter((l) => /^##\s*第\s*\d+\s*轮(?:\s*[（(][^\n]*[）)])?\s*$/.test(l)).length;
  if (sections > 0 && sections !== dataRows.length) {
    warns.push(`轮次账 ${dataRows.length} 行 vs 「## 第 N 轮」小节 ${sections} 个不一致——可能有轮次没写独立小节`);
  }

  const out = [...warns.map((w) => `[WARN] ${w}`), ...fails.map((f) => `[FAIL] ${f}`)];
  if (fails.length === 0) out.push(`轮次账完整性：${dataRows.length} 行全过（${warns.length} 条软提示）`);
  return { code: fails.length > 0 ? 1 : 0, out, err: [] };
}

/** 读文件后核对；路径缺失或读不到 = 用法/读取错误（exit 2） */
export function runLedgerGate(progressPath: string | undefined): LedgerGateResult {
  if (!progressPath) {
    return { code: 2, out: [], err: ['用法：scs ledger gate <progress.md 路径>'] };
  }
  let text: string;
  try {
    text = readFileSync(progressPath, 'utf8');
  } catch (e) {
    return { code: 2, out: [], err: [`读取 ${progressPath} 失败：${(e as Error).message}`] };
  }
  return evaluateLedgerText(progressPath, text);
}
