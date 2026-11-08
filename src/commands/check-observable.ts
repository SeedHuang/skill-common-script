import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fenceMask } from '../lib/markdown.js';

// ── 类型 ──────────────────────────────────────────────────────────────────
export interface ObservableTermData {
  terms: string[];
  criterionTerms: string[];
  markers: { kind: string; pattern: string }[];
  samples: { term: string; positive?: { input?: string }; negative?: { input?: string } }[];
  sharedPhrases?: string[];
}

export interface ExemptEntry {
  path: string;
  contains: string;
  reason: string;
  reviewed: string;
}

export interface ObservableHit {
  path: string;
  line: number;
  terms: string[];
}

export interface ObservableReport {
  scanned: string[];
  hits: ObservableHit[];
  exemptedLines: number;
  stale: { path: string; contains: string }[];
  ok: boolean;
  copyProblems?: string[];
}

export class ObservableFail extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ObservableOptions {
  root: string;
  /** 是否把 root 当作「扫描仓根」（未显式指定 --root 时为 true，强制 skills/ ≥1 个 md） */
  strictRoot: boolean;
  termsFile: string;
  exemptFile: string;
}

const RULE_DOC_REL = 'rules/observable-criteria.md';
const REVIEWED_FLOOR = '2026-01-01';

// ── 文本工具 ──────────────────────────────────────────────────────────────
const isBlank = (l: string): boolean => l.trim() === '';
const isTable = (l: string): boolean => l.trim().startsWith('|');
const headingLevel = (l: string): number => {
  const m = /^(#{1,6})\s/.exec(l);
  return m && m[1] ? m[1].length : 0;
};
const isTitle = (l: string): boolean => /^#{1,6}\s/.test(l);
const bulletIndent = (l: string): number | null => {
  const m = /^( *)(?:[-*+]|\d+\.)\s/.exec(l);
  return m && m[1] !== undefined ? m[1].length : null;
};

function sectionLevelAt(lines: string[], i: number): number {
  for (let j = i - 1; j >= 0; j -= 1) {
    const h = headingLevel(lines[j] ?? '');
    if (h) return h;
  }
  return 0;
}

/**
 * 最小语义块：bullet = 该 bullet 续行 + 缩进子块；段落 = 连续非空行；另加紧随的连续表格。
 * 终止：① 空行 ② 同级或更高级标题 ③ 同缩进级别下一条 bullet ④ 表格结束后的下一个非表格行。
 */
function blockOf(lines: string[], mask: boolean[], i: number): [number, number] {
  const secLevel = sectionLevelAt(lines, i);
  const stopsAt = (l: string): boolean => {
    const h = headingLevel(l);
    return Boolean(h && h <= secLevel);
  };
  if (isTable(lines[i] ?? '')) {
    let s = i;
    while (s - 1 >= 0 && isTable(lines[s - 1] ?? '')) s -= 1;
    let e = i;
    while (e + 1 < lines.length && isTable(lines[e + 1] ?? '')) e += 1;
    return [s, e];
  }
  const indent = bulletIndent(lines[i] ?? '');
  let s = i;
  if (indent === null) {
    while (s - 1 >= 0) {
      const l = lines[s - 1] ?? '';
      if (isBlank(l) || isTable(l) || isTitle(l) || bulletIndent(l) !== null) break;
      s -= 1;
    }
  }
  let e = i;
  let j = i + 1;
  while (j < lines.length) {
    if (mask[j]) {
      j += 1;
      continue;
    }
    const l = lines[j] ?? '';
    if (isBlank(l)) break;
    if (stopsAt(l)) break;
    if (indent === null) {
      if (isTitle(l) || bulletIndent(l) !== null) break;
      if (isTable(l)) {
        while (j < lines.length && isTable(lines[j] ?? '')) {
          e = j;
          j += 1;
        }
        break;
      }
      e = j;
      j += 1;
      continue;
    }
    const bi = bulletIndent(l);
    if (bi !== null && bi <= indent) break;
    if (isTable(l)) {
      while (j < lines.length && isTable(lines[j] ?? '')) {
        e = j;
        j += 1;
      }
      break;
    }
    e = j;
    j += 1;
  }
  if (isTitle(lines[i] ?? '')) return [i, i];
  return [s, e];
}

function blockHasMarker(lines: string[], mask: boolean[], i: number, compiled: RegExp[]): boolean {
  const [s, e] = blockOf(lines, mask, i);
  for (let j = s; j <= e; j += 1) {
    if (mask[j]) continue;
    for (const re of compiled) if (re.test(lines[j] ?? '')) return true;
  }
  return false;
}

/**
 * 判定唯一实现点：返回 verdict 与命中词（matched 不去重，每次出现一条）。
 * 口径：命中主观词，且所在最小语义块内没有任何可观察标记 → fail。
 */
export function evaluateText(
  text: string,
  data: { terms: string[]; markers: { pattern: string }[] },
): { verdict: 'pass' | 'fail'; matched: { term: string; index: number }[] } {
  const lines = String(text).split(/\r?\n/);
  const { mask } = fenceMask(lines);
  const compiled = data.markers.map((m) => new RegExp(m.pattern));
  const matched: { term: string; index: number }[] = [];
  const hitLines: number[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const base = offset;
    offset += line.length + 1;
    if (mask[i]) continue;
    if (isTitle(line)) continue;
    let any = false;
    for (const t of data.terms) {
      let from = 0;
      for (;;) {
        const at = line.indexOf(t, from);
        if (at < 0) break;
        matched.push({ term: t, index: base + at });
        any = true;
        from = at + t.length;
      }
    }
    if (any) hitLines.push(i);
  }
  const bad = hitLines.filter((i) => !blockHasMarker(lines, mask, i, compiled));
  return { verdict: bad.length === 0 ? 'pass' : 'fail', matched };
}

// ── 规则文档专判（不复制词表）─────────────────────────────────────────────
const sepOnly = (s: string): boolean => /^[、，,\/ 　]*$/.test(s);

function ruleDocCopies(text: string, data: { terms: string[]; markers: { kind: string; pattern: string }[] }): string[] {
  const problems: string[] = [];
  const lines = String(text).split(/\r?\n/);
  for (const m of data.markers) {
    const src = String(m.pattern);
    if (src.length >= 8 && text.includes(src)) problems.push(`markers(${m.kind}) 的正则原文出现在规则文档里`);
  }
  for (const line of lines) {
    let idx = -1;
    let run = 0;
    const hits: { at: number; len: number }[] = [];
    for (const t of data.terms) {
      let from = 0;
      for (;;) {
        const at = line.indexOf(t, from);
        if (at < 0) break;
        hits.push({ at, len: t.length });
        from = at + t.length;
      }
    }
    hits.sort((a, b) => a.at - b.at);
    for (const h of hits) {
      if (run === 0 || h.at === idx) run += 1;
      else if (sepOnly(line.slice(idx, h.at))) run += 1;
      else run = 1;
      idx = h.at + h.len;
      if (run >= 2) {
        problems.push(`同行连续枚举 ≥2 个主观词：${line.trim().slice(0, 40)}`);
        break;
      }
    }
  }
  return problems;
}

// ── 扫描面（两次独立遍历）────────────────────────────────────────────────
function walkCollect(dir: string, out: string[]): string[] {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkCollect(p, out);
    else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

function walkCount(dir: string): number {
  let n = 0;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) n += walkCount(p);
    else if (e.name.toLowerCase().endsWith('.md')) n += 1;
  }
  return n;
}

const relPath = (root: string, abs: string): string =>
  abs.slice(root.length).replace(/^[\\/]+/, '').split('\\').join('/');

// ── 数据装载与前置断言 ────────────────────────────────────────────────────
function loadJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new ObservableFail('P-2', `${file}: ${err.code ?? err.message}`);
  }
}

function assertData(data: ObservableTermData): void {
  if (!Array.isArray(data.terms) || data.terms.length === 0) throw new ObservableFail('P-2', 'terms 为空');
  if (!Array.isArray(data.criterionTerms) || data.criterionTerms.length === 0) throw new ObservableFail('P-2', 'criterionTerms 为空');
  if (!Array.isArray(data.markers) || data.markers.length === 0) throw new ObservableFail('P-2', 'markers 为空');
  if (!Array.isArray(data.samples)) throw new ObservableFail('P-2', 'samples 缺失');
  const covered = new Set(data.samples.map((s) => s.term));
  for (const t of data.terms) if (!covered.has(t)) throw new ObservableFail('P-2', `samples 未覆盖词「${t}」`);
}

function assertSamples(data: ObservableTermData): void {
  for (const s of data.samples) {
    const pos = evaluateText(s.positive?.input ?? '', data);
    const neg = evaluateText(s.negative?.input ?? '', data);
    const posOk = pos.verdict === 'pass' && pos.matched.some((m) => m.term === s.term);
    const negOk = neg.verdict === 'fail' && neg.matched.some((m) => m.term === s.term);
    if (!posOk) throw new ObservableFail('P-3', `词「${s.term}」的正例不成立（期望 pass 且 matched 含该词）`);
    if (!negOk) throw new ObservableFail('P-3', `词「${s.term}」的反例不成立（期望 fail 且 matched 含该词）`);
  }
}

function loadExempt(file: string): ExemptEntry[] {
  const raw = loadJson(file) as { entries?: ExemptEntry[] };
  const entries = Array.isArray(raw.entries) ? raw.entries : null;
  if (!entries) throw new ObservableFail('P-4', 'entries 缺失');
  const seen = new Map<string, Set<string>>();
  entries.forEach((e, i) => {
    for (const k of ['path', 'contains', 'reason', 'reviewed'] as const) {
      if (typeof e?.[k] !== 'string' || e[k].trim() === '') throw new ObservableFail('P-4', `第 ${i + 1} 条缺字段 ${k}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewed) || Number.isNaN(new Date(e.reviewed).getTime())) {
      throw new ObservableFail('P-4', `第 ${i + 1} 条 reviewed 不可解析：${e.reviewed}`);
    }
    if (e.reviewed < REVIEWED_FLOOR) throw new ObservableFail('P-4', `第 ${i + 1} 条 reviewed 早于 ${REVIEWED_FLOOR}`);
    if (!seen.has(e.path)) seen.set(e.path, new Set());
    const set = seen.get(e.path);
    if (set?.has(e.contains)) throw new ObservableFail('P-4', `${e.path} 内 contains 重复`);
    set?.add(e.contains);
  });
  return entries;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
export function runObservable(opts: ObservableOptions): { report: ObservableReport } {
  const { root } = opts;
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new ObservableFail('P-1', `扫描根不存在或不是目录：${root}`);
  const rulesDir = join(root, 'rules');
  const skillsDir = join(root, 'skills');
  const files = [...walkCollect(rulesDir, []), ...walkCollect(skillsDir, [])];
  const counted = walkCount(rulesDir) + walkCount(skillsDir);
  if (files.length !== counted) throw new ObservableFail('P-1', `两次遍历数不等（收集 ${files.length} / 计数 ${counted}）`);
  const nSkills = walkCollect(skillsDir, []).length;
  if (!existsSync(rulesDir) || !existsSync(skillsDir)) {
    throw new ObservableFail('P-1', `rules/ 与 skills/ 目录必须都在（实得 ${existsSync(rulesDir)} / ${existsSync(skillsDir)}）`);
  }
  if (files.length === 0) throw new ObservableFail('P-1', '扫描根下 0 个 .md（空转）');
  if (opts.strictRoot && nSkills < 1) throw new ObservableFail('P-1', `仓根下 skills/ 须 ≥1 个 .md（实得 ${nSkills}）`);

  const data = loadJson(opts.termsFile) as ObservableTermData;
  assertData(data);
  assertSamples(data);

  const entries = loadExempt(opts.exemptFile);

  const resolveEntry = (rel: string): string | null => {
    const inRoot = join(root, rel);
    if (existsSync(inRoot) && !statSync(inRoot).isDirectory()) return inRoot;
    return null;
  };
  const hits: ObservableHit[] = [];
  let exemptedLines = 0;
  const stale: { path: string; contains: string }[] = [];
  const fileCache = new Map<string, string>();
  for (const e of entries) {
    const abs = resolveEntry(e.path);
    if (!abs) {
      stale.push({ path: e.path, contains: e.contains });
      continue;
    }
    let text = fileCache.get(abs);
    if (text === undefined) {
      text = readFileSync(abs, 'utf8');
      fileCache.set(abs, text);
    }
    const n = text.split(e.contains).length - 1;
    if (n === 0) {
      stale.push({ path: e.path, contains: e.contains });
      continue;
    }
    if (n > 1) throw new ObservableFail('P-4', `${e.path} 的 contains 出现 ${n} 次（锚点不唯一）`);
  }

  const sorted = files
    .map((abs) => ({ abs, rel: relPath(root, abs) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const scanned = sorted.map((s) => s.rel);

  for (const { abs, rel } of sorted) {
    // 规则文档另走判定 5，不参与判定 1–4
    if (rel === RULE_DOC_REL) continue;
    let text = fileCache.get(abs);
    if (text === undefined) {
      text = readFileSync(abs, 'utf8');
      fileCache.set(abs, text);
    }
    const lines = text.split(/\r?\n/);
    const { mask } = fenceMask(lines);
    const compiled = data.markers.map((m) => new RegExp(m.pattern));
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (mask[i]) continue;
      if (isTitle(line)) continue;
      const ts = data.terms.filter((t) => line.includes(t));
      if (ts.length === 0) continue;
      if (blockHasMarker(lines, mask, i, compiled)) continue;
      const ex = entries.find((e) => e.path === rel && line.includes(e.contains));
      if (ex) {
        exemptedLines += 1;
        continue;
      }
      hits.push({ path: rel, line: i + 1, terms: ts });
    }
  }

  const ruleDoc = sorted.find((s) => s.rel === RULE_DOC_REL);
  const copyProblems = ruleDoc ? ruleDocCopies(readFileSync(ruleDoc.abs, 'utf8'), data) : [];

  const ok = hits.length === 0 && stale.length === 0 && copyProblems.length === 0;
  const report: ObservableReport =
    copyProblems.length === 0 ? { scanned, hits, exemptedLines, stale, ok } : { scanned, hits, exemptedLines, stale, ok, copyProblems };
  return { report };
}
