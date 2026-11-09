import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLandings } from './check-landings.js';

/** 造一个临时目录（root 侧带 docs/）；用完即删 */
function mk(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scs-land-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t, 'utf8');
  return dir;
}

const dirs: string[] = [];
const make = (files: Record<string, string>): string => {
  const d = mk(files);
  dirs.push(d);
  return d;
};

describe('check landings', () => {
  it('存在且行号够 → exit 0，首行计数 + 次行 ok', () => {
    const root = make({ 'docs/a.md': 'l1\nl2\n' });
    const ledger = make({ 'round-check.md': '| 证据 | `docs/a.md:2` |\n' });
    const r = checkLandings({ root, ledger });
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^landings: missing 0（files 1 \/ refs 1）$/);
    expect(r.out[1]).toBe('landings ok');
  });

  it('文件不存在 → exit 1', () => {
    const root = make({});
    const ledger = make({ 'round-check.md': '| 证据 | `docs/nope.md:1` |\n' });
    const r = checkLandings({ root, ledger });
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toContain('docs/nope.md:1');
  });

  it('行号越界 → exit 1', () => {
    const root = make({ 'docs/a.md': 'l1\n' });
    const ledger = make({ 'round-check.md': '| 证据 | `docs/a.md:2` |\n' });
    expect(checkLandings({ root, ledger }).code).toBe(1);
  });

  it('URL 跳过', () => {
    const root = make({});
    const ledger = make({ 'round-check.md': '| 证据 | https://x.com/a.md:1 |\n' });
    const r = checkLandings({ root, ledger });
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/missing 0/);
    expect(r.out.at(-1)).toBe('landings ok');
  });

  it('缺 round-check.md → exit 2 且报文点名目录', () => {
    const root = make({});
    const ledger = make({});
    const r = checkLandings({ root, ledger });
    expect(r.code).toBe(2);
    expect(r.err[0]).toContain('不是账本目录（缺 round-check.md）');
    expect(r.err[0]).toContain(ledger);
  });

  it('delivery-audit.md 可选：缺它 → stderr WARN，stdout 不多行', () => {
    const root = make({ 'docs/a.md': 'l1\n' });
    const ledger = make({ 'round-check.md': '| 证据 | `docs/a.md:1` |\n' });
    const r = checkLandings({ root, ledger });
    expect(r.err).toContain('[WARN] 缺 delivery-audit.md');
    expect(r.out).toEqual(['landings: missing 0（files 1 / refs 1）', 'landings ok']);
  });

  it('token 含反斜杠也能解析', () => {
    const root = make({ 'docs/a.md': 'l1\n' });
    const ledger = make({ 'round-check.md': '| 证据 | `docs\\a.md:1` |\n' });
    expect(checkLandings({ root, ledger }).code).toBe(0);
  });

  it('重复 token 只计一条（去重）', () => {
    const root = make({ 'docs/a.md': 'l1\n' });
    const ledger = make({ 'round-check.md': '| 证据 | `docs/a.md:1` / `docs/a.md:1` |\n' });
    const r = checkLandings({ root, ledger });
    expect(r.out[0]).toMatch(/refs 1/);
  });

  it('两个账本文件都扫：files 2', () => {
    const root = make({ 'docs/a.md': 'l1\n' });
    const ledger = make({
      'round-check.md': '| 证据 | `docs/a.md:1` |\n',
      'delivery-audit.md': '| 证据 | `docs/a.md:1` |\n',
    });
    const r = checkLandings({ root, ledger });
    expect(r.out[0]).toMatch(/files 2 \/ refs 1/);
  });

  it('不执行证据命令：只判 path:line，命令里的其余文本不触发', () => {
    const root = make({ 'docs/a.md': 'l1\n' });
    const ledger = make({ 'round-check.md': '| 证据 | `node scripts/x.mjs --apply` + `docs/a.md:1` |\n' });
    expect(checkLandings({ root, ledger }).code).toBe(0);
  });
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
