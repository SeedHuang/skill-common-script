# scs

常用脚本 CLI 工具：审查账本取数与核对、`rules/` 与 `skills/` 的可观察判据自检、判据引擎校验。

- 运行时：Node.js ≥ 20
- 技术栈：TypeScript + Commander + Inquirer + Vitest
- 全局命令：`scs`

## 安装

```bash
npm install
npm run localG        # 构建并全局安装（npm run build && npm install -g .）
scs --version         # 验证安装
```

`localG` 会先编译到 `dist/` 再全局安装；`package.json` 的 `files` 只发布 `dist/`，跳过构建会装出一个没有可执行代码的空壳。

卸载：`npm uninstall -g skill-common-script`

## 快速开始

```bash
scs help              # 查看全部脚本的详细用法
scs help ledger       # 查看单个命令的详细用法
scs time              # 取当前时间
```

## 命令一览

| 命令 | 用途 |
| --- | --- |
| `scs help [command...]` | 查看全部或单个脚本的详细用法 |
| `scs time` | 输出当前时间 `HH:MM:SS`（账本取数用） |
| `scs check observable` | 扫描 `rules/` 与 `skills/`：主观词命中且无可观察标记即失败 |
| `scs check criteria-engine` | 校验判据引擎：schema / testcase / 渲染物一致性 + 分层预算 |
| `scs ledger gate <progressPath>` | 核对 `progress.md` 轮次账的起止与耗时 |
| `scs ledger numbers <dir>` | 核对账本数字：算术自洽 / 卡片实数 / 族号计数 / 副本禁令 |

退出码统一约定：

- `0`：通过，无不合格项
- `1`：有不合格项
- `2`：用法错误或文件读取失败（`time` 恒为 0）

## scs help

```bash
scs help                  # 全部脚本、参数、选项、退出码
scs help ledger           # 单个命令（含子命令）
scs help ledger gate      # 按两级路径定位子命令
```

输出内容直接从命令注册信息生成，新增命令后无需再改帮助文案。

## scs time

```bash
scs time
# 14:32:07
```

输出本地时区的 `HH:MM:SS`。用途是给审查账本取「开始/结束」时间，避免凭感觉填写。

## scs check observable

扫描 `<root>/rules/**/*.md` 与 `<root>/skills/**/*.md`，判定口径：

- 跳过标题行、代码围栏内的内容
- 某行命中主观词（`terms`），且它所在的「最小语义块」内没有任何可观察标记（`markers` 的正则）→ 记为命中
- 最小语义块：bullet 及其缩进子块，或连续段落，或紧随的连续表格
- `rules/observable-criteria.md` 是规则文档，单独走「不得复制词表」检查，不参与上述判定

```bash
scs check observable
scs check observable --json
scs check observable --root ./retro-skill
scs check observable --terms ./tools/quality/observable-terms.json --exempt ./tools/quality/observable-exempt.json
```

| 选项 | 说明 |
| --- | --- |
| `--json` | 以 JSON 输出报告（结果在首行） |
| `--root <dir>` | 扫描根，默认当前目录 |
| `--terms <file>` | 词表，默认 `<root>/tools/quality/observable-terms.json` |
| `--exempt <file>` | 豁免清单，默认 `<root>/tools/quality/observable-exempt.json` |
| `--check` | 兼容旧调用（本命令默认即检查模式） |

前置条件不满足时 exit 2，包括：扫描根不是目录、`rules/` 或 `skills/` 缺失、扫描到 0 个 `.md`、未显式指定 `--root` 时 `skills/` 下 0 个 `.md`、词表/豁免 JSON 结构非法、正反例样例不成立、豁免锚点不唯一。

输出示例：

```
rules/example.md:12  term=清晰  无结构化可观察标记
[stale] rules/example.md  contains 未命中：旧锚点
check-observable fail（命中 1 行 / stale 1 条）
```

通过时输出 `check-observable ok`；前置失败输出 `check-observable error（P-x: 原因）`。

词表结构：

```json
{
  "terms": ["清晰"],
  "criterionTerms": ["可观察"],
  "markers": [{ "kind": "path-line", "pattern": "path:line" }],
  "samples": [{ "term": "清晰", "positive": { "input": "…" }, "negative": { "input": "…" } }],
  "sharedPhrases": ["共享片段示例"]
}
```

豁免清单结构（`reviewed` 不得早于 2026-01-01，`path + contains` 必须唯一且能命中）：

```json
{
  "entries": [
    { "path": "rules/example.md", "contains": "仅此一行的锚点", "reason": "历史保留", "reviewed": "2026-05-01" }
  ]
}
```

## scs check criteria-engine

```bash
scs check criteria-engine
scs check criteria-engine --root .
scs check criteria-engine --engine tools/docgen/builders/rules \
  --data tools/docgen/dsl/rules --projection tools/docgen/builders/rules \
  --terms tools/docgen/dsl/rules/observable-terms.json \
  --surface skills --surface tools/docgen
```

默认按项目内的 `<root>/tools/quality/criteria-engine/` 取引擎模块（`schema.mjs`、`interpreters.mjs`、`rules.mjs`）、判据数据（`*.json`、`*.testcase.json`）与渲染投影（`*.<ext>`）；判定逻辑不复制到 CLI 里，全部委托给该目录。目录是参数而不是写死的常量——引擎模块、判据数据、渲染投影三者可以分开放。

| 选项 | 说明 |
| --- | --- |
| `--root <dir>` | 项目根，默认当前目录 |
| `--engine <dir>` | 引擎模块目录，默认 `tools/quality/criteria-engine` |
| `--data <dir>` | 判据数据目录，默认 = `--engine` |
| `--projection <dir>` | 渲染投影目录，默认 = `--engine` |
| `--terms <file>` | 共享片段词表，默认 `tools/quality/observable-terms.json` |
| `--surface <dir>` | 承接面扫描目录，可重复；默认 `skills` + `tools/quality` |

校验内容：

- 每条判据 JSON 的 schema，以及它对应的 testcase 是否存在、是否通过
- 渲染物逐字节比对：`<ruleId>.<ext>` 与 `rules/<ruleId>.md`，手改即红、缺件即红
- 分层预算：单条 rule 非空白字符 100–500，条数 ≤ 9，总量 ≤ 26513
- 结构闸：rule 正文需含「触发 / 义务 / 例外 / 判定动作」四件
- 承接面目录（默认 `skills/**` 与 `tools/quality/**`）不得出现 `sharedPhrases` 中的共享片段

输出首行固定为 `判据 N 条 / 绿 M / 红 K`；末行为 `criteria-engine ok` 且 exit 0 才算通过。有问题时逐条打印 `[criteria-engine] <file> <code>：<detail>` 并 exit 1；引擎加载失败 exit 2。

## scs ledger gate

```bash
scs ledger gate ./docs/reviews/round-1/progress.md
```

在 `progress.md` 中找表头形如 `| 轮 | 起止 | 耗时 | … |` 的轮次账表，逐行核对：

- 起止：`HH:MM~HH:MM`、`HH:MM:SS~HH:MM:SS`，或显式「未取数」；整格留空、只填一端、格式非法 → `[FAIL]`
- 耗时：`N m` 或显式「未取数」；留空 → `[FAIL]`
- 软提示 `[WARN]`：出现「未取数」、时间带加粗/括号注释、轮次账行数与 `## 第 N 轮` 小节数不一致

| 退出码 | 含义 |
| --- | --- |
| 0 | 无 FAIL（可能仍有 WARN） |
| 1 | 有 FAIL |
| 2 | 找不到轮次账表、表头缺「起止」或「耗时」列、数据行为 0、文件读不到 |

示例：

```
[WARN] 第 2 轮：耗时标「未取数」（诚实记录合法，但不该成为常态）
[FAIL] 第 3 轮：起止只填了一端「14:02~」（起/止必须成对，缺的那端标「未取数」）
```

## scs ledger numbers

```bash
scs ledger numbers ./docs/reviews/round-1
```

目录内 `progress.md` 必需，`problems.md` / `cards.md` 可选（缺失会 WARN 并跳过依赖它的检查）。缺 `progress.md` 直接 exit 2，不会静默通过。

核对项：

- C1 算术自洽：`N 个问题（P0 a / P1 b / P2 c）` 类声明需满足 `a + b + c = N`
- C2 卡片实数：只校验同时含「卡级」与「张」的声明，与 `cards.md` 中 `#### XX-1-01 【P0】` 标题的真实计数比对；卡片标题缺级别标记时跳过（避免假红）
- C3 族号计数：`- **P1 族 15 个**：F3 …；F17 …` 中声明的个数需与列出的不同 `F` 编号数一致（候选段不计入）
- C4 副本禁令：`## 第 N 轮` 小节内不得重复写该轮总量或分布（如「共 12 张」「12 张（卡级 P0 3 …）」「归并：P0 …」）

| 退出码 | 含义 |
| --- | --- |
| 0 | 无 FAIL |
| 1 | 有 FAIL |
| 2 | 目录不存在、缺 `progress.md`、未传目录 |

## 开发

```bash
npm run dev -- time             # 用 tsx 直接跑源码，`--` 后是 CLI 参数
npm test                        # vitest run，单次
npm run test:watch              # 监听模式
npm run typecheck               # tsc --noEmit
npm run build                   # 编译到 dist/
npm run localG                  # 构建 + 全局安装
```

新增脚本的步骤：

1. 在 `src/commands/` 下新建模块，导出 `registerXxxCommand(program: Command)`，把判定逻辑拆成纯函数便于单测
2. 在 [src/program.ts](src/program.ts) 中注册
3. 同目录补 `*.test.ts`；`scs help` 会自动收录新命令

## 目录结构

```
src/
  index.ts                  # 入口（shebang + parseAsync）
  program.ts                # 命令注册与版本号
  commands/
    help.ts                 # scs help
    time.ts                 # scs time
    check.ts                # scs check observable / criteria-engine
    check-observable.ts     # 可观察判据扫描实现
    check-criteria-engine.ts# 判据引擎校验实现
    ledger.ts               # scs ledger gate / numbers
    ledger-gate.ts          # 轮次账完整性
    ledger-numbers.ts       # 账本数字一致性
  lib/
    markdown.ts             # 代码围栏遮罩
```
