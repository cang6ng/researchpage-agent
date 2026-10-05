# ResearchPage — HANDOFF

## Baseline

- 比赛仓库：`D:/SomeProjects/AgentCompetition2026`（产品仓库称呼：`researchpage-agent`）。
- 起点 commit：`ebb3e7c28d84f825176b9842a0ec7f86c636ecb4`（`chore: bootstrap competition project from Every-DAgent Phase 4`）。
- Step 1 起点 commit：`cc279d927485dcb339d2b9a56e07cfd1eff1d4f6`（`chore: ignore the local research data directory`）。
- Upstream sealed baseline：`c5f97ba63f719ec81030746f3eb67fe7c538e01f`；见 [UPSTREAM_BASELINE.md](./UPSTREAM_BASELINE.md)。未修改 upstream，未引入 Phase 5。
- 实施依据：[COMPETITION_SPEC.md](./COMPETITION_SPEC.md)、`ResearchPage_Product_Redesign.md`（§6/§8/§17/§23）、`What Makes a Great AI-Native Research Artifact?`（§6/§11–13/§17）。

## Current Status（2026-10-05）

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

## Next Action

**STEP 3 — Frontend Product Redesign**（前端；不在本轮范围）：

1. 按 `ResearchPage_Product_Redesign.md` 实现 Research Workspace / Report Studio：四层阅读、Context Dock 核验、认知组件的版式（本轮的组件数据已经就位：frame、mental-model、机制块、比较表列映射、综合标记、缺口分型）。
2. 目前前端只是最小兼容（报告 iframe + claim 类型标签 + frame/警告提示）；模板 Gallery、第二 Theme、Mermaid、File Upload 仍属后续步骤。

## Step 2 的验证入口

- 离线全量：`pnpm typecheck` + `EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude "**/real-provider.e2e.test.ts" --exclude "**/real-network.test.ts" --exclude "**/render-pdf.test.ts" --exclude "**/research-plugin.real.test.ts" --exclude "**/real-demo.e2e.test.ts"`。
- 真实 Demo（两主题）：`RESEARCHPAGE_REAL_NETWORK=1 RESEARCHPAGE_KEEP_ARTIFACTS=1 npx vitest run apps/research/tests/real-demo.e2e.test.ts`（换主题用 `RESEARCHPAGE_DEMO_TOPIC`）。
- 真实 PDF：`RESEARCHPAGE_REAL_NETWORK=1 npx vitest run packages/plugin-research/tests/render-pdf.test.ts`。
- 页面 gate：`node apps/research/scripts/verify-workspace.mjs --url <product url>`（对 v2 报告实测 9/9 PASS）。
