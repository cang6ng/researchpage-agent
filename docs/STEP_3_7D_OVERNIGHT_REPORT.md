# ResearchPage — Step 3.7D Overnight Recovery Report

日期：2026-10-09。仓库：`D:/SomeProjects/AgentCompetition2026`。
起点 HEAD：`37b2c81f9c4b76bf26d7fe20119bebc146d2bd17`（与预期一致）。
本报告记录本轮「Overnight Recovery & Product Completion Goal」的实际完成情况、证据与未完成项。

本轮**不 Push**。工作全部停在本地提交。

---

## 1. 完成的 Phase

| Phase | 目标 | 结果 |
| --- | --- | --- |
| 1 P0 Diagnose | 建立精确失败诊断与反例 | 完成 |
| 2 P0 Repair | Report Schema / Prompt / Parser / Q08 / 恢复状态 / 安全错误分类 | 完成 |
| 3 P0 Acceptance | 离线通过 + 真实 DeepSeek 报告入库 + HTML/PDF | 完成（真实报告已入库） |
| 4 P1-A Settings | 研究预算、检索来源、能力清单、MinerU 状态 | 完成（模型网页配置未做，见 §7、§11） |
| 5 P1-B UX | Intent 对话重做、Research Progress 摘要优先 | 完成（浏览器实测） |
| 6 Final Gates | 自动化、真实浏览器、文档、本地提交 | 完成 |

P0 优先于 P1 的顺序被遵守：报告生成能力在动设置与 UI 之前已经修好并完成真实验收。

---

## 2. 每项 Sol Finding 的关闭状态

| 编号 | Sol 的发现 | 状态 | 证据 |
| --- | --- | --- | --- |
| B01 | 表格 schema / 模型输出 / 解析器不一致，静默丢正文 | **CLOSED** | §3.1；`packages/plugin-research/tests/report-table-contract.test.ts` 10 例；真实报告的比较表 6 列 × 3 行、0 空格 |
| B02 | 报告恢复没有独立状态与有效诊断 | **CLOSED** | §3.2、§3.3；`apps/research/tests/report-recovery-api.test.ts` 5 例；四态投影 + 安全失败分类 |
| M01 | Q08 把「不能…更便宜」判成肯定排名 | **CLOSED** | §3.2；`packages/plugin-research/tests/report-ranking-lexicon.test.ts` 9 例 |
| M02 | 网页不能设置模型 | **未做 → OPEN（PARTIAL）** | §7、§11：本轮明确不做模型网页配置，设置页如实标注「暂未实现」，未提供假控件 |
| M03 | 新任务预算只能取固定常量 | **CLOSED** | §4；`packages/plugin-research/tests/product-settings.test.ts` 11 例 + `apps/research/tests/settings-api.test.ts` 8 例 |
| M04 | 来源与集成静态旧文案；MinerU 限制说明不一致 | **CLOSED** | §4；能力清单由服务端派生，9 条含 3 条「暂未实现」；MinerU 面板写明 10 MiB 与 Flash 20 页 |
| M05 | Intent 区分度弱、确认编辑区挤压输入 | **CLOSED** | §5.1；浏览器实测（1440/1366/1100） |
| M06 | Progress 默认展示十条日志、口径混用 | **CLOSED** | §5.2；`apps/research/tests/research-progress-view.test.ts` 15 例 |
| N01 | 设置页无 runtime 时候选数兜底为 6，实际为 5 | **CLOSED** | 该处已由服务端设置取代；设置页读 `/api/research/settings`，不再用前端兜底常量 |
| N02 | 报告空态引导用户判断材料是否足够 | **CLOSED** | §5.3；报告空态与失败态改由 `reportGeneration` 四态驱动，默认动作是「使用现有资料恢复报告」 |

---

## 3. P0 最终根因及证据

### 3.1 报告格式损坏（已证实，根因）

**根因**：解析器把真实的数组行读成了空行。

从用户数据目录 `.scratch/my-run-data`（**只读**）的实际 `save_report` 工具调用记录中提取到原始参数：
`rows` 每行是 6 个字符串的数组，`["HippoRAG 2", 第 1 格 … 第 5 格]`；`columns.length = 5`。
旧 `normalizeBlock` 对每行执行 `asRecord(row)`，数组不是对象 → 返回 `undefined` → `entry["cells"]` 不存在 → `cells: []`。
验证：修复前持久化草稿就是 4 行 `{"cells":[]}`，正文全部丢失；Q03 因此报 20 个空白单元格。

**修复**：`packages/plugin-research/src/tools.ts` 用完整的 `readTable` 取代静默降级：
- 规范形状 `{columns, columnDimensions, rowSubjects, rows[].cells[{text, claimIds}]}`；
- 兼容两种**宽度确定**的数组行（`columns.length + 1` 带对象名、`columns.length` 纯格子），前者的对象名必须与该行声明的 `rowSubjects` 指向同一对象（按 id 或任务卡上的名称交叉验证），不匹配就按字段路径拒绝；
- 其它宽度、缺失 `cells`、空白单元格、未知 block 类型一律返回精确字段路径与可修复指引，并且**不保存该节**；
- 读侧（`artifact.ts` / `report.ts`）对存储中缺 `cells` 的旧行做容错：算作空行由 Q03 拒绝，而不是让工作台整页 500。

**证据**：`report-table-contract.test.ts` 用**真实记录的原行文本**做 fixture；真实模型产出的报告 `rep_818ea3ad126f548b` 比较表 6 列 × 3 行、每格有内容、0 空白。

### 3.2 后续 INTERNAL_ERROR（已证实，根因）

**根因**：模型服务端拒绝每一次请求 —— `HTTP 402 Insufficient Balance`。

证据链：
1. 用户数据里 2026-10-09 02:33:45 之后**每一种阶段**（research / report / synthesis）都在 0.42–0.59 秒失败；此前 02:33:31 的 gap 阶段在 13.61 秒成功。失败与阶段类型无关 → 不是报告特有缺陷。
2. 失败 run 的 `session_events` 只有 `turn/start`、`message/user`、`turn/end(error)`，没有任何 assistant / tool 事件 → 模型调用本身失败。
3. Host 把底层错误按设计遮蔽（`packages/host/src/state.ts` 的 `unknownFailure()`）；`run.ts` 的 `drainRun` 用 `catch {}` 吞掉 runtime 异常，`coreTerminal` 之外还有一条 `finalizeRun → failRun` 路径 —— 所以原因在 Host 侧不可见。
4. 本轮直接向 `https://api.deepseek.com/chat/completions` 发一次探测：**HTTP 402 / `Insufficient Balance`**。
5. 07:00 之后再次探测：**HTTP 200**，账户已充值；随后真实端到端运行完整成功（§6）。

结论：这不是产品代码缺陷，是**凭据所属账户余额耗尽**。本轮的修复是让这个原因**可见且可操作**，而不是掩盖它。

### 3.3 安全错误分类

新增 `apps/research/src/server/model-failures.ts`：
- 在应用自己的 ModelClient 包装处（唯一还能看到原因的地方）把适配器的固定措辞分类为闭集：`context_build` / `model_request` / `tool_schema` / `validation` / `storage` / `runtime_unknown`，并给出固定 `code`（如 `model_credential_or_quota`）与操作建议；
- 包装处同时覆盖**同步抛出**（`client.stream(...)` 也放进 try）；
- 一个按 session 键控、有 TTL 与容量上限的 ledger，把分类交给发起该阶段的 runner；
- 到达浏览器/日志的只有安全码与读者语言，**没有** provider 正文、状态行、请求头、凭据、URL 或堆栈（`settings-api` 的密钥泄漏反例测试同样守住了设置文档）。

真实复现：阶段失败时任务里写的是「模型服务拒绝了这次请求（常见原因：凭据无效、账户余额或配额用尽、模型名不可用）。请在设置里检查模型凭据与账户余额…」，而不是「没有保存有效报告」。见 `report-recovery-api.test.ts` 的 E 例。

---

## 4. GOAL 2 — P1-A 设置

- **研究预算**：`GET/PATCH /api/research/settings`，服务端按声明区间校验（searches 1–30、candidates 1–20、reads 1–50、gapRounds 0–5、deadlineMs 60 000–1 800 000），**拒绝而非四舍五入**；写成功才发布新 revision，带 `expectedRevision` 的并发写冲突返回 409 且不改动任何字段。
- **冻结时机**：`structure.ts createTask` 复制当时的默认值；此后改默认值不动已有项目，**失败重试**也保留该项目自己的预算。测试覆盖「新项目用新值 / 旧项目不变 / 重试不变」。
- **持久化与重启**：`research.db` 新增 `product_settings` 表（单行 + revision）。浏览器实测：保存 maxSearches=6→9 → revision 0→1 → **重启进程后仍是 revision 1 / 9**。
- **检索来源**：设置真的改变检索行为 —— `search_sources` 每次读取配置的顺序（`service.retrievalProviders()`），arXiv → OpenAlex 的回退语义不变；**不允许关掉全部来源**（那会承诺做不到的研究）。
- **能力清单**：由服务端派生而非静态文案。9 条，逐条给出 implemented / configured / status（`integrated` / `reachable` / `unreachable` / `not_configured` / `not_checked` / `not_implemented`）。已实现项包括 arXiv、OpenAlex、HTML 正文读取、Markdown 上传、PDF/DOCX 上传与转换、用户附件转研究来源；**未实现项如实列出**：远程 PDF 自动解析、其它搜索引擎、通用 MCP 平台。Sol 指出的「本地上传未接入 / PDF 解析未接入」两处过期文案已删除。
- **MinerU**：模式、Token 是否配置、真实限制（**所有模式共用 10 MiB 上传上限**；Flash 20 页；Token 页数未验证）、第三方在线解析提示、以及「tools/list 成功 ≠ Token 或额度已验证」。readiness 由「检查」按钮显式触发；**页面加载不再探测**（探测会真的起一次子进程，不该由读设置触发）。
- **模型**：见 §7 —— 本轮**没有**实现网页模型配置，页面如实标注「暂未实现」，并且**没有**提供任何会做无用功的控件。

---

## 5. GOAL 3 — P1-B 体验

### 5.1 Intent Discovery 对话

- 宽桌面（≥1280px）**两栏**：对话在左，方向确认卡独立在右（320–360px，sticky），不再把输入框挤到页面下方；窄屏回落单栏，方向卡用显式折叠按钮收敛（1100px 实测可见并可点）。
- 助手提问与正文分层：问题 17px/600，正文 13.5px；「为什么这样问」改为 `<details>` 默认折叠（浏览器实测折叠与展开）。
- 用户消息靠右气泡、助手靠左带身份；推荐回答仍只预填不发送；输入框固定在对话列底部（sticky）。
- 未改 Intent API、version 校验、草稿恢复与 Task 绑定语义；未改对话状态机。

### 5.2 Research Progress 摘要优先

- 默认只显示：真实阶段、当前动作、**找到候选 / 已读来源 / 尚未解决 / 研究轮次 / 已用时 / 最近活动**。
- 完整 Activity Log **默认折叠**（「查看活动详情」），可展开为按时间或按类型（检索 / 读取 / 补查 / 评估 / 报告 / 校验）两种视图。诊断计数（provider 成功/失败、读取状态分布、历史阶段）随详情一起出现。
- 没有百分比、没有进度条、没有 ETA；研究预算被明确写成「这是研究动作的预算，不是报告完成时间；完成时间目前无法准确预估」。
- 报告失败时先给「使用现有资料恢复报告」，把「重新研究（会重新检索与读取）」标成次级动作并说明差别。
- 1366 / 1440 / 1920 与窄屏均已实机检查。

### 5.3 报告按钮与空态

一个按钮三种诚实说法：报告已存在（打开）/ 有草稿或失败（**使用现有资料恢复报告**）/ 尚未开始（撰写报告）；进行中禁用而不是再发一次。失败与草稿状态在按钮旁显示分类后的原因与建议（N02 关闭）。

---

## 6. 真实验收结果（P0 强制验收 A–J）

运行方式：`apps/research/dist/research-server.mjs --port 8899 --data .scratch/overnight-goal-20261009/real-run`（隔离目录、隔离端口；未触碰用户 8791 服务与 `.scratch/my-run-data`），真实 `deepseek/deepseek-flash`，真实 arXiv/OpenAlex，驱动脚本 `.scratch/overnight-goal-20261009/real-acceptance.mjs`。

| 项 | 结果 |
| --- | --- |
| A 真实模型数组表格不丢数据 | PASS —— 真实报告比较表 6 列 × 3 行、0 空格；契约测试用真实原行做回归 |
| B 规范表格 + 完整 claim/evidence 通过 | PASS —— `validation.ok = true`，12 项质量检查全过 |
| C 证据不足但有明确缺口可合法生成 | PASS —— 报告含多处「证据不足 / 有限可比 / 不可直接比较」单元格与 gap callout，仍通过校验 |
| D 捏造引用 / 跨任务 evidence / 无依据排名仍被拒绝 | PASS —— truth-boundary 17 例、artifact-quality 19 例、ranking 9 例 |
| E 恢复不重新执行全部 Research | PASS —— `report-recovery-api` E 例：恢复后 `usage.searches` 与来源数不变，attemptId 改变 |
| F 重复点击不并发创建报告 | PASS —— 第二次 POST 返回 409 `report_busy` |
| G 已发布 Report / Proposal / Frozen 不被覆盖 | PASS —— 409 `report_exists` + 指向 Edit；existing editing/frozen 测试全通过 |
| H 真实 DeepSeek 成功生成并保存一份新报告 | **PASS** |
| I 浏览器可打开、HTML 正常、PDF 实际导出 | **PASS** |
| J 检查真实 reportId / 正式存储 / Report Contract | **PASS** |

**真实产物（唯一 ID）**：

- taskId：`task_d7a11775375d371a`
- sessionId：`17b2ea7c-44b0-4f83-8a1d-aa952cdb06eb`
- **reportId：`rep_818ea3ad126f548b`**（`research.db` 的 `reports` 表有该行）
- 报告标题：GraphRAG 与 LightRAG 值不值得加：中小规模静态语料、跨文档桥接型多跳问答上的索引成本—效果权衡
- 结构：8 个 section / 9 条 claim / `validation.ok = true` / 12 项质量检查
- 研究资产：13 个来源、31 条证据（arXiv 直连超时后被 OpenAlex 回退救回，过程写在活动日志里）
- HTML：`GET /api/research/reports/rep_818ea3ad126f548b/html` → **200，26 632 字节**，含 `<table>` 与引用编号
- PDF：`POST /api/research/tasks/task_d7a11775375d371a/export` → **200 / ok**，exportId `exp_96194710990b7ff8`，revisionId `rev_5542c9061ddecfe9`，**576 830 字节**
- 落盘文件：`task_d7a11775375d371a-rep_818ea3ad126f548b-R1.pdf`（576 830 B）与同名 `.pdf.html`（43 149 B）

真实浏览器（IAB，1440 / 1366 / 1100）：首页、项目研究页、设置（研究 / 来源与集成）、方向澄清页均实际打开并截图核对。

---

## 7. 模型与 MinerU 配置实际支持范围

| 能力 | 实际状态 |
| --- | --- |
| 模型（provider / model） | **只读**。由服务端启动配置与环境变量决定；页面显示当前模型并标注来源，明确「网页暂不支持修改」。**未实现**保存、密钥持久化、连接测试与 `/models` 枚举。 |
| 凭据 | 只在服务端环境变量；不写入数据库、日志或页面（有反例测试）。 |
| MinerU 模式 | 只读显示（Flash / Token），由服务端配置决定；**页面上不可改**。 |
| MinerU Token | 不经过页面；只注入转换子进程。 |
| MinerU 在线可用性 | 由「检查」按钮显式探测（真实子进程），显示已探测可用 / 服务不可达 / 尚未检查。 |
| MinerU 限制 | 10 MiB 上传（所有模式）、PDF/DOCX、Flash 20 页、Token 页数未验证；文案明确「配置 Token 不会提高上传上限」。 |

即 Sol 的 M02（网页模型配置）与 2.4 的 Token 网页写入**未完成**；本轮把「不能改的东西如实说清」做完了，没有用不可用的控件冒充能力。

---

## 8. 研究预算是否真正生效

**是**。三层证据：
1. 服务端校验与拒绝（区间、非整数、越界 → 409，revision 不动）；
2. 创建时冻结：新项目拿到保存值（API 测试从 HTTP 走到任务对象断言 `budget`），旧项目与失败重试保持原值（service 测试）；
3. 重启后仍生效（浏览器保存 → 进程重启 → revision 1 / maxSearches 9）。

检索来源开关同样有真实生效路径：`search_sources` 每次读取配置的顺序；关闭全部来源被拒绝。

---

## 9. Intent 与 Research UI 改动

见 §5。要点：Intent 页两栏（对话 / 方向确认）、提问与理由分层且理由默认折叠、输入框固定在对话列；Research 页摘要优先、活动详情默认折叠并按类型分组、无百分比与 ETA、失败优先恢复报告。

---

## 10. 测试结果、失败与 SKIP

- `pnpm typecheck`（三个 project：根 / web browser / research browser）：**PASS，0 错误**。
- `pnpm build:research`：**PASS**。
- 离线全量 `npx vitest run`：**2240 passed / 24 skipped / 0 failed**（195 个文件，6 skipped）。
  串行复核 `npx vitest run --no-file-parallelism`：**2240 passed / 24 skipped / 0 failed**，两次结果一致。
- 本轮新增测试文件：`report-table-contract`(10)、`report-ranking-lexicon`(9)、`prompt-budget`(3)、`report-recovery-api`(5)、`report-recovery-view`(5)、`product-settings`(11)、`settings-api`(8)；并更新 `edit-preflight`、`artifact-view`、`trust-ux`、`research-progress-view`、`intent-view` 到新契约。
- **SKIP（如实记录）**：
  - 真实 MinerU OCR：本轮**没有**重新执行（历史验收保留；未改动转换链路）。
  - 真实 arXiv 直连：观测到超时（20s 无响应），由 OpenAlex 回退成功；这不是产品缺陷，但也没有做到「arXiv 直连可用」。
  - 模型网页配置、MinerU Token 网页写入：未实现，未测试。
- **已知 flaky（与本次改动无关，有实测特征）**：`apps/web/tests/shell-*.browser.test.ts` 在**整仓并行**跑时偶发失败——
  本轮三次并行运行各失败 1 例，且三例分属三个不同文件（`shell-m5-approval` 的拒绝分支、`shell-m5-sessions` 的 stale rename、`shell-browser` 的刷新后恢复选择），
  失败点都在真实 Chrome（CDP）的等待上。旁证：四个 `apps/web` 浏览器测试文件**一起单独跑 44/44 通过**；串行跑整仓 2240/2240 通过；`fake` 模型不受影响。
  这台机器上同时在跑的还有用户自己的 8791 / 4310 两个服务。没有证据指向本轮改动：本轮没有修改 `apps/web`、Agent Core、Host、Protocol 或 Client。
- **改动过的既有断言（不是删测试换 PASS）**：
  - `edit-preflight.test.ts` 两例：空白表格现在在**读取阶段**就被按字段路径拒绝（更早、更精确），因此不再出现中间态 `proposal_invalid`；「一份会到读者手里带空白格的表格永远不会成为待确认提案」这一承诺仍在断言中，同一套「一次修复后停止」的状态机由旁边的 obligation-losing 用例继续覆盖。
  - `research-progress-view.test.ts`：断言从「默认显示最近十条」改为「默认折叠 + 可展开 + 可按类型分组 + 摘要计数准确」，与 Sol 的要求一致。

---

## 11. 已知限制及剩余风险

1. **模型网页配置未实现**（Sol M02 / 2.1）。当前只能靠服务端配置与环境变量；没有保存/生效/连接测试/枚举，也没有 DPAPI 密钥持久化。这是本轮最大的未完成项。
2. **MinerU Token 网页写入未实现**（2.4）。模式与 Token 仍是启动快照，改动需要重启服务。
3. **arXiv 直连在当前网络下超时**，研究依赖 OpenAlex 回退。产品行为正确（如实记录并回退），但「两个来源都可用」这一条在本机不成立。
4. **真实模型的报告质量仍受模型本身限制**：本轮验收的这份报告通过了全部 12 项契约，但例如「矩阵 5/18 个比较项已核对」这样的覆盖水平由模型实际读了多少材料决定，产品只能如实反映。
5. **`reportGeneration` 是可选字段**：老任务没有它，投影按「有报告=validated / 无报告=idle」读取，不做回填；如果未来需要历史报告尝试的统计，需要单独迁移。
6. **系统提示词只剩 ~31 字节余量**（8161 / 8192）。已加 `prompt-budget` 守卫测试，但下一次往 `RESEARCH_SYSTEM_PROMPT` 里加句子会直接让服务无法启动 —— 需要时应先压缩，而不是放宽限制（Host 的 schema 属于冻结底座）。
7. **`pnpm typecheck` 不覆盖新加入的浏览器测试文件**需要显式登记（本轮已登记 `report-recovery-view.test.ts`）；新增同类文件时容易漏。

---

## 12. Commit / HEAD / Working Tree

本轮本地提交（起点 `37b2c81`）：

| commit | 说明 |
| --- | --- |
| `1c2c3d2` | `fix(research): read the comparison tables real models write` |
| `1c3714c` | `fix(research): stop reading a refused ranking as an asserted one` |
| `e220cd1` | `fix(research): recover a failed report without re-researching` |
| `7a56e2c` | `feat(research-ui): offer to resume the report, not to start over` |
| `2a9a961` | `feat(research): let the settings page change what it claims to change` |
| `9cbfd12` | `refactor(research-ui): make the progress a status and the decision a decision` |

- **HEAD：`9cbfd126f4c6151090e8d97948ae23b6248907e6`**（本报告与 handoff / review 追加会再产生一个 `docs` 提交）。
- Working tree：除 `.scratch/`（gitignored）外无未提交改动。
- **未 Push**。未 reset / rebase / amend 任何已发布提交。
- 提交内容检查：不含 API Key / Token、不含 `.scratch` 数据、不含数据库、不含截图与用户原始文档、不含临时日志。

用户数据安全：`.scratch/my-run-data` 全程**只读**（`sqlite3` 以 `mode=ro&immutable=1` 打开、`node:sqlite` 以 `readOnly` 打开，复制到隔离目录后再做实验）；未重启、未修改用户 8791 服务。

---

## 13. 下一步最值得修复的三个问题

1. **网页模型配置（Sol M02）**：Provider/协议、Base URL、API Key、Model ID、连接测试、保存与重启恢复，saved vs effective 分离，Windows DPAPI 密钥存储，Base URL 的私网/重定向/跨站凭据校验。这是本轮唯一被明确跳过的大块，也是「用户能自己把产品跑起来」的最后一环。
2. **MinerU Token 的网页配置与 readiness 生命周期**（2.4）：显式 flash/token 模式、write-only Token、队列空闲时才允许改、清缓存、不 shutdown 模拟更新。目前改模式必须重启服务。
3. **真实检索来源的稳健性**：在本机 arXiv 直连超时的环境下，研究完全依赖 OpenAlex 回退。值得做的是把「来源可用性」做成设置页可观测的实测状态（最近成功时间 / 最近失败原因），并把 arXiv 的失败路径纳入常规真实网络 smoke，而不是等它再次以「研究拿不到材料」的形式暴露。

---

## 最终判定

- **REPORT DELIVERY: PASS** —— 真实 DeepSeek 生成并保存了新报告 `rep_818ea3ad126f548b`，8 节 / 9 claim / `validation.ok=true` / 12 项质量检查通过。
- **REPORT RECOVERY: PASS** —— 独立 attempt、四态区分、互斥、不覆盖正式报告、有界修复且不重复同一失败指令、优先恢复而非重新检索。
- **MODEL SETTINGS: NOT DONE** —— 网页模型配置未实现；页面如实标注，不提供假控件。
- **RESEARCH SETTINGS: PASS** —— 预算默认值可编辑、服务端校验、创建时冻结、旧任务与重试不变、重启后仍生效；检索来源开关真实生效。
- **MINERU SETTINGS: PARTIAL** —— 模式/限制/在线状态展示真实且（检查按钮）可探测；Token 与模式在网页上**不可写**。
- **INTENT UX: PASS** —— 两栏布局、提问与理由分层、理由默认折叠、输入框固定；API/version/确认语义未改。
- **PROGRESS UX: PASS** —— 摘要优先、活动详情默认折叠并可分组、无百分比与 ETA、失败优先恢复。
- **TYPECHECK / BUILD: PASS**。
- **OFFLINE TESTS: PASS** —— 2240 passed / 0 failed / 24 skipped。
- **REAL BROWSER: PASS** —— 首页、项目研究页、设置两节、方向澄清页在 1440 / 1366 / 1100 实际打开并核对；保存→重启→仍是保存值。
- **READY FOR CODEX REVIEW: YES**。
- **READY FOR DEMO: YES（限本机、限已验收范围）** —— P0 的硬门槛（真实报告生成并保存）已由真实模型通过。演示时若模型账户余额再次耗尽，界面现在会说明原因而不是「没有保存有效报告」。
