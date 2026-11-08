/**
 * markdown 围栏识别（通用工具，不依赖任何项目结构）。
 * 判据：`^\s*` 未收紧到 CommonMark 的 `^ {0,3}`——4 空格缩进的 ``` 仍按围栏处理；
 * 闭合按「字符相同 + 长度 ≥ 开启长度」判定，否则 4 反引号里的 3 反引号会提前关掉外层。
 */
export const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * 围栏掩码：mask[i] = true 表示第 i 行在围栏内部（围栏分隔行本身不算内部）。
 * 未闭合的围栏会把文件剩余部分全吞进代码块；unclosedLine 给 1-based 行号（0 = 无）。
 */
export function fenceMask(lines: string[]): { mask: boolean[]; unclosedLine: number } {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open = -1;
  let openChar = '';
  let openLen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE_RE.exec(lines[i] ?? '');
    if (!m) {
      if (open >= 0) mask[i] = true;
      continue;
    }
    const fence = m[1] ?? '';
    if (open < 0) {
      open = i;
      openChar = fence[0] ?? '';
      openLen = fence.length;
    } else if (fence[0] === openChar && fence.length >= openLen) {
      open = -1;
      openChar = '';
      openLen = 0;
    } else {
      mask[i] = true; // 关不掉的开围栏行 = 代码块内部的普通内容
    }
  }
  return { mask, unclosedLine: open >= 0 ? open + 1 : 0 };
}
