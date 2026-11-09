import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSkillDir, checkSkills } from './check-skills.js';

const made: string[] = [];
function mkProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'scs-skills-'));
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

describe('scs check skills', () => {
  it('干净技能 → 0 findings，exit 0，stdout 契约同旧脚本', () => {
    const root = mkProject({
      'skills/alpha/SKILL.md': '# alpha\n',
      'skills/alpha/scripts/run.mjs': 'console.log(1)\n',
    });
    const r = checkSkills({ root });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe('0 findings（加 --json 看明细）');
  });

  it('跨技能路径引用 → 1 finding', () => {
    const root = mkProject({
      'skills/alpha/SKILL.md': '见 `beta/SKILL.md`\n',
      'skills/beta/SKILL.md': '# beta\n',
    });
    const { findings } = checkSkillDir(join(root, 'skills'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('跨技能路径引用');
  });

  it('自引用带前缀 → 1 finding', () => {
    const root = mkProject({ 'skills/alpha/SKILL.md': '本技能 `alpha/SKILL.md`\n' });
    const { findings } = checkSkillDir(join(root, 'skills'));
    expect(findings[0]?.check).toBe('自引用带前缀');
  });

  it('--manifest 缺文件 → exit 1', () => {
    const root = mkProject({ 'skills/alpha/SKILL.md': '# alpha\n' });
    expect(checkSkills({ root, manifest: join(root, 'nope.json') }).code).toBe(1);
  });

  it('根下无 skills/ → exit 1', () => {
    const root = mkProject({ 'docs/x.md': 'x\n' });
    expect(checkSkills({ root }).code).toBe(1);
  });

  it('--json 输出 { findings }', () => {
    const root = mkProject({ 'skills/alpha/SKILL.md': '见 `beta/SKILL.md`\n', 'skills/beta/SKILL.md': '# b\n' });
    const r = checkSkills({ root, json: true });
    expect(JSON.parse(r.out[0] ?? '{}').findings).toHaveLength(1);
  });
});
