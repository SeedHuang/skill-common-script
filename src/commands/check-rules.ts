import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// 迁移自 retro-skills `skills/rule-inspector/scripts/score.mjs`（spec §3.7）：
// 判定逻辑与正则逐行保留；`--dir` / `--repo-root` → `--root`（规则库 = <root>/rules），
// 词表改为必填 `--terms`（R11：scs 不写死任何仓内布局默认值）。

const SOURCE_TYPES = ['用户当场指令', '评审第 N 轮', '实测/踩坑', '项目约定'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIR_HEADING_HINTS = /笔记|规范|说明|踩坑/;
const REF_MD_RE = /([A-Za-z0-9_-]+\.md)/g;
const DOC_DIR_RE = /(?:^|[`"'(\s|])(docs|specs|plans|handoffs|session|assets|references|scripts)[/\\]/;
const LINE_OVER_LEN = 200;

const HISTORY_RE = /合并|补于|补记|历史/;
const GUIDE_RE = /^(总之|综上|需要注意的是|换句话说|由此可见)/;
const TYPE_KEYS = ['持续适用', '条件触发', '模式门控', '待拆未定'];
const POLAR_RE = /禁止|不得|不要|必须|应|要/;
const BAN_RE = /禁止|不得|不要|严禁/;
const ACTION_RE = /执行|进行|使用|提交|查看|写|调用|删除|运行|打开|输入|生成|修改|记录/;
const VAGUE_RE = /合理处理|适当|认真对待|酌情|妥善处理/;
const ENUM_RE = /[A-Za-z0-9_-]+(?:、[A-Za-z0-9_-]+){1,}/;
const SPECIFIC_TOKEN_RE = /(git|npm|tsc|node|文件|目录|命令|脚本|计划|仓库|文档|代码)/;
const COND_RE = /在[^。；\n]{1,24}(?:时|场景|下|前|后|中)|当[^。；\n]{1,20}(?:时|后)/;
const MODE_COND_RE = /只适用于[^。；\n]{1,30}(?:的时刻|的场景|的情形)|当[^。；\n]{1,20}时(?:进入|处于|设为)?[^。；\n]{0,8}模式/;
const BROAD_RE = /全部情况|所有情况|任何情况|任何场景/;
const TRIG_RE = /落地后|开工时|编辑后|提交前|动手前|操作前|执行前|启动时|每次[^。；\n]{0,10}前/;
const MODE_TRIG_RE = /由[^。；\n]{0,24}控制|回到[^。；\n]{0,8}模式/;
const COVER_RE = /不因|不豁免|同样禁止|任何来源|不因此/;
const CONFLICT_RE = /以本规则为准|以本条为准|本规则优先|本条优先/;
const EXCEPTION_RE = /只有[^。；\n]{1,40}才算/;
const LOOSE_RE = /一般|通常|可能允许|宽松/;
const VERIFY_RE = /验证|自检|检查点|报告|自查|检查是否|确认遵守|复核|核销|跑一遍|体检/;
const PRODUCT_RE = /产物|清单|报告|\bspec\b|输出块|「[^」]{2,12}」(?:块|节|表)/;
const PRODUCT_VERB_RE = /写进|落到|记入|落盘|挂进|绑进/;
const CARRIER_RE = /回复|回答|commit body|账本|对话记录/;
const BIND_VERB_RE = /挂进|绑进|写进|落到|核销/;
const PATH_RE = /`([^`\n]{1,200}\.(?:md|mjs))`/g;
const H3_DECO_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2B50}\u{FE0F}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}★☆◆●■▲▶✔✗‼❓❕❗⚠]/u;
const PRECONDITION_BODY_RE =
  /在[^。；\n]{1,24}(?:时|前|下|中)|除非|仅限|未[^。；\n]{0,12}(?:前|时)|(?:提交|编辑|落地|发布|部署|执行|操作|写|启动)前/;
const PRECONDITION_TITLE_RE =
  /在[^。；\n]{1,24}(?:时|前|下|中)|除非|仅限|未[^。；\n]{0,12}(?:时|前)|(?:提交|编辑|落地|发布|部署|执行|操作|写|启动)前/;
const OBJECT_HINT_RE = /(git|npm|文件|目录|命令|规则|文档|代码|提交|操作|组件|接口|数据|仓库|写操作)/;

// 围栏识别 / 掩码（与 retro-skills tools/execution-matrix/markdown-rows.mjs 同口径）
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
function fenceMask(lines: string[]): { mask: boolean[]; unclosedLine: number } {
  const mask = new Array(lines.length).fill(false);
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
      open = i; openChar = fence[0] ?? ''; openLen = fence.length;
    } else if (fence[0] === openChar && fence.length >= openLen) {
      open = -1; openChar = ''; openLen = 0;
    } else {
      mask[i] = true;
    }
  }
  return { mask, unclosedLine: open >= 0 ? open + 1 : 0 };
}

export interface ObservableTerms {
  markers: { pattern: string }[];
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export interface ScoreOptions {
  type?: string | null;
  triCheckDone?: boolean;
  cognitive?: boolean | string;
  x2Carrier?: boolean | string;
  x3Done?: boolean | string;
  modeChecks?: Record<string, unknown>;
  base?: string;
}

export interface ScoreCheck {
  group: string;
  check: string;
  pass: boolean;
  msg: string;
}

export interface ScoreFinding {
  group: string;
  check: string;
  msg: string;
  recipe?: string;
}

export interface ScoreResult {
  name: string;
  lines: number;
  chars: number;
  groups: Record<string, { score: number; max: number }>;
  total: number;
  max: number;
  rate: number;
  level?: string;
  findings: ScoreFinding[];
  checks: ScoreCheck[];
}

function verifySectionHasMarker(lines: string[], terms: ObservableTerms): boolean {
  const at = lines.findIndex((l) => /^#{2,3}\s*验证$/u.test(l.trim()));
  if (at < 0) return false;
  const level = (lines[at] ?? '').trim().match(/^#+/)?.[0].length ?? 0;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const m = (lines[i] ?? '').trim().match(/^#+/);
    if (m && (m[0]?.length ?? 0) <= level) { end = i; break; }
  }
  const { mask } = fenceMask(lines);
  const compiled = terms.markers.map((m) => new RegExp(m.pattern));
  return lines.slice(at + 1, end).some((l, k) => !mask[at + 1 + k] && compiled.some((re) => re.test(l)));
}

function extractPaths(text: string): { raw: string; index: number }[] {
  const out: { raw: string; index: number }[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1] ?? '';
    if (p.includes('<') || p.startsWith('~') || p.includes('*')) continue;
    out.push({ raw: p, index: m.index ?? 0 });
  }
  return out;
}

function pathExists(p: string, base = process.cwd()): boolean {
  try { return existsSync(resolve(base, p)); } catch { return false; }
}

function sentences(text: string): string[] {
  return text.split(/[。；\n]/);
}

function x1ProductLanding(body: string, base = process.cwd()): { ok: boolean; why: string } {
  const allPaths = extractPaths(body);
  const bad = allPaths.find((p) => !pathExists(p.raw, base));
  if (bad) return { ok: false, why: `声称的落点路径不存在：${bad.raw}` };
  const ss = sentences(body);
  for (let i = 0; i < ss.length; i += 1) {
    const win = i + 1 < ss.length ? `${ss[i]}。${ss[i + 1]}` : (ss[i] ?? '');
    if (!PRODUCT_RE.test(win) || !PRODUCT_VERB_RE.test(win)) continue;
    if (CARRIER_RE.test(win)) return { ok: true, why: '' };
    if (extractPaths(win).length > 0) return { ok: true, why: '' };
  }
  return { ok: false, why: '产物与去处未在同句/相邻句成对（产物模式 + 写进/落到/记入/落盘/挂进/绑进 + 载体词或仓内路径）' };
}

function x2Binding(body: string, base = process.cwd()): { ok: boolean; why: string } {
  const ss = sentences(body);
  let declared = 0;
  for (const s of ss) {
    if (!BIND_VERB_RE.test(s)) continue;
    const ps = extractPaths(s);
    if (ps.length === 0) continue;
    for (const p of ps) {
      const after = s.slice(p.index + 1 + p.raw.length);
      const slot = after.match(/「([^」]{2,12})」/);
      if (!slot) continue;
      declared += 1;
      if (!pathExists(p.raw, base)) return { ok: false, why: `绑定路径不存在：${p.raw}` };
      let target;
      try { target = readFileSync(resolve(base, p.raw), 'utf8'); }
      catch (e) { return { ok: false, why: `读取绑定目标失败 ${p.raw}：${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e))}` }; }
      if (!target.includes(slot[1] ?? '')) return { ok: false, why: `目标文件 ${p.raw} 不含声明的槽位「${slot[1]}」` };
    }
  }
  if (declared === 0) return { ok: false, why: '无「绑定动词 + 反引号路径 + 「槽位」」三段齐全的声明（挂进/绑进/写进/落到/核销 + `路径` + 「节名」）' };
  return { ok: true, why: '' };
}

function parseHeader(text: string) {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().startsWith('> 来源：'));
  const sourceLine = idx >= 0 ? (lines[idx] ?? '') : '';
  return {
    sourceLine, inHead: idx >= 0 && idx < 10, idx,
    hasSource: idx >= 0,
    hasType: SOURCE_TYPES.some((t) => sourceLine.includes(t)),
    hasDate: DATE_RE.test(sourceLine.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? ''),
    hasLanding: sourceLine.includes('落地'),
    hasQuote: /「|」|"|'/.test(sourceLine.replace(/来源：.*?（\d{4}-\d{2}-\d{2}）/, '')),
    len: sourceLine.length,
    type: SOURCE_TYPES.find((t) => sourceLine.includes(t)) ?? null,
  };
}

function h3HasDeco(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('### ') && H3_DECO_RE.test(line)) return true;
  }
  return false;
}

function hasDuplicateSentence(body: string): boolean {
  const seen = new Set<string>();
  for (const raw of body.split(/[。；！？\n]/)) {
    const s = raw.trim();
    if (!s) continue;
    if (seen.has(s)) return true;
    seen.add(s);
  }
  return false;
}

function hasGuideOpening(body: string): boolean {
  for (const para of body.split(/\r?\n+/)) {
    const t = para.trim();
    if (t && GUIDE_RE.test(t)) return true;
  }
  return false;
}

function actionSpecific(body: string): boolean {
  if (VAGUE_RE.test(body)) return false;
  return ENUM_RE.test(body) || SPECIFIC_TOKEN_RE.test(body);
}

function crossRuleMiss(text: string, rulesDir: string, name: string): string[] {
  const ruleNames = new Set(readdirSync(rulesDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
  const refs = new Set<string>();
  for (const m of text.matchAll(REF_MD_RE)) {
    const raw = m[1] ?? '';
    const idx = m.index ?? 0;
    if (/[/\\]/.test(raw) || (idx > 0 && /[/\\]/.test(text[idx - 1] ?? ''))) continue;
    const before = text.slice(Math.max(0, idx - 120), idx);
    if (DOC_DIR_RE.test(before)) continue;
    const stem = raw.replace(/\.md$/, '');
    if (/^xxx-/.test(stem) || stem === 'SKILL' || stem === 'README') continue;
    refs.add(stem);
  }
  for (const rn of ruleNames) if (rn && rn !== name.replace(/\.md$/, '') && text.includes(rn)) refs.add(rn);
  return [...refs].filter((r) => r !== name.replace(/\.md$/, '') && !ruleNames.has(r));
}

function rateLevel(rate: number): string {
  return rate >= 0.9 ? '健康' : rate >= 0.7 ? '预警' : '不及格';
}

/** 单规则评分（criteria §2.4/§3；类型感知）。 */
export function scoreFile(filePath: string, rulesDir: string, opts: ScoreOptions = {}, terms: ObservableTerms): ScoreResult {
  const raw = readFileSync(filePath, 'utf8');
  const text = stripBom(raw);
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
  const chars = text.length;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const h = parseHeader(text);
  const title = text.match(/^# (.+)$/m)?.[1] ?? '';
  const lineArr = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const body = lineArr.filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('> 来源')).join('\n');

  const type = opts.type && TYPE_KEYS.includes(opts.type) ? opts.type : '条件触发';
  const isBan = BAN_RE.test(body);
  const isPending = type === '待拆未定';
  const modeChecks = opts.modeChecks ?? {};

  const findings: ScoreFinding[] = [];
  const checks: ScoreCheck[] = [];
  const groups: Record<string, { score: number; max: number }> = {};
  const g = (gname: string, check: string, pass: boolean, msg: string, recipe?: string) => {
    groups[gname] ??= { score: 0, max: 0 };
    const grp = groups[gname] as { score: number; max: number };
    grp.max += 1;
    const ok = pass === true;
    checks.push({ group: gname, check, pass: ok, msg: ok ? '' : msg });
    if (ok) grp.score += 1;
    else findings.push({ group: gname, check, msg, recipe });
  };

  // ── 头部规范（3）──
  g('头部规范', '来源行三字段（类型/日期/落地）', h.hasSource && h.hasType && h.hasDate && h.hasLanding,
    '来源行缺「来源：类型（日期）」或「落地」字段', '补全来源行三字段：类型（日期）+ 落地');
  g('头部规范', '来源类型在枚举内', h.hasType && h.type !== null && SOURCE_TYPES.includes(h.type),
    '来源类型不在枚举内（用户当场指令/评审第 N 轮/实测踩坑/项目约定）', '来源类型改为枚举内四类之一');
  g('头部规范', '来源行不错位', h.inHead,
    '来源行不在头部前 10 行内', '来源行移到文件头部（前 10 行内）');

  // ── 层级规范（2）──
  const h1Count = (text.match(/^# /gm) ?? []).length;
  g('层级规范', 'H1 唯一', h1Count === 1, `H1 标题出现 ${h1Count} 次`, '全文只保留一个 `# 标题`');
  g('层级规范', 'H3 无 emoji', !h3HasDeco(text), 'H3 标题含 emoji/装饰符号', '移除 H3 标题中的 emoji/装饰符号');

  // ── 来源精简（2）──
  g('来源精简', '来源行 ≤2 渲染行', h.len <= LINE_OVER_LEN, `来源行超长（${h.len} 字符 > 200）`, '压缩来源行到 ≤200 字符（约 2 渲染行）');
  g('来源精简', '无原话引用', !h.hasQuote, '来源行含用户原话引用（引号内）', '来源行去掉引号内原话，改为转述');

  // ── 引用完整（1）──
  const miss = crossRuleMiss(text, rulesDir, name);
  g('引用完整', '跨规则指针有效', miss.length === 0, `失效指针：${miss.join('、')}`, '补全引用的规则文件，或移除该引用');

  // ── 冗余度（4）──
  g('冗余度', '无完全重复句', !hasDuplicateSentence(body), '正文存在完全重复的句子', '合并或删除重复句，保留一处');
  g('冗余度', '无空泛引导段', !hasGuideOpening(body), '段落以「总之/综上/需要注意的是」等空泛引导词开头', '删除空泛引导段，直接写结论');
  g('冗余度', '无来源行历史叙述', !HISTORY_RE.test(h.sourceLine), '来源行含「合并/补于/补记」等历史叙述', '来源行去掉历史叙述词');
  g('冗余度', '三检验报告已做', !!opts.triCheckDone, '三检验报告未做（AI 侧）', '由 AI 逐段做三检验并写报告；报告必须做');

  // ── 单规则（通用，类型派生：待拆未定 = 0）──
  g('单规则', '单规则检查（非合集）', !isPending, '合集：多个独立规则/极性混合 → 该拆', '拆成 N 条独立规则后分别评分');

  // ── 执行力度 ──
  if (!isPending) {
    const hasCond = type !== '持续适用';
    g('执行力度', '①极性明确', POLAR_RE.test(body) && ACTION_RE.test(body), '正文无极性词（禁止/不得/不要/必须/应/要）或动作', '补极性词 + 明确动作');
    g('执行力度', '②动作内容具体', actionSpecific(body), '动作对象空泛（合理处理/适当类）或无具体对象', '动作对象改为可枚举项或具体描述');
    if (hasCond) {
      const condOk = type === '条件触发'
        ? (COND_RE.test(body) && !BROAD_RE.test(body))
        : (MODE_COND_RE.test(body) && !BROAD_RE.test(body));
      g('执行力度', '③适用条件精细', condOk, '适用条件缺失或写「全部情况」', '条件精确到「具体类型+条件」（如「在 typescript 场景」）');
    }
    if (isBan) {
      g('执行力度', '④来源覆盖（禁令类）', COVER_RE.test(body), '未声明「不因来源豁免」', '补「防掠过」小节：不因计划/子代理/脚本/工具模板豁免');
      g('执行力度', '⑤冲突裁决（禁令类）', CONFLICT_RE.test(body), '未声明冲突时以本规则为准', '补「冲突裁决」小节：与具体指令/模板冲突时以本规则为准');
      g('执行力度', '⑥例外从严（禁令类）', EXCEPTION_RE.test(body) && !LOOSE_RE.test(body), '例外条件不明确或含宽松词（一般/通常/可能允许）', '例外写「只有…才算」且无宽松词');
    }
    if (hasCond) {
      const trigOk = type === '条件触发' ? TRIG_RE.test(body) : MODE_TRIG_RE.test(body);
      g('执行力度', '⑦触发机制', trigOk, '无可观测触发信号/时机', '补「触发时机」小节（落地后/开工时/编辑后）');
    }
    const cognitive = opts.cognitive === true || opts.cognitive === 'true';
    const x2Carrier = opts.x2Carrier === true || opts.x2Carrier === 'true';
    if (cognitive) {
      const x1 = x1ProductLanding(body, opts.base);
      g('执行力度', 'X1动作产物化', x1.ok, `认知动作未声明「产物+去处」成对：${x1.why}`, '补产物模式 + 去处动词 + 去处（载体词表或仓内路径，路径须 Test-Path 为真）——判据见 criteria §3.3b');
      if (!x2Carrier) {
        const x2 = x2Binding(body, opts.base);
        g('执行力度', 'X2必经路径绑定', x2.ok, `认知动作未声明必经路径绑定：${x2.why}`, '补「绑定动词 + 反引号路径 + 「槽位」」三段，且目标文件真含该槽位（文件断言）——判据见 criteria §3.3b');
      }
      const x3Done = opts.x3Done === true || opts.x3Done === 'true';
      g('执行力度', 'X3触发前置', x3Done, '触发在应激时刻且未前置显式化（AI 判，经 annotations x3Done 传入，判定依据须可复核）', '应激时刻触发需前置显式化：任务开头先声明；AI 判定后写进 annotations');
    }
    g('执行力度', '⑧验证闭环', VERIFY_RE.test(body), '未定义怎么确认遵守了', '补「验证」小节：自检命令/检查点/报告要求');
    g('执行力度', '⑨判据可观察', verifySectionHasMarker(lineArr, terms), '验证节内没有任何可观察标记（停在形容词）；无「## 验证」节同样记 0', '处方 §R9：改比较式 / 加 path:line 或退出码 / 进豁免并写术语出处');
    if (type === '模式门控') {
      g('模式专属', 'M1 状态集合完整', !!modeChecks.M1, '状态集合不全（漏态 = 该态下规则没交代）', '补全规则管辖的全部模式（≥2 态）');
      g('模式专属', 'M2 每状态行为明确', !!modeChecks.M2, '存在状态未规定动作裁决（空态）', '每个状态都规定做/不做的动作裁决');
      g('模式专属', 'M3 切换依据明确', !!modeChecks.M3, '切换信号不可观测（感觉/大概/酌情）', '状态转移由可观测信号驱动');
      g('模式专属', 'M4 回到逻辑完整', !!modeChecks.M4, '缺「退出 → 重新适用」回转路径（单向退出 = 规则形同失效）', '补「退出 → 重新适用」回转路径');
      g('模式专属', 'M5 模式边界封闭', !!modeChecks.M5, '存在需执行者语义归类的状态情形', '每态覆盖情形写成可判定枚举（防掠过）');
      g('模式专属', 'M6 退出后由谁接管', !!modeChecks.M6, '规则让位时未指明动作按什么管（退出留空档）', '指明让位后动作按哪条规则管');
    }
  }

  // ── 标题（4）──
  const titlePolar = POLAR_RE.test(title);
  g('标题', '标题为一句可执行规则（非主题名）', titlePolar && !DIR_HEADING_HINTS.test(title), '标题是主题名（非一句话可执行规则）', '改写标题为含极性+动作+对象的一句话规则');
  g('标题', '含极性 + 动作 + 对象', titlePolar && ACTION_RE.test(title) && OBJECT_HINT_RE.test(title), '标题缺极性/动作/对象', '标题含「禁止/必须/不得」+ 动作 + 对象');
  const bodyPre = PRECONDITION_BODY_RE.test(body);
  const titlePre = PRECONDITION_TITLE_RE.test(title);
  g('标题', '反映关键前提', bodyPre === titlePre, '内容有明确前提但标题未体现', '标题体现关键前提（如「在沟通中」）');
  const titlePolarWord = title.match(/禁止|不得|不要|必须|应|要/)?.[0] ?? '';
  const titleObject = title.match(OBJECT_HINT_RE)?.[0] ?? '';
  const consistent = titlePolarWord !== '' && body.includes(titlePolarWord) && titleObject !== '' && body.includes(titleObject);
  g('标题', '标题 ↔ 内容一致性', consistent, '标题与正文范围/极性/对象不一致', '收尾对照三句：①范围 ②极性 ③对象 与正文一致');

  const total = Object.values(groups).reduce((a, grp) => a + grp.score, 0);
  const max = Object.values(groups).reduce((a, grp) => a + grp.max, 0);
  const rate = max === 0 ? 0 : total / max;
  const level = isPending ? undefined : rateLevel(rate);
  return { name, lines, chars, groups, total, max, rate, level, findings, checks };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export interface Annotations {
  [file: string]: ScoreOptions;
}

export interface ScoreDirOptions extends ScoreOptions {
  baselineFile?: string | null;
  annotations?: Annotations;
  annotationsPath?: string;
}

export interface ScoreDirResult {
  dir: string;
  measuredAt: string;
  totals: { files: number; lines: number; chars: number };
  currentBaseline: { totalLines: number; medianLines: number; x1_5: number };
  previous: { lines: number; chars: number } | null;
  diff: { lines: number; chars: number } | null;
  files: ScoreResult[];
  total?: number;
  rate?: number;
  level?: string;
}

/** 目录评分（annotations 只自动发现 `<dir>/.inspector-annotations.json`；仓级落点由调用方显式传）。 */
export function scoreDir(dir: string, terms: ObservableTerms, opts: ScoreDirOptions = {}): ScoreDirResult {
  let annotations = opts.annotations;
  if (!annotations) {
    const annPath = [join(dir, '.inspector-annotations.json'), opts.annotationsPath ?? ''].filter(Boolean).find((p) => existsSync(p));
    if (annPath) {
      let ann;
      try { ann = JSON.parse(stripBom(readFileSync(annPath, 'utf8'))); }
      catch (e) {
        throw new Error(`annotations 解析失败：${annPath}（须为 JSON 对象，如 {"文件名":{"cognitive":true,"x3Done":true}}）——${e instanceof Error ? e.message : String(e)}`);
      }
      if (!ann || typeof ann !== 'object' || Array.isArray(ann)) {
        throw new Error(`annotations 格式错误：${annPath}（须为 JSON 对象，如 {"文件名":{"cognitive":true,"x3Done":true}}）`);
      }
      annotations = ann as Annotations;
    }
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const lineCounts = files.map((f) => {
    const t = stripBom(readFileSync(join(dir, f), 'utf8'));
    return t.replace(/\r?\n$/, '').split(/\r?\n/).length;
  });
  const medianLines = median(lineCounts);
  const scored = files.map((f) => {
    const ann = annotations?.[f];
    return scoreFile(join(dir, f), dir, ann ? { ...opts, ...ann } : opts, terms);
  });
  const linesTotal = scored.reduce((a, f) => a + f.lines, 0);
  const charsTotal = scored.reduce((a, f) => a + f.chars, 0);
  const currentBaseline = { totalLines: linesTotal, medianLines, x1_5: Math.round(linesTotal * 1.5 * 10) / 10 };
  let previous: { lines: number; chars: number } | null = null;
  let diff: { lines: number; chars: number } | null = null;
  if (opts.baselineFile) {
    const prev = JSON.parse(readFileSync(opts.baselineFile, 'utf8'));
    previous = prev.totals ?? prev.currentBaseline;
    diff = { lines: linesTotal - previous!.lines, chars: charsTotal - previous!.chars };
  }
  const rated = scored.filter((f) => f.level !== undefined);
  const total = rated.length ? Math.round(rated.reduce((a, f) => a + f.total, 0) / rated.length) : undefined;
  const rate = rated.length ? rated.reduce((a, f) => a + f.rate, 0) / rated.length : undefined;
  const level = rate === undefined ? undefined : rateLevel(rate);
  return { dir, measuredAt: new Date().toISOString().slice(0, 10), totals: { files: scored.length, lines: linesTotal, chars: charsTotal }, currentBaseline, previous, diff, files: scored, total, rate, level };
}

export interface CheckRulesOptions {
  root: string;
  terms: string;
  file?: string;
  rulesDir?: string;
  json?: boolean;
  triCheck?: boolean;
  cognitive?: boolean;
  baseline?: string;
  type?: string;
  annotations?: string;
}

export interface CheckRulesRun {
  /** 0 通过 / 1 文件或读取错误 / 2 用法错误 */
  code: 0 | 1 | 2;
  out: string[];
  err: string[];
}

/** CLI 入口：`scs check rules --root <项目根> --terms <词表> [--file <规则>] [--rules-dir <dir>] …` */
export function checkRules(options: CheckRulesOptions): CheckRulesRun {
  if (!options.terms) {
    return { code: 2, out: [], err: ['用法：scs check rules --root <项目根> --terms <observable-terms.json> [--file <规则> | --rules-dir <dir>]'] };
  }
  if (!existsSync(options.terms)) return { code: 1, out: [], err: [`词表文件不存在：${options.terms}`] };
  let terms: ObservableTerms;
  try { terms = JSON.parse(stripBom(readFileSync(options.terms, 'utf8'))) as ObservableTerms; }
  catch (e) { return { code: 1, out: [], err: [`词表解析失败：${options.terms}（${e instanceof Error ? e.message : String(e)}）`] }; }

  const base = options.root;
  if (options.file) {
    if (!existsSync(options.file)) return { code: 1, out: [], err: [`文件不存在：${options.file}`] };
    if (options.rulesDir && !existsSync(options.rulesDir)) return { code: 1, out: [], err: [`规则库目录不存在：${options.rulesDir}`] };
    let opts: ScoreOptions = { triCheckDone: options.triCheck, type: options.type, cognitive: options.cognitive };
    const rulesDir = options.rulesDir ?? dirname(options.file);
    const annPath = options.annotations ?? [join(rulesDir, '.inspector-annotations.json')].find((p) => existsSync(p));
    if (annPath !== undefined) {
      if (!existsSync(annPath)) return { code: 1, out: [], err: [`标注文件不存在：${annPath}`] };
      let ann: Annotations;
      try { ann = JSON.parse(stripBom(readFileSync(annPath, 'utf8'))) as Annotations; }
      catch (e) { return { code: 1, out: [], err: [`annotations 解析失败：${annPath}（${e instanceof Error ? e.message : String(e)}）`] }; }
      if (!ann || typeof ann !== 'object' || Array.isArray(ann)) {
        return { code: 1, out: [], err: [`annotations 格式错误：${annPath}（须为 JSON 对象，如 {"文件名":{"cognitive":true,"x3Done":true}}）`] };
      }
      const a = ann[basename(options.file)];
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        const explicit: ScoreOptions = {};
        if (options.triCheck) explicit.triCheckDone = true;
        if (options.type) explicit.type = options.type;
        if (options.cognitive) explicit.cognitive = true;
        opts = { ...a, ...explicit, cognitive: explicit.cognitive || a.cognitive };
      }
    }
    const r = scoreFile(options.file, rulesDir, { ...opts, base }, terms);
    const summary = r.level === undefined
      ? `得分 ${r.total}/${r.max}（${Math.round(r.rate * 100)}%，合集无级别）`
      : `得分 ${r.total}/${r.max}（${Math.round(r.rate * 100)}%，${r.level}）`;
    return { code: 0, out: [options.json ? JSON.stringify(r, null, 2) : summary], err: [] };
  }

  const dir = options.rulesDir ?? join(options.root, 'rules');
  if (!existsSync(dir)) return { code: 1, out: [], err: [`目录不存在：${dir}（--root 指向项目根，规则库 = <root>/rules）`] };
  if (options.baseline && !existsSync(options.baseline)) return { code: 1, out: [], err: [`基线文件不存在：${options.baseline}，先不带 --baseline 跑一次`] };
  let annotations: Annotations | undefined;
  if (options.annotations) {
    if (!existsSync(options.annotations)) return { code: 1, out: [], err: [`标注文件不存在：${options.annotations}`] };
    try {
      annotations = JSON.parse(stripBom(readFileSync(options.annotations, 'utf8'))) as Annotations;
      if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) throw new Error('非对象');
    } catch {
      return { code: 1, out: [], err: [`标注文件解析失败：${options.annotations}（须为 JSON 对象，如 {"文件名":{"type":"模式门控","modeChecks":{...}}}）`] };
    }
  }
  let out: ScoreDirResult;
  try {
    out = scoreDir(dir, terms, { baselineFile: options.baseline, triCheckDone: options.triCheck, type: options.type, cognitive: options.cognitive, annotations, base, annotationsPath: options.annotations });
  } catch (e) {
    return { code: 1, out: [], err: [`评分失败：${e instanceof Error ? e.message : String(e)}`] };
  }
  const summary = out.level === undefined
    ? `共 ${out.totals.files} 文件 / ${out.totals.lines} 行 / ${out.totals.chars} 字符（无已评级文件，不报 dir 得分率）`
    : `共 ${out.totals.files} 文件 / ${out.totals.lines} 行 / ${out.totals.chars} 字符，平均得分率 ${Math.round((out.rate ?? 0) * 100)}%（${out.level}）`;
  return { code: 0, out: [options.json ? JSON.stringify(out, null, 2) : summary], err: [] };
}
