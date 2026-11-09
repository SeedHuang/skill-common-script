import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 账本里的 `path:line` 落点：首字符不用 `/` `.` `\`，URL（`https://…`）里的 token 才能从主机名开始匹配到 */
const REF = /([A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z0-9]+):(\d+)/g;

export interface LandingsRun {
  /** 0 = 全部存在；1 = 有缺失 / 越界；2 = 用法或读取错误 */
  code: 0 | 1 | 2;
  out: string[];
  err: string[];
}

/**
 * `scs check landings --root <项目根> --ledger <账本目录>`：
 * 核对 round-check.md（必需）与 delivery-audit.md（可选）里的 `path:line` 是否真实存在。
 * `--root` 与 `--ledger` 都按 cwd 解析；`--ledger` 不相对 `--root`。只判存在性，不执行证据命令。
 */
export function checkLandings({ root, ledger }: { root: string; ledger: string }): LandingsRun {
  const rc = join(ledger, 'round-check.md');
  if (!existsSync(rc)) return { code: 2, out: [], err: [`不是账本目录（缺 round-check.md）：${ledger}`] };

  const texts = [readFileSync(rc, 'utf8')];
  const warns: string[] = [];
  const da = join(ledger, 'delivery-audit.md');
  if (existsSync(da)) texts.push(readFileSync(da, 'utf8'));
  else warns.push('[WARN] 缺 delivery-audit.md'); // WARN 走 stderr，stdout 只留计数行与 landings ok

  const missing: string[] = [];
  const seen = new Set<string>();
  let refs = 0;
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      for (const m of line.matchAll(REF)) {
        const at = m.index ?? 0;
        if (at >= 3 && line.slice(at - 3, at) === '://') continue; // URL 不是落点
        const rel = m[1] ?? '';
        const n = Number(m[2]);
        const key = `${rel}:${n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs += 1;
        const abs = resolve(root, rel);
        if (!existsSync(abs)) { missing.push(`${rel}:${n}（文件不存在）`); continue; }
        const body = readFileSync(abs, 'utf8');
        // 行数口径：以换行结尾的文件不算多一行（`l1\n` = 1 行）
        const lineCount = body.split(/\r?\n/).length - (body.endsWith('\n') ? 1 : 0);
        if (lineCount < n) missing.push(`${rel}:${n}（越界，共 ${lineCount} 行）`);
      }
    }
  }

  const head = `landings: missing ${missing.length}（files ${texts.length} / refs ${refs}）`;
  const out = [head, ...missing];
  if (missing.length === 0) out.push('landings ok');
  return { code: missing.length ? 1 : 0, out, err: warns };
}
