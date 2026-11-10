import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRules, scoreFile } from './check-rules.js';

const made: string[] = [];
function mkProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'scs-rules-'));
  made.push(root);
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), t, 'utf8');
  }
  return root;
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const TERMS = { markers: [{ pattern: 'path:\\d+' }] };
const RULE = [
  '# 禁止直接改主分支',
  '',
  '> 来源：项目约定（2026-11-09）落地',
  '',
  '## 规则',
  '',
  '必须在提交前查看 diff，禁止直接 commit 到主分支。',
  '',
  '## 验证',
  '',
  '跑 `git status` 看 path:1 结果，确认无改动。',
].join('\n');
// 义务类基准（正文不含 禁止/不得/不要/严禁 → isBan=false）
const DUTY = [
  '# 提交前必须查看 diff',
  '',
  '> 来源：项目约定（2026-11-09）落地',
  '',
  '## 规则',
  '',
  '必须在提交前查看 diff，确认只含本次改动。',
  '',
  '## 验证',
  '',
  '跑 `git status` 看 path:1 结果，确认无改动。',
].join('\n');
const chk9 = (file: string, rulesDir: string) =>
  scoreFile(file, rulesDir, {}, TERMS).checks.find((c) => c.check === '⑨判据可观察');

describe('scs check rules', () => {
  it('全库评分 → exit 0 且首行是旧脚本同形态摘要', () => {
    const root = mkProject({
      'rules/a.md': RULE,
      'tools/terms.json': JSON.stringify(TERMS),
    });
    const r = checkRules({ root, terms: join(root, 'tools/terms.json') });
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^共 1 文件 \/ \d+ 行 \/ \d+ 字符，平均得分率 \d+%（.+）$/);
  });

  it('缺 --terms → exit 2', () => {
    const root = mkProject({ 'rules/a.md': RULE });
    expect(checkRules({ root, terms: '' }).code).toBe(2);
  });

  it('词表文件不存在 → exit 1', () => {
    const root = mkProject({ 'rules/a.md': RULE });
    expect(checkRules({ root, terms: join(root, 'nope.json') }).code).toBe(1);
  });

  it('--file 不存在的规则 → exit 1', () => {
    const root = mkProject({ 'rules/a.md': RULE, 'tools/terms.json': JSON.stringify(TERMS) });
    expect(checkRules({ root, terms: join(root, 'tools/terms.json'), file: join(root, 'rules/nope.md') }).code).toBe(1);
  });

  it('--file 模式摘要带单条得分', () => {
    const root = mkProject({ 'rules/a.md': RULE, 'tools/terms.json': JSON.stringify(TERMS) });
    const r = checkRules({ root, terms: join(root, 'tools/terms.json'), file: join(root, 'rules/a.md') });
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^得分 \d+\/\d+（\d+%，(健康|预警|不及格)）$/);
  });

  it('规则库不存在 → exit 1', () => {
    const root = mkProject({ 'tools/terms.json': JSON.stringify(TERMS) });
    expect(checkRules({ root, terms: join(root, 'tools/terms.json') }).code).toBe(1);
  });

  it('⑨ 判据可观察：验证节无可观察标记 → 记 0 分', () => {
    const root = mkProject({ 'rules/a.md': RULE.replace('path:1 ', '看起来合理 '), 'tools/terms.json': JSON.stringify(TERMS) });
    expect(chk9(join(root, 'rules/a.md'), join(root, 'rules'))?.pass).toBe(false);
  });

  it('⑨ 判据可观察：验证节命中 marker → 记 1 分', () => {
    const root = mkProject({ 'rules/a.md': RULE, 'tools/terms.json': JSON.stringify(TERMS) });
    expect(chk9(join(root, 'rules/a.md'), join(root, 'rules'))?.pass).toBe(true);
  });

  it('⑨ 判据可观察：marker 只在围栏代码块内 → 不计分', () => {
    const fenced = RULE.replace('跑 `git status` 看 path:1 结果，确认无改动。', ['```', 'path:1', '```', '确认无改动。'].join('\n'));
    const root = mkProject({ 'rules/a.md': fenced, 'tools/terms.json': JSON.stringify(TERMS) });
    expect(chk9(join(root, 'rules/a.md'), join(root, 'rules'))?.pass).toBe(false);
  });

  it('⑨ 判据可观察：缺「## 验证」节 → 记 0 分', () => {
    const root = mkProject({ 'rules/a.md': RULE.replace('## 验证', '## 检查'), 'tools/terms.json': JSON.stringify(TERMS) });
    expect(chk9(join(root, 'rules/a.md'), join(root, 'rules'))?.pass).toBe(false);
  });

  it('⑨ 判据可观察：多处「## 验证」只认第一个（首个无 marker → 0）', () => {
    const dual = RULE.replace('## 验证\n\n跑 `git status` 看 path:1 结果，确认无改动。', '## 验证\n\n看起来合理。\n\n## 验证\n\npath:1 通过。');
    const root = mkProject({ 'rules/a.md': dual, 'tools/terms.json': JSON.stringify(TERMS) });
    expect(chk9(join(root, 'rules/a.md'), join(root, 'rules'))?.pass).toBe(false);
  });

  it('满分基数：四类 total max 与 criteria 冻结值一致', () => {
    const root = mkProject({ 'rules/ban.md': RULE, 'rules/duty.md': DUTY, 'tools/terms.json': JSON.stringify(TERMS) });
    const dir = join(root, 'rules');
    const maxOf = (file: string, type: string) => scoreFile(join(dir, file), dir, { type }, TERMS).max;
    expect(maxOf('ban.md', '持续适用')).toBe(24);
    expect(maxOf('ban.md', '模式门控')).toBe(32);
    expect(maxOf('duty.md', '持续适用')).toBe(21);
    expect(maxOf('duty.md', '条件触发')).toBe(23);
  });
});
