# ResearchPage — HANDOFF

## Baseline

- 比赛仓库：`D:/SomeProjects/AgentCompetition2026`（产品仓库称呼：`researchpage-agent`）。
- 起点 commit：`ebb3e7c28d84f825176b9842a0ec7f86c636ecb4`（`chore: bootstrap competition project from Every-DAgent Phase 4`）。
- Step 1 起点 commit：`cc279d927485dcb339d2b9a56e07cfd1eff1d4f6`（`chore: ignore the local research data directory`）。
- Upstream sealed baseline：`c5f97ba63f719ec81030746f3eb67fe7c538e01f`；见 [UPSTREAM_BASELINE.md](./UPSTREAM_BASELINE.md)。未修改 upstream，未引入 Phase 5。
- 实施依据：[COMPETITION_SPEC.md](./COMPETITION_SPEC.md)、`ResearchPage_Product_Redesign.md`（§6/§8/§17/§23）、`What Makes a Great AI-Native Research Artifact?`（§6/§11–13/§17）。

## Current Status（2026-10-05）

- **Feasibility 四项全部通过**（真实网络、真实模型，非 fixture）：A1 真实搜索（arXiv）、A2 真实读取 + Evidence、A3 HTML→PDF、A4 Plugin seam。
- **Vertical Product 可真实演示**：Topic → Task Card → 确认 → 真实检索/读取 → Evidence Matrix → 缺口定向补查（≤2 轮）→ 结构化报告 → HTML 预览 → PDF 下载 → 刷新重开。
- **Step 1（Research Editing Semantics）已完成**：Ask / Research / Edit 三种正式意图由应用签发 Action Grant 约束；Edit 产出待接受 Proposal；报告版本可冻结、导出只读冻结依赖包；矩阵状态不再由「有正文片段」直接升级为充分。
- 真实 Demo 两个主题此前均通过（真实模型 + 真实 arXiv + 真实 Chrome PDF）；本轮未重跑真实模型 Demo（见「未能验证」）。

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
- **阶段化 Run**：底座 loop 上限为 12 步/ run 且不扩大，一次研究拆成 card / research / gap(≤2) / report 多个 run，由 runner 串行驱动；模型不决定预算。
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

## Next Action

**STEP 2 — Research Artifact Quality**（不是前端）：

1. 让报告内容本身变深：Section 的认知目的、Claim Contract 六类的最小证据要求、比较口径与「不可比」的显式处理、缺口与限制的写法。
2. 让 `reviewed` 有意义：评估的适用范围与条件如何进入正文与摘要，冲突如何在报告中并置而不是被平均。
3. 让研究质量可验收：按 Artifact 文档 §17.5 的十个验收场景建立可复跑的质量检查。
4. 之后才是 Step 3（Frontend / Report Studio），不要在 Step 2 之前动前端结构。
