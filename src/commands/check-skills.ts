import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 迁移自 retro-skills `skills/skill-inspector/scripts/check.mjs`（spec §3.7）：
// 判定逻辑逐行保留，只把 `--dir <skills 父目录>` 改为 `--root <项目根>`（技能目录 = <root>/skills），
// `--manifest` 不再有仓内默认值（R11：scs 默认值不得指向具体仓布局）。

const SKILL_MD = 'SKILL.md';

// 「什么算技能目录」：目录层 withFileTypes.isDirectory（不跟随链接）+ 文件层 lstatSync 确认真文件。
// ENOENT 静默跳过，其余错误抛出（防「权限读不到」被当成「不是技能目录」而静默漏扫）。
function isSkillDir(parent: string, name: string): boolean {
  let st;
  try {
    st = lstatSync(join(parent, name, SKILL_MD));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw new Error(`读取 ${join(parent, name, SKILL_MD)} 失败：${code ?? (e instanceof Error ? e.message : String(e))}`);
  }
  return st.isFile();
}

function listSkillDirs(parent: string): string[] {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`读取技能目录失败：${parent}（${code ?? (e instanceof Error ? e.message : String(e))}）`);
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).filter((name) => isSkillDir(parent, name));
}

// 路径引用：技能名 + references/ | assets/ | scripts/，或技能名 + SKILL.md
const PATH_REF_RE = /`(?:skills\/)?([a-z][a-z0-9-]*)\/(?:references\/|assets\/|scripts\/|SKILL\.md(?![a-z0-9.]))/g;
// 守卫路径字符串比较
const GUARD_RE =
  /(?:process\.argv\[1\]\s*(?:===|!==|==|!=)\s*fileURLToPath\(import\.meta\.url\)|fileURLToPath\(import\.meta\.url\)\s*(?:===|!==|==|!=)\s*process\.argv\[1\]|import\.meta\.url\s*(?:===|!==|==|!=)\s*pathToFileURL\(process\.argv\[1\]\)\.href|pathToFileURL\(process\.argv\[1\]\)\.href\s*(?:===|!==|==|!=)\s*import\.meta\.url)/g;

export interface SkillFinding {
  skill: string;
  file: string;
  check: string;
  line: number;
  text: string;
}

// 技能目录下全部 .md（递归；不跟随链接；跳过点目录与 node_modules）
function collectScanFiles(skillDir: string): { abs: string; rel: string }[] {
  const files: { abs: string; rel: string }[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.name.endsWith('.md')) {
        files.push({ abs: join(d, e.name), rel: rel ? `${rel}/${e.name}` : e.name });
      }
    }
  };
  walk(skillDir, '');
  return files;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

export interface SkillManifest {
  skills?: string[];
}

/** 扫描 `skillsDir` 下的全部技能（① 跨技能路径引用 / ② 自引用带前缀 / ③ 守卫路径字符串比较）。 */
export function checkSkillDir(dir: string, opts: { manifest?: SkillManifest } = {}): { findings: SkillFinding[] } {
  const { manifest } = opts;
  if (manifest && !Array.isArray(manifest.skills)) throw new Error('manifest.skills 必须是数组');
  const dirSkills = listSkillDirs(dir);
  const knownSkills = [...new Set([...dirSkills, ...(manifest?.skills ?? [])])];
  const findings: SkillFinding[] = [];
  for (const skill of dirSkills) {
    const skillDir = join(dir, skill);
    for (const { abs, rel } of collectScanFiles(skillDir)) {
      const text = readFileSync(abs, 'utf8');
      for (const m of text.matchAll(PATH_REF_RE)) {
        const ref = m[1] ?? '';
        if (ref === skill) findings.push({ skill, file: rel, check: '自引用带前缀', line: lineOf(text, m.index ?? 0), text: m[0] });
        else if (knownSkills.includes(ref)) findings.push({ skill, file: rel, check: '跨技能路径引用', line: lineOf(text, m.index ?? 0), text: m[0] });
      }
    }
    const scriptsDir = join(skillDir, 'scripts');
    if (existsSync(scriptsDir)) {
      for (const f of readdirSync(scriptsDir).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
        const s = readFileSync(join(scriptsDir, f), 'utf8');
        for (const m of s.matchAll(GUARD_RE)) {
          findings.push({ skill, file: 'scripts/' + f, check: '守卫路径字符串比较', line: lineOf(s, m.index ?? 0), text: m[0] });
        }
      }
    }
  }
  return { findings };
}

export interface CheckSkillsOptions {
  root: string;
  manifest?: string;
  json?: boolean;
}

export interface CheckSkillsRun {
  /** 旧脚本只有 0 / 1（无 2）：用法错误同样记 1 */
  code: 0 | 1;
  out: string[];
  err: string[];
  result?: { findings: SkillFinding[] };
}

/** CLI 入口：`scs check skills --root <项目根> [--manifest <path>] [--json]` */
export function checkSkills(options: CheckSkillsOptions): CheckSkillsRun {
  const dir = join(options.root, 'skills');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { code: 1, out: [], err: [`目录不存在或不是目录：${dir}（--root 指向项目根，技能目录 = <root>/skills）`] };
  }
  if (listSkillDirs(dir).length === 0) {
    return {
      code: 1,
      out: [],
      err: [`--root 下没有含 SKILL.md 的技能子目录：${dir}（两种可能：① --root 不是项目根；② 该目录下技能是 junction / 符号链接安装的 —— 不跟随链接，请在源仓库跑）`],
    };
  }
  let manifest: SkillManifest | undefined;
  if (options.manifest !== undefined) {
    if (!existsSync(options.manifest)) {
      return { code: 1, out: [], err: [`manifest 不存在：${options.manifest}`] };
    }
    try {
      manifest = JSON.parse(readFileSync(options.manifest, 'utf8')) as SkillManifest;
    } catch {
      return { code: 1, out: [], err: [`manifest 读取或解析失败：${options.manifest}（须为可读的合法 JSON 文件）`] };
    }
  }
  let result;
  try {
    result = checkSkillDir(dir, { manifest });
  } catch (e) {
    return { code: 1, out: [], err: [`扫描失败：${e instanceof Error ? e.message : String(e)}`] };
  }
  const out = [options.json ? JSON.stringify(result, null, 2) : `${result.findings.length} findings（加 --json 看明细）`];
  return { code: result.findings.length > 0 ? 1 : 0, out, err: [], result };
}
