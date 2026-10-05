# ResearchPage — HANDOFF

## Baseline

- 比赛仓库：`D:/SomeProjects/AgentCompetition2026`（产品仓库称呼：`researchpage-agent`）。
- 起点 commit：`ebb3e7c28d84f825176b9842a0ec7f86c636ecb4`（`chore: bootstrap competition project from Every-DAgent Phase 4`）。
- Step 1 起点 commit：`cc279d927485dcb339d2b9a56e07cfd1eff1d4f6`（`chore: ignore the local research data directory`）。
- Upstream sealed baseline：`c5f97ba63f719ec81030746f3eb67fe7c538e01f`；见 [UPSTREAM_BASELINE.md](./UPSTREAM_BASELINE.md)。未修改 upstream，未引入 Phase 5。
- 实施依据：[COMPETITION_SPEC.md](./COMPETITION_SPEC.md)、`ResearchPage_Product_Redesign.md`（§6/§8/§17/§23）、`What Makes a Great AI-Native Research Artifact?`（§6/§11–13/§17）。

## Current Status（2026-10-06）

- **Step 3.5A（Editable Research Brief + Guided Planning）已完成**：未确认的 ResearchTask 本身就是可编辑的 **Research Brief Draft**；结构化 PATCH 与引导式（一次一问）两种交互写同一份草稿；确认时按最终草稿校验、冻结字段状态并重建矩阵；历史项目仍按只读返回。

- **Step 3（Frontend Product Redesign）已完成**：产品前端从「最小兼容」重写为 desktop-grade 研究工具——统一设计系统、Start/Library、Research Brief、Evidence Matrix、统一 Context Dock、原生 Report Studio（Editorial / Swiss 两套文档主题）、Source Workspace、Template Gallery、Settings；全部界面连接真实 API，浏览器 gate 逐项验收。

- **Step 2（Research Artifact Quality）已完成**：Technical Comparison v2 成为一个真实可执行的 Blueprint；报告由认知主线（问题 → 概念坐标 → 机制 → 条件化比较 → 综合 → 缺口）组织，六类 Claim Contract、可比性判断、维度覆盖与 Q01–Q12 质量契约都在程序侧可校验。
- 真实产物：GraphRAG 与 LoRA/QLoRA/DoRA 两个主题各用真实模型 + 真实 arXiv + 真实 Chrome PDF 各跑通一次（v2 报告 8/11 页、10–11 条 claim、6 条综合判断，Q01–Q12 全部 pass，仅有 informational warning）。

- **Feasibility 四项全部通过**（真实网络、真实模型，非 fixture）：A1 真实搜索（arXiv）、A2 真实读取 + Evidence、A3 HTML→PDF、A4 Plugin seam。
- **Vertical Product 可真实演示**：Topic → Task Card → 确认 → 真实检索/读取 → Evidence Matrix → 缺口定向补查（≤2 轮）→ 结构化报告 → HTML 预览 → PDF 下载 → 刷新重开。
- **Step 1（Research Editing Semantics）已完成**：Ask / Research / Edit 三种正式意图由应用签发 Action Grant 约束；Edit 产出待接受 Proposal；报告版本可冻结、导出只读冻结依赖包；矩阵状态不再由「有正文片段」直接升级为充分。
- 真实 Demo 两个主题此前均通过（真实模型 + 真实 arXiv + 真实 Chrome PDF）；Step 2 后又用新版各重跑一次（见「Current Status」与「Step 2 的验证入口」）。

## Step 2 新增（本次工作产物）

- **BlueprintSpec**（`packages/plugin-research/src/blueprint.ts`）：`technical-comparison-v2` 定义 purpose、cognitiveJourney、requiredQuestions、六个必需认知组件、比较维度候选、六类 claimRequirements、comparisonRules/evidenceRules、Q01–Q12 qualityChecks，以及 8 个 SectionSpec（每个带 cognitivePurpose / requiredQuestions / depth / budget）。任务卡里存的是从 blueprint 派生的章节列表，`blueprintId` 记在任务上：旧任务按 v1 规则校验，不会被新义务追责。
- **Claim Contract**（`claims.ts`）：claim 增加 claimType（fact/mechanism/comparison/performance/cost/synthesis/implication）、subjects、dimensions、conditions（scope/task/dataset/metric/baseline/setting/costStage/basis/comparability）、synthesis 标记。逐类规则：机制优先 primary/official 来源；比较必须覆盖每个被比较对象；性能排名要求 comparability=comparable 且条件齐全，声明不可比却排名会被拒绝；成本必须写阶段，混用 token 与延迟口径不得合成「更便宜」；综合判断必须绑定 ≥2 条来自 ≥2 个来源的证据；条件化建议必须写明条件，无条件推荐被拒绝。
- **Evidence Adequacy**（`deriveClaimAdequacy`）：从已保存证据与支持评估推导 adequate / limited / incomparable / conflicted / missing / unassessed，按对象逐项检查是否有直接、正文级的支持评估；与矩阵单元格状态同源但不同判据，不互相替代。
- **Artifact Quality validation**（`artifact.ts`）：Q01 frame、Q02 标题/摘要承诺、Q03 章节内容契约（含机制块的 input/intermediate/steps/output/tradeoff/failure）、Q04 概念坐标先于比较、Q05 比较表列维度与行对象、Q06 维度覆盖不得静默省略、Q07–Q10 claim contract 与综合判断、Q11 限制回到正文、Q12 默认投影；结果分 hard error 与 warning 并存入报告的 `validation.checks`。
- **报告结构投影**：新增 mechanism 块（结构化机制，无 Mermaid）；比较表声明 columnDimensions / rowSubjects；callout 可声明 dimensionIds；报告头部声明研究问题/读者/范围；默认 PDF 不再输出完整摘录，改为紧凑「核验索引」（引用号/来源/定位/读取范围），完整片段留在工作台核验视图；综合判断在正文标 `⟨综合判断⟩`。
- **生成策略**：报告写作拆成两段认知 pass——`report`（frame + claims + overview/mental-model/mechanism/representative）与 `synthesis`（comparison/synthesis/limitations + 综合 claims + finalize）。原因是底座单 run 12 步上限：六节加 claims 装不下；现在两段各自一次跑通（真实 Demo 5 个 stage 全部 completed，无 max_steps）。校验在综合阶段之前先做一次预检，未满足项作为 `outstanding` 随该次工具结果返回。
- **来源角色**：`read_source` 可提交 role（primary/official/independent-evaluation/survey/contextual/user-provided），用途只有 claim contract 校验，不产生任何 credibility 分数。
- **结构边界**：`save_report` 拒绝结构里没有的章节 id（空 id 亦然），避免出现无义务、无矩阵列、无目录指向的章节。
- **测试**：`packages/plugin-research/tests/artifact-quality.test.ts`（16 例：artifact 文档 §17.5 的十个验收场景 + adequacy 推导 + 条件化建议）；`editing-semantics` 增加结构 id 拒绝用例；`pipeline.e2e` 与 `editing-api` 的脚本模型按两段 pass 重写。离线全量 1669 passed / 0 failed；`pnpm typecheck` 三个 project 全过。

## 关键实现决定（Step 2）

- 校验失败与警告分开：`validation.checks` 记录每条 Q 规则的 result（pass/fail/warning/not_applicable），`problems` 阻止发布，`warnings` 随报告保存并显示在工作台。
- 旧报告与新规则解耦：没有 `blueprintId` 的任务沿用 v1 的「必需章节 + 引用真实」规则，老数据不会因为新义务而无法编辑或导出。
- 页数不是硬约束：card 的 lengthTarget 与各节 budget 作为写作预算写进阶段指令（实测把同一主题从 15 页收到 11 页），但 validator 不会因为页数拒绝报告。
## Step 3.5A 新增（本次工作产物）

本轮只解决一件事：**研究开始之前，用户必须能真正参与定义 Research Brief**。不做前端 redesign（正式 Structured / Guided UI 属于 STEP 3.5B）。

### Research Brief Draft（数据模型）

- **没有第二个数据模型**：`confirmedAt === null` 的 `ReportTask` 就是草稿。新增三个最小字段（`packages/plugin-research/src/domain.ts`）：`briefVersion`（整数，每次正式草稿变更 +1）、`briefFieldStates`（逐字段 `suggested | edited | confirmed`）、`briefUpdatedAt`；另加 `guideClosed`（引导结束的判定与理由）。字段名与状态类型集中在 `domain.ts`（`BriefFieldName` / `BRIEF_FIELDS`），因为它们是记录的一部分。
- **可编辑字段**（白名单，其余一律按名拒绝）：`topic / purpose / audience / subjects / dimensions / focus / exclusions / lengthTarget`。`purpose` 就是「研究问题/用途」的唯一 source of truth（没有另造 question 字段）；`topic` 仍是一句话主题。**不允许**通过 Brief 修改 `confirmedAt / status / budget / matrix / sources / evidence / blueprintId / run 状态`。
- **默认提案不变**：`propose_task` 仍然先给出完整默认方案（§4「不要 Empty Form」）。若同一份卡片被重复提议，服务端**不再**无条件 +1 版本（内容与矩阵形状一致时原样返回），避免模型在 card 阶段多次调用导致版本虚增。
- **报告结构仍由 Blueprint 派生**：`BriefView.reportStructure` 只读展示，不提供编辑；用户在 Brief 里改的是研究问题、对象、维度、范围、读者与关注点，不能把 Blueprint 变成任意 outline。

### 结构化编辑

- **`PATCH /api/research/tasks/:id/brief`**，输入 `{ expectedVersion?, patch }`（`patch` 也可直接展开为 body）。返回 `{ ok, brief, changedFields }`；`changedFields` 只包含本次真正提交的字段。
- **服务端负责**：白名单校验、normalization、**stable IDs**、字段状态、版本递增、矩阵同步。新增对象/维度**不要带 id**（由服务端按 `slugId` 生成并去重）；改已有的必须带它的 id，未知 id 直接拒绝（400）。
- **局部不完整是允许的**：`purpose` 清空、`subjects: []` 这类编辑会被接受，并在返回的 `brief.validation.problems` 里列出问题；**confirm 时才会被拒绝**（409，附带当前 brief）。malformed patch（未知字段、类型错、id 重复/未知、超出上限）直接 400，不会把任务置于无法修复的状态。
- **Blueprint 最低义务**（`BlueprintSpec.briefMinimums` = subjects ≥ 1、dimensions ≥ 3）：维度不能被编辑到 3 个以下，否则报告 validator 会失去比较对象；subjects 下限取 1（Technical Comparison 推荐 2–5，未硬编码成 3）。
- **结构性字段**（`subjects` / `dimensions`）的增删改会同步重建矩阵（见下）；若任务在未确认状态**已有实际读取的材料**（已读 source / evidence / assessment / report），结构变更与矩阵重建都会被拒绝（409），不静默删除研究材料。

### Guided Planning（一次一问）

- **问题由程序选题、模型写题**：新增 `guide` stage（`ResearchStage`）与 `propose_guide_question` 工具。程序按固定阶梯（purpose → audience → subjects → dimensions → focus → exclusions → lengthTarget）决定「下一件最值得确认的事」，**跳过用户已经决定的字段**，并在 5 个决策后停止（`GUIDE_DECISION_LIMIT`）；模型只负责措辞、`whyThisMatters` 和 2–5 个候选选项，也可以返回 `{ complete: true, reason }` 表示「默认已经足够具体，不值得再问」（§17 的跳过低价值问题）。
- **服务端校验**：`fieldTargets` 必须**正好**是程序指定的那一个字段（多字段问题本轮不支持）；`options` 必须 2–5 项；**每个选项必须带 `value`**——它是该字段的最小 patch，创建问题时就按同一套 normalizer 对着当前草稿验证过，`value` 只能包含 `fieldTargets` 里的字段。因此「选中一个选项」不是一个需要再猜一次的标签（§20）。
- **一次一问**：一个任务同时只有一个 `active` 问题；写新问题会把旧的置为 `superseded`。`allowFreeText` 固定为 `true`。
- **自由文本有声明式规则**（不是让模型猜）：文本字段（topic/purpose/audience/exclusions/lengthTarget）回答即取值；`focus` 按行/顿号/逗号切分；`subjects` 每行 `名称 | 说明`（同一行内也支持逗号分隔）；`dimensions` 每行 `名称 | 要回答的问题`。名称能对上现有对象时**保留其 id**。
- **答案路径与结构化 PATCH 完全同一条**：`applyBriefChange` 是两者唯一的写入口，validation / normalization / stable id / 结构性守卫 / 矩阵同步全部共用；区别只在字段状态（引导答案是 `confirmed`，结构化编辑是 `edited`）。
- **persistence**：`brief_guide` 表（`CREATE TABLE IF NOT EXISTS`）保存每条问题的 question / fieldTargets / options / `basedOnBriefVersion` / `basedOnFields`（目标字段取值的 hash）/ 答案（optionIds、freeText、appliedFields、`resultingBriefVersion`）。页面刷新后能回答「已经做过哪些决定」；不做长期对话记忆。active 问题在重启后可按需重新生成。

### Version / stale 语义

- 每次正式草稿变更（PATCH 应用、引导答案应用、confirm 冻结）`briefVersion +1`。
- PATCH / answer 支持 `expectedVersion`：不一致返回 **409 + 当前 Brief**（`stale: true`），客户端据此重新读取。**版本不一致不等于问题作废**：若该问题的目标字段没变，重新提交即可继续回答。
- **问题 stale 的判据是目标字段本身**：`basedOnFields` 的 hash 变了 → 该问题被置为 `superseded` 并返回 409「研究任务已更新，请获取新的问题」；结构化编辑改到某个活动问题的目标字段时，也会立即把它置为 `superseded`。
- 已回答的问题不能再回答（400），答案不会二次应用。

### Confirm 语义

- `POST /tasks/:id/confirm`（`service.confirmTask(taskId, { expectedVersion? })`）现在：**验证草稿完整** → 拒绝不完整的草稿（409 + 问题清单 + 当前 Brief，不启动 research）→ **冻结**（全部字段状态归一为 `confirmed`）→ 版本 +1 → **reconcile 矩阵**（`syncMatrix`：按最终 subjects/dimensions 生成，保留仍存在且已有工作的单元格；不保留任何 stale 单元格）。
- **矩阵建于 propose_task 时**（已核实，非假设）：`createTask → buildMatrix`；确认只做 reconcile。由于结构性 PATCH 已经同步矩阵，confirm 的 `matrixRebuilt` 在正常流程里是 `false`，只有面对矩阵与简报不一致的记录（老数据/外部改写）才会是 `true`——§13 要求的一致性由此得到保证，而不依赖「确认之前没人动过矩阵」。
- **确认即上锁**：PATCH brief → 409；`guide/next` → 409；`guide/answer` → 409。研究中途改方向仍属 Assistant Edit / 未来 Reframe，本轮不实现。

### API 汇总（本轮新增/变更）

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/research/tasks/:id/brief` | Brief（草稿或冻结记录）。已确认任务仍可 GET，`readonly: true` |
| `PATCH /api/research/tasks/:id/brief` | 结构化编辑；`{ expectedVersion?, patch }`；409 = 版本过期/已冻结/结构变更会破坏既有材料 |
| `POST /api/research/tasks/:id/brief/guide/next` | 生成下一个引导问题（202，一个问题一个 stage run）；已有活动问题直接返回（200，不重复花一次 run）；引导已结束返回 `complete: true` |
| `POST /api/research/tasks/:id/brief/guide/answer` | `{ questionId, expectedVersion?, optionIds?, freeText? }` → `{ brief, appliedFields, complete, nextQuestion }` |
| `POST /api/research/tasks/:id/confirm` | 基于当前草稿确认；拒绝不完整草稿（409） |
| `GET /api/research/tasks/:id` | bundle 新增 `brief`（随轮询一起下发，和矩阵/来源同一份状态） |

`BriefView` 含：taskId、confirmed、readonly、version、topic、question/purpose、audience、subjects、dimensions、focus、exclusions、lengthTarget、reportStructure（派生）、editableFields、fieldStates、validation、blueprint（id/name/purpose/最低与推荐数量）、guide（complete/reason/decisions/active）、matrix 摘要、contentHash。

### 前端（本轮只做最小兼容）

- 只更新了 `apps/research/src/browser/api.ts`：新增 `BriefView` / `BriefPatch` / `GuideQuestionView` / `GuideDecisionView` 等 DTO 与 `api.brief / patchBrief / guideNext / guideAnswer`；`TaskBundle` 增加 `brief`；`RunView.stage` 与 `STAGE_LABELS` 增加 `guide`；新增 `BRIEF_FIELD_LABELS` / `BRIEF_STATE_LABELS`。
- 既有 Brief 页面**未改**，仍能正常读取（它读的 `task.*` / `subjects` / `dimensions` / `structure` 都未变）；本轮**没有**在页面上拼一半新版 Structured Mode。

### 测试（本轮新增）

- `packages/plugin-research/tests/brief-guide.test.ts`（33 例，服务层契约 A–N）：默认草稿与 fieldStates、PATCH 只改目标字段且版本 +1、stable IDs（改名/重排保 id、新增才生成、未知 id 拒绝）、不完整草稿可读不可确认、Blueprint 最低义务、confirm 用最新草稿并重建矩阵、confirm 后三处上锁、一次一问、选项 value 必须是真 patch、引导答案走同一套规则（含自由文本结构化解析）、stale（版本与目标字段两条判据）、已答不可重答、引导看到最新值且不重复追问、5 个决策后停止、两种模式互为同一份草稿、历史已确认/未确认项目。
- `apps/research/tests/brief-api.test.ts`（6 例，HTTP → runner → host run → tool → service → DB 全链路）：默认草稿、结构化 PATCH + 409 stale + 400 白名单、删一个维度加一个维度、一个问题一次写入 + 重问不重复花 run + 版本 stale 409 + 重复回答 400、下一问落到未决定字段（`subjects`）后由模型声明结束、confirm 后矩阵等于最终 subjects×dimensions 且两条路径都上锁。

## Step 3 新增（本次工作产物）

- **技术栈**：React 19 + Mantine 9（`@mantine/core` / `@mantine/hooks` 9.7.0，负责 Button / Input / Select / SegmentedControl / Menu / Popover / Tooltip / Modal / Drawer / ScrollArea 等 primitive）+ lucide-react 图标 + 既有 esbuild 管线；未引入第二套组件系统。依赖只加在 `apps/research`。
- **两套视觉语法**（`apps/research/public/`）：`app.css` 由 bundle 输出（Mantine），`styles.css` 是 ResearchPage 的 application UI 设计系统（tokens / shell / 矩阵 / Dock / 各视图），`document.css` 是 research artifact 的独立 renderer 样式（Editorial 衬线期刊 / Swiss 编号分析出版）。两者只共享品牌色与语义状态色；报告 HTML/PDF 仍由 plugin 的 semantic renderer 输出。
- **产品外壳**：Global Bar（身份、当前项目、项目切换、运行状态、设置）+ Project Nav（研究 / 报告 / 来源 / 研究任务 / 模板）；hash 路由 `#/`、`#/settings`、`#/p/<taskId>/<view>`，刷新与直达链接都能重开同一个项目与视图。
- **Start / Library**：第一焦点是 research composer（大输入 + 建议 + 真实约束说明）；项目以行呈现（标题 / 状态摘要 / 比较对象 / 更新时间），不是卡片墙。
- **Research Brief**：任务卡是主体，字段标「助手建议」并在进入时轻微高亮；比较对象为行、维度为带问题的编号项、关注点为 chip；确认前的调整走真实路径（改主题重新建立任务卡）。
- **Research View**：证据矩阵是视觉中心——行标题写研究问题、单元格写「中文状态词 + 短判断 + 证据摘要（n 条证据 · m 条一手）」，弱化纵向边框，选中态为 inset accent；运行中只显示「正在核对的问题 / 为什么研究 / 下一步」，不展示思维链、不显示假百分比。
- **Context Dock（统一）**：同一面板承载证据片段、来源详情、论断检查器、修改建议与助手动作日志；宽度 372px，可用宽度 ≥1400px 时 push，否则 overlay；overlay 时 sticky chrome 让出面板宽度，工具栏控件不会被盖住；Esc 关闭、切换目标自动回到顶部。
- **Report Studio**：原生 Document Canvas（`max-width` 920 / 正文 720，比较表允许更宽），彻底移除 iframe-as-product；Read / Verify 两种模式（Read 隐藏引用标记与校验提醒，正文一字不变）；对象选择（章节 / 论断 / 比较表）后工具栏出现统一动作（检查 / 补查 / 修改 / 更多）；Evidence Inspector 同时回答两个问题——「引用有效」（报告保存时逐条校验）与「证据是否足以支持」（claim adequacy + 条件 + 支持评估 + 片段 + 定位 + 读取范围）。
- **修改建议**：显示目标、理由、「现在的正文 / 修改后」两栏与原样渲染的区块、受影响论断（新增 / 替换）、证据变化；接受前正文 hash 不变，接受后只有目标章节变化（gate 逐节比对）。
- **版本与主题**：工具栏显示「工作稿 / R# · 已冻结」；冻结版本从冻结包单独渲染、只读；`reportNeedsReview` 显示为「1 处待复核 · 正文未变」；主题切换只改排版（标题、正文与引用编号逐字不变），冻结时把 themeId 写入版本。
- **Sources**：editorial list/table hybrid——Title 列承担主要信息（标题 / 作者 / 年份 / id），其余为角色、读取范围、解析状态、证据数与被引用数；行点击打开同一个 Dock。
- **Template Gallery**：Editorial 与 Swiss 用同一份真实报告并排预览（缩放的真实文档，不是缩略图或用下拉框）；页面明确「内容不变 / 引用不变」。
- **Settings**：通用 / 模型 / 研究 / 来源与集成 / 导出；未实现的能力标「未接入」，不提供假开关；模型与 PDF 渲染能力来自新的 runtime 只读接口。
- **后端改动（全部在 `apps/research` 范围内的 presentation adapter，未触碰语义）**：
  - `GET /api/research/runtime`：模型、PDF 渲染器（`browserPath ?? findPdfBrowser()`）、预算、数据目录、忙闲。
  - `GET /api/research/reports/:reportId/document` 与 `GET /api/research/revisions/:revisionId/document`：结构化报告 DTO——sections/blocks/claims（含 claimType、conditions、subjects/dimensions）、`buildCitations` 生成的引用编号、`deriveClaimAdequacy` 逐条推导的 adequacy、validation；revision 版本完全从冻结包构造。
  - `GET /api/research/tasks/:id/answers`：Ask 的回答从会话 committed history 读回（run → turnId → assistant item），`runner.questionOf/answerOf` 提供映射与记忆化；Ask 仍然不写入任何正式数据。
  - task bundle 的 sources 增加 `role`。
- **构建**：browser bundle 增加 `define: { "process.env": "{}" }`，页面产物不再包含任何环境读取；`apps/research/tests/bundle.test.ts` 把断言改为「产物中每一处 process.env 提及都必须是 esbuild 的 define 标记，且不存在 `process.env.` 形式的读取」。
- **测试**：`apps/research/tests/frontend-logic.test.ts`（11 例：路由解析与回退、引用编号映射、综合判断标记、提案 claim 增删判定）；浏览器 gate `apps/research/scripts/verify-workspace.mjs` 重写为 30 例真实 CDP 输入用例（含 1366/1440/1920 截图、Read/Verify、Dock、主题、设置、Ask / Research / Edit→接受闭环）。

## Step 3 的验证入口

- 浏览器 gate（真实输入，非 DOM stub）：`node apps/research/scripts/verify-workspace.mjs --url <product url> [--task <id>] [--shots <dir>] [--model]`；不带 `--model` 时跳过需要真实模型的动作（Ask / Research / Edit）。
- 前端纯逻辑：`npx vitest run apps/research/tests/frontend-logic.test.ts apps/research/tests/bundle.test.ts`。
- 离线全量与类型检查同 Step 2：`pnpm typecheck`、`pnpm build:research`、`EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude ...`。

## Step 1 新增（本次工作产物）

- **权限与意图**（`packages/plugin-research/src/semantics.ts`）：`ask | research | edit` 三个正式意图 + 程序自用授权 `draft | card`；`ActionGrant` 表达 actionId、intent、task、targetType/targetId、scope、baseReportId/baseContentHash、allowResearch、capabilities、budget；`classifyIntent` 只做可读的关键词识别，识别不出即按 Ask（不写入）。
- **写入边界在服务层**：`search / read / assess` 需要 `research` 能力，`save_report` 需要 `report` 能力，`createProposal` 需要 `proposal` 能力；无授权即拒绝，拒绝是**结果**（模型可读的句子）而不是异常。权限由 runner 在 stage 启动时签发、stage 结束后清除。
- **Support Assessment**（`domain.ts` + `service.recordAssessment`）：每条评估关联目标单元格、evidenceIds、relationship（supports/contradicts/contextual）、directness（direct/indirect/contextual/unassessed）、scope、rationale、assessor（agent/user）、createdAt。用户可通过 `POST /tasks/:id/assessments` 覆盖或补充。
- **矩阵诚实推导**（`domain.ts: deriveCellCoverage`）：missing / unassessed / limited / reviewed / conflict。读取正文只到 `unassessed`；只有「supports + direct + 正文级片段」的评估才到 `reviewed`（且措辞为「已核对」，不表示证明为真）；间接或仅摘要级为 `limited`；冲突为 `conflict`。**读取时重新推导**，不信任存储的状态，因此旧数据的 `sufficient` 不会被沿用。
- **Proposal**（`packages/plugin-research/src/proposal.ts`）：目标章节 + 旧内容 hash + 替换 blocks + 新增 claims + evidence 引用 + 理由 + 状态（pending/accepted/discarded/stale/invalid）。一个项目同时只保留一个待接受提案；接受前报告正文与 hash 不变；接受时校验待处理状态、基线报告与目标 hash，事务内只替换授权目标并重新走完整报告校验；重复接受不再应用；基线变化标记 stale 并拒绝。
- **Frozen Report Revision**（`packages/plugin-research/src/revision.ts`）：冻结结构化报告正文、研究 frame 摘要、引用的 claims、证据（id + locator + excerpt + scope）、read snapshot ids、来源元数据、相关支持评估、报告自身的缺口快照、renderer/theme 版本与时间。`renderRevisionHtml` 只读冻结包；同一 revision 重复导出字节一致（含文档时间戳）。
- **导出**：`POST /tasks/:id/revisions` 冻结、`POST /revisions/:id/export` 从冻结包出 PDF、`GET /revisions/:id/html` 预览；`POST /tasks/:id/export` 先冻结当前报告再导出；`/reports/:id/html` 是工作稿预览，显示报告自己的缺口快照。导出记录含 revisionId / themeId / rendererVersion。
- **Research 不写报告**：任务已有报告时，research / gap 阶段结束后不再自动进入 report 阶段；材料变化只设置 `task.reportNeedsReview`（正文与 hash 不变）。
- **API**：`POST /tasks/:id/assistant`（intent=auto|ask|research|edit，Edit 需 targetSectionId）、`GET/POST /tasks/:id/assessments`、`GET /proposals/:id`、`POST /proposals/:id/accept|discard`、`POST /tasks/:id/revisions`、`GET /revisions/:id`、`GET /revisions/:id/html`、`POST /revisions/:id/export`。旧的 `/followup` 已移除（前端改为 assistant 入口）。
- **数据库迁移**：新增 `support_assessments` / `proposals` / `report_revisions` 三张表（`CREATE TABLE IF NOT EXISTS`），`saveReport` 改为 upsert，新增 `transact`。未重建既有表、未回填任何状态。
- **测试**：`packages/plugin-research/tests/editing-semantics.test.ts`（15 例，服务层契约 A–I）、`tests/migration.test.ts`（3 例，旧 schema 库可读且不被提升）、`apps/research/tests/editing-api.test.ts`（5 例，HTTP → grant → run → tool → service 全链路）。

## 关键实现决定（与 SPEC 的差异）

- **UI 库**：未引入 Fluent UI，使用手写 CSS（时间与依赖风险权衡）；产品语义不变。
- **路由挂载点**：业务 API 挂在 `apps/research` 的应用组合里，通过 `apps/web` 静态服务器的 `onRequest` 钩子；未把研究依赖注入通用 shell 包。
- **阶段化 Run**：底座 loop 上限为 12 步/ run 且不扩大，一次研究拆成 card / research / gap(≤2) / report / synthesis 多个 run，由 runner 串行驱动；模型不决定预算。Step 2 起 report 只写「框架与机制」，synthesis 写「比较、综合与结论」并 finalize。
- **报告写入**：单次输出预算（≈4096 tokens）装不下整份报告，`save_report` 支持 `part: start/write/finalize` 增量草稿。
- **前端**：Step 1 只在既有 workspace 上加最小入口（意图选择、目标章节选择、提案接受/放弃、冻结与按版本导出）。正式 Studio 属于 Step 3。
- **Action Grant 只存在于进程内**：授权是「现在可以写」的许可，重启后不残留；持久化的是它产生的 Proposal / Revision（含 actionId 与基线 hash）。

## 已知限制

- 补查轮次上限 2、搜索 ≤6、读取 ≤10、单任务 8 分钟窗口（SPEC 初值，未收紧也未扩大）。任务已有报告后，assistant 的 Research 动作同样消耗补查轮次预算。
- Edit 只支持 Section 级替换（可显式附带 summary 目标）；不做 Claim/图/任意文本范围编辑、不做字符 diff 与三方合并。
- 冻结包不复制全文，只保存引用到的 evidence 定位与片段、来源元数据与 read id；历史报告若没有缺口快照，revision 如实标 `gapsCaptured=false`，不伪造。
- Theme 仍只有 `editorial` 一个；切主题不产生新 Revision（后续步骤）。
- 读取仅覆盖 arXiv HTML 全文与其摘要页；PDF 正文不解析。
- 报告 PDF 的分页与字体依赖本机 Chrome/Edge 与系统中文字体；已验证 Windows Chrome。
- 未做：多结构/第二 Blueprint、模板 Gallery、Mermaid、文件上传、auth/collaboration。
- 浏览器 gate（`apps/research/scripts/verify-workspace.mjs`）需要本地 Chrome/Edge 与一个运行中的产品服务；IAB 的后端在本机不投递真实点击，故验收走 CDP。该脚本已按新状态词更新（找「有材料的单元格」而不是「sufficient」）。
- 报告篇幅仍未收敛到 blueprint 建议的 4–7 页：真实 v2 报告为 8–11 页（一次 15 页的运行在加入写作预算后收窄）。页数是版式目标而非校验项，实测由「4 对象 × 6 维度」的内容义务驱动。
- Q02（标题/摘要不得超出证据范围）目前是一个可解释的启发式：标题或摘要出现效果/性能类承诺而报告没有有效效果论断时给出 warning；它不做语义判断，可能给出保守的提示。
- 机制块没有图形渲染：本轮只输出结构化的 input/intermediate/steps/output/tradeoff/failure，Mermaid/DiagramSpec 渲染属于后续步骤。
- 前端仍是最小兼容：报告 iframe + claim 类型标签 + frame/警告提示；四层阅读、Context Dock、Report Studio 属于 Step 3。

- 前端（Step 3 后仍存在的限制）：任务卡字段不能在界面里直接编辑——后端没有该路由，改结构的方式是改主题重新生成任务卡（会产生新项目，原项目保留）；Ask 的回答只从会话历史读回最近 5 次，界面不提供完整对话列表；PDF 仍只有 Editorial 版式（Swiss 的 PDF 适配属 Step 4）；切主题不产生 Revision，只记录在冻结版本的 themeId 上；1366 窗口下 Dock 为 overlay，会覆盖矩阵最右一列（可 Esc 关闭，Dock 标题与选中态仍表明当前目标）。

- 简报与引导（Step 3.5A 后仍存在的限制）：
  - **界面未接**：本轮只做了 API，Brief 页面仍是只读卡片 + 「换个说法重新生成」；正式 Structured / Guided UI 属于 STEP 3.5B。因此现在通过界面**无法**编辑简报，也**无法**手动引导——必须走 API 或 3.5B。
  - 引导问题**一次只能针对一个字段**（`fieldTargets` 长度为 1），不支持「一个问题同时决定目标与关注点」。`GUIDE_DECISION_LIMIT` 为 5，之后其余字段只能靠结构化编辑。
  - 引导问题由**一个 stage run** 生成，不是即时返回：`guide/next` 是 202 + 轮询，模型不可用时该轮不会产生问题（返回 409/空），不伪造问题。
  - 自由文本对 `subjects` / `dimensions` 是**整体替换**语义（按行解析），不是增量编辑；已存在的对象按名称匹配复用 id，改名同时改列表需要显式带 id（结构化 PATCH 可以精确做到）。
  - 结构性编辑（增删/重排对象或维度）在任务**已有实际读取材料**时被拒绝并返回 409，而不是静默删除证据；正常流程里未确认任务没有材料，所以这条只在异常数据上生效。
  - `topic` 也可编辑（项目标题），但本轮没有把它从 Brief 的语义讨论里单独拆出：`purpose` 才是研究问题的唯一来源。
  - 未做：mid-research reframe、简报的历史版本/回滚（只保留 `briefVersion` 计数与引导决策记录）、多字段问题、分支式问题树。

## Next Action

**STEP 3.5B — Brief & Studio Interaction Repair**（下一步，本轮未做）。

需要 3.5B 处理的是「语义已经有了、界面还没接上」的那一段：

- **Structured Mode UI**：Brief 页面的字段真正可编辑（inline 编辑 / segmented / editable chips，不要 full-width 表单墙），带 `fieldStates` 的 suggested/edited/confirmed 视觉区分与 400–600ms 更新提示、`expectedVersion` 409 的重新同步路径。现在页面上唯一的修改方式是「换个说法重新生成」（会产生新项目）——这正是本轮要消灭的产品缺陷，但**只在 API 层消灭了，界面还没换**。
- **Guided Mode UI**：一次一问的引导面板（question / whyThisMatters / 2–5 个选项 + free text / 已做决定的回看），`POST brief/guide/next` 是异步的（202 + 轮询 brief），UI 需要处理「问题生成中」这一状态；模型声明 `complete` 后要能自然收束，并允许用户「默认方案已经够好 → 一键确认」。
- **旧 Brief 页面的确认按钮**：`POST /confirm` 现在会因草稿不完整返回 409。store 会把它显示成错误提示，但页面无法据此引导用户补齐字段——3.5B 必须把 409 的问题清单接到可编辑字段上。
- **Studio 双栏**：Assistant 与 Brief 的联动（conversation shapes structure），字段更新后的轻微高亮与可撤销。
- 仍需遵守既有取舍：Report Structure 由 Blueprint 派生、只读；不引入 Markdown renderer / Mermaid；本轮遗留的 `reportNeedsReview`、冻结版本与主题切换语义不变。

**STEP 4**（后续步骤）：PDF 双主题适配（把 ThemeSpec 映射到 plugin 的 HTML/PDF renderer，使 Editorial/Swiss 在导出文件里也成立）、Mermaid / DiagramSpec 机制图、File Upload 作为来源、第二 Blueprint、MCP 集成。第 3 轮已经把这些位置留好：主题在版本里记录 themeId，机制块保留结构化数据，Source Workspace 与 Settings 对未接入能力如实标注。

## Step 3.5A 的验证入口

- 简报 / 引导契约（服务层）：`npx vitest run packages/plugin-research/tests/brief-guide.test.ts`。
- 简报 / 引导全链路（HTTP → runner → tool → service）：`npx vitest run apps/research/tests/brief-api.test.ts`。两者都使用脚本化模型与本地 fixture，不需要网络或模型凭据。
- 离线全量与类型检查同 Step 2：`pnpm typecheck`、`pnpm build:research`、`EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude "**/real-provider.e2e.test.ts" --exclude "**/real-network.test.ts" --exclude "**/render-pdf.test.ts" --exclude "**/research-plugin.real.test.ts" --exclude "**/real-demo.e2e.test.ts"`。
- 浏览器 gate 未重跑（本轮未改前端视图）；`verify-workspace.mjs` 的 brief 步骤读的是未改动的既有页面。

## Step 2 的验证入口

- 离线全量：`pnpm typecheck` + `EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude "**/real-provider.e2e.test.ts" --exclude "**/real-network.test.ts" --exclude "**/render-pdf.test.ts" --exclude "**/research-plugin.real.test.ts" --exclude "**/real-demo.e2e.test.ts"`。
- 真实 Demo（两主题）：`RESEARCHPAGE_REAL_NETWORK=1 RESEARCHPAGE_KEEP_ARTIFACTS=1 npx vitest run apps/research/tests/real-demo.e2e.test.ts`（换主题用 `RESEARCHPAGE_DEMO_TOPIC`）。
- 真实 PDF：`RESEARCHPAGE_REAL_NETWORK=1 npx vitest run packages/plugin-research/tests/render-pdf.test.ts`。
- 页面 gate：`node apps/research/scripts/verify-workspace.mjs --url <product url>`（对 v2 报告实测 9/9 PASS）。
