# ResearchPage — HANDOFF

## Baseline

- 比赛仓库：`D:/SomeProjects/AgentCompetition2026`（产品仓库称呼：`researchpage-agent`）。
- 起点 commit：`ebb3e7c28d84f825176b9842a0ec7f86c636ecb4`（`chore: bootstrap competition project from Every-DAgent Phase 4`）。
- Step 1 起点 commit：`cc279d927485dcb339d2b9a56e07cfd1eff1d4f6`（`chore: ignore the local research data directory`）。
- Upstream sealed baseline：`c5f97ba63f719ec81030746f3eb67fe7c538e01f`；见 [UPSTREAM_BASELINE.md](./UPSTREAM_BASELINE.md)。未修改 upstream，未引入 Phase 5。
- 实施依据：[COMPETITION_SPEC.md](./COMPETITION_SPEC.md)、`ResearchPage_Product_Redesign.md`（§6/§8/§17/§23）、`What Makes a Great AI-Native Research Artifact?`（§6/§11–13/§17）。

## Current Status（2026-10-08）

- **Step 3.6B（Navigation, Status & Trust UX）已完成**：3.6A 已经正确的业务语义接上了界面——项目只剩三个一级工作空间（报告 → 研究 → 来源），研究范围退到项目标题旁（未确认的项目自动以它为主流程），样式退到报告工具栏（不再叫「模板」），顶栏不再常驻检索/读取额度、只回答「这个项目现在发生什么」并可展开六条并列事实；补查结果第一句回答「问题解决了吗」（已解决 / 部分解决 / 未解决），工具次数折叠在结果之后，「查看本轮证据」只打开这一轮新增的来源 / 证据 / 支持评估与仍未解决的缺口，并能回到刚才那一轮对话；提案在待确认时完整展开、决定后折叠成一行、没形成提案时不出现任何「接受」按钮；未知角色、旧报告的空白单元格、质量核验详情、动作提示跨页残留与内部术语全部按读者语言收口。未做 PDF / Mermaid / Upload / MCP / 第二 Blueprint / Tauri，未改任何后端语义（本轮没有一处 server / plugin 改动）。

- **Step 3.6A（Product Trust & Co-edit Reliability）已完成**：一次独立真实验收发现的「看到的状态、结果与可执行操作不可信」按 P0/P1 修完——待接受提案在生成时就通过报告自身的内容契约（改不下去就不会出现「接受」按钮），比较表与提案表格不再出现空白单元格，补查结果先回答「问题解决了吗」，提案上的「新增」是这次动作真实的增量，来源角色未分类不再被当成「0 个一手材料」，项目状态拆成六个互不代偿的字段。未改视觉、未做 PDF / Mermaid、未进入 Next Action。

- **Step 3.5C-B（Conversational Planning & 50/50 Co-edit UI）已完成**：引导式规划从「一次一问的表单」变成一段真正的规划对话（问题、过渡语、用户的回答与回执按发生顺序重建，刷新后原样恢复，进度按 `readiness / minDecisions / maxDecisions` 说真话，用户随时可以自己确认，助手早退被拒后不会把界面卡在「正在准备」）；报告工作台从「文档 + 右侧插件」变成阅读与 50/50 协作两种形态（打开助手即左右各半、可拖动分隔条 40/60–60/60、1366 不再退回浮层），右栏是一个一级工作区：对话 + 内嵌动作、补查与修改建议，证据在同一栏打开并可一键回到对话。

- **Step 3.5C-A（Guided Conversation & User Research Budget）已完成**：引导式规划有了深度契约（至少 5 个、最多 7 个关键决策，Agent 不能提前收尾，用户随时可以确认开始），引导问题带上 leadIn / 答案带上 answerText（下一轮做对话式界面所需的数据），用户明确发起的补查拿到自己的一次性 Action Budget，不再被项目的自动研究预算与 deadline 永久挡住。

- **Step 3.5B（Brief & Studio Interaction Repair）已完成**：简报的两种模式都接到了界面上（结构化编辑 = 直接改助手给出的方案；智能引导 = 一次一个决策，两者写同一份草稿）；报告工作台分成阅读与协作两种布局，助手工作区从 372px 的 Dock 变成 420–520px 的宽栏；AI 文字统一走 RichMarkdown（react-markdown + remark-gfm + rehype-sanitize，无 raw HTML）；交互式报告的比较表重排成可读矩阵，缺口聚合成「研究边界」，机制块按输入 → 步骤 → 输出呈现，内部 id 不再出现在读者看的文字里。

- **Step 3.5A（Editable Research Brief + Guided Planning）已完成**：未确认的 ResearchTask 本身就是可编辑的 **Research Brief Draft**；结构化 PATCH 与引导式（一次一问）两种交互写同一份草稿；确认时按最终草稿校验、冻结字段状态并重建矩阵；历史项目仍按只读返回。

- **Step 3（Frontend Product Redesign）已完成**：产品前端从「最小兼容」重写为 desktop-grade 研究工具——统一设计系统、Start/Library、Research Brief、Evidence Matrix、统一 Context Dock、原生 Report Studio（Editorial / Swiss 两套文档主题）、Source Workspace、Template Gallery、Settings；全部界面连接真实 API，浏览器 gate 逐项验收。

- **Step 2（Research Artifact Quality）已完成**：Technical Comparison v2 成为一个真实可执行的 Blueprint；报告由认知主线（问题 → 概念坐标 → 机制 → 条件化比较 → 综合 → 缺口）组织，六类 Claim Contract、可比性判断、维度覆盖与 Q01–Q12 质量契约都在程序侧可校验。
- 真实产物：GraphRAG 与 LoRA/QLoRA/DoRA 两个主题各用真实模型 + 真实 arXiv + 真实 Chrome PDF 各跑通一次（v2 报告 8/11 页、10–11 条 claim、6 条综合判断，Q01–Q12 全部 pass，仅有 informational warning）。

- **Feasibility 四项全部通过**（真实网络、真实模型，非 fixture）：A1 真实搜索（arXiv）、A2 真实读取 + Evidence、A3 HTML→PDF、A4 Plugin seam。
- **Vertical Product 可真实演示**：Topic → Task Card → 确认 → 真实检索/读取 → Evidence Matrix → 缺口定向补查（≤2 轮）→ 结构化报告 → HTML 预览 → PDF 下载 → 刷新重开。
- **Step 1（Research Editing Semantics）已完成**：Ask / Research / Edit 三种正式意图由应用签发 Action Grant 约束；Edit 产出待接受 Proposal；报告版本可冻结、导出只读冻结依赖包；矩阵状态不再由「有正文片段」直接升级为充分。
- 真实 Demo 两个主题此前均通过（真实模型 + 真实 arXiv + 真实 Chrome PDF）；Step 2 后又用新版各重跑一次（见「Current Status」与「Step 2 的验证入口」）。

## Step 3.6B 新增（本次工作产物）

本轮只做信息架构收敛、状态表达、结果与提案的可信呈现、本轮证据直达与术语清理。**没有修改任何后端语义**：`git diff` 只涉及 `apps/research/src/browser/**`、`apps/research/public/styles.css`、两个 gate 脚本、测试与 tsconfig，没有一处 `src/server` / `packages/**` 改动。没有重做首页 / Brief / Guided Planning / 50-50 骨架，没有动 Ask / Research / Edit 语义、Claim Contract、Artifact Validator、Blueprint、Action Budget、Frozen Revision。

### 信息架构（`routes.ts` / `shell.tsx` / `workspace.tsx`）

- **一级导航只剩三个**：报告 → 研究 → 来源（`PRIMARY_NAV`）。报告在前，因为研究做完之后读者主要在报告上工作。`brief` 与 `gallery` 仍是可达路由，但不再是导航项；`VIEW_LABELS.gallery` 从「模板」改为「样式对照」——这次构建只有一个 Blueprint，一个许诺更多的导航项是产品的虚假陈述。
- **研究范围退到项目标题旁**：顶栏「研究范围 · 已确认/待确认 [查看]」直接进现有 Brief 页；未确认的项目里它额外出现在导航行首（带「待确认」），因为那时它就是唯一的主流程。
- **默认视图由项目状态决定**（`defaultViewOf`）：未确认 → Brief，已确认且有报告 → 报告，否则 → 研究。地址不再猜：`parseRoute("#/p/<id>")` 的 `view` 现在是 `null`（「地址没点名」），由 `Workspace` 用项目的真实状态解析后把 hash 补全，而不是把某个猜测冻进 URL 语法。
- **样式退到报告工具栏**：按钮在任何宽度都叫「样式」（当前值在窄窗口先省略），`DOC_THEME_OPTIONS` 是唯一一份选项列表；并排对照页仍从样式菜单进入，「模板」这个词在用户界面里不再出现。

### 项目状态（`status.ts` 新建 + `shell.tsx`）

- **顶栏只回答一个问题**：优先级是「正在进行的动作 → 等用户决定的提案 → 报告待复核 → 未解决的研究 → 就绪」，一次只说一句（研究中 / 有修改待确认 / 报告待复核 · n 项未定论 / 报告可阅读 · n 项研究问题仍未解决）。「无待查项」这类把材料覆盖当成结论完成的话不再出现。
- **点击状态展开六条并列事实**（`statusDetails`）：当前动作 / 材料覆盖 / 研究判断 / 报告 / 质量检查 / 来源，每条都用 3.6A 的 `userMessage` 原文，并附一句「有材料不等于有结论，报告通过自己的内容检查也不等于结论已被独立复核」。
- **顶栏不再常驻额度**：`搜索 4/6 · 读取 7/10` 从 Global Bar 消失；研究页原来的「检索 / 读取 / 补查」三格计分板也换成了「研究范围（n 个比较对象 · m 个研究维度）· 查看研究范围」。额度留在它该在的地方——助手 composer 的本次剩余、补查按钮旁的剩余轮次。
- `projectState`（旧的一句话芯片）被 `primaryStatusOf` 取代，测试直接断言它不会把「15/15 有材料、0 项已核对」说成就绪。

### 研究结果：先回答「问题解决了吗」（`outcome.ts` 新建 + `components/assistant.tsx`）

- **结果块**：已解决 / 部分解决 / 未解决（`RESOLUTION_LABELS`）+ 服务端的 `resolution.summary` 句子 + 「已解决」（本轮 settled 的 target）+ 「仍缺少」（`remainingGap` 的名字与理由）+ 「本轮新增」（动作自己的 delta；为 0 时说「本轮没有找到新的材料。」）。
- **不夸大**：`newSources > 0` 不再被说成「找到可用材料 / 问题已有答案 / 补查成功」；升级前运行的老 run 没有 outcome 时说「结果未记录」，并明确说明材料已并入项目，而不是拿材料数冒充答案。
- **活动折叠**（`<details>`）：「本轮活动 · 2 次检索 · 4 个来源读取 · 1 格覆盖评估」默认收起，结果永远在它上面。额度用尽的提示降为结果下面的一行说明。
- **提案没形成**（§20）：标题「这次改写没有形成可接受的修改建议」+ 服务端 `userMessage` + 「重新尝试 / 换一种修改方式」两个动作；不渲染 ProposalCard，页面上没有任何「接受」控件（测试断言 edit-outcome 子树里既没有「接受这一节」也没有 `accept-proposal`）。

### 本轮证据直达（`store.tsx` / `components/dock.tsx`）

- 新增 dock 目标 `{ kind: "action", interactionId }`：右栏显示这次动作自己的 resolution、新增来源（角色 + 读取范围）、新增证据（片段 + 定位）、对应的支持评估与「仍未解决的缺口」，顶部「← 返回对话」。材料按 **id 差集**（`actionMaterial`）取，不是把整个材料库缩窄；`newSourceIds/newEvidenceIds/newAssessmentIds` 为空就诚实写「这次动作没有新增来源 / 可引用的片段 / 支持评估」。
- **返回的是那一轮**：`{ kind: "assistant", focus: interactionId }` 让对话滚回刚才那一轮（`data-interaction-id` + `scrollIntoView`），对话本身由 bundle 重建，不丢上下文。
- 旧按钮「检查新证据」改名「查看本轮证据」，`verify-workspace.mjs` 里的文本引用同步更新。

### 提案生命周期（`proposal-logic.ts` 新建 + `components/proposal.tsx`）

- **状态用读者的词**：待确认 / 已接受 / 已放弃 / 需要重新生成 / 未生成修改建议（`PROPOSAL_STATUS_LABELS`），不再出现「基线已变化」「内容未通过校验」以及 `invalid` / `Q03` / contract 这类内部说法。
- **待确认 = 完整展开**（它是用户当前的任务），**已决定 = 折叠成一行**（状态 + 目标 + 时间 + 展开），历史不再长期占据半屏。
- **删除内容 hash 与 reportId**：面板里的「基线 sha256:…」和「由它产生的报告：rep_…」都去掉了，delta 行改为 `proposalDeltaLine`（0 时说「本次修改没有新增研究材料。」）。

### 术语、状态与提示收口

- **状态词统一**（§9/§27）：`支持有限` / `证据冲突` / `缺少依据` / `有材料，待核对` / `已核对`；表内未写判断的单元格仍是「尚未写出判断 / 证据不足 / 不可直接比较」。
- **来源角色**（§24）：研究页与来源页都改用 `presentation.sourceRoles.userMessage`；来源表的 id 列删除、未分类写「尚未分类」，筛选器在存在未分类来源时叫「一手材料（已分类）」。
- **质量核验**（§26）：工具栏显示「需要进一步核验 · n」（blocking 时为「需要先解决的问题 · n」），点击打开「核验详情」——人类语言的句子在前，`Q0x` 校验编号收在默认折叠的「技术细节」里；报告头部的芯片同步改成同一句话。
- **动作提示不跨页**（§30）：`info` / `success` 提示 6 秒自动消失，切换视图时清掉上一个页面的提示；错误与警告保留。
- **术语清理**：来源表的 `src_…`、对照页的报告 id 与 `hash …`、提案面板的 hash 全部移除；浏览器 gate 新增「五处页面全文不得出现 Qxx / synthesis / 内部 id / contentHash / grant」的检查（结果：全部未命中）。

### 测试

- `apps/research/tests/trust-ux.test.ts`（20 例）：导航只有三项且顺序固定、默认视图、研究范围入口、结果块（未解决 / 部分解决 / 不夸大 / 折叠 / 老 run 无结果）、单次动作材料按 id 取、提案五个状态的词与可决策性、零 delta、没形成提案时无接受控件、状态优先级（act/提案/复核/未解决/就绪）与六条事实、标签表里没有任何内部词、样式选项。
- `apps/research/tests/frontend-logic.test.ts` 更新：`parseRoute` 的 `view: null` 语义（地址不点名）与 `defaultViewOf` / `resolveView` / `PRIMARY_NAV` 的断言。
- `apps/research/tests/artifact-view.test.ts` 更新：报告头部芯片文案改为「需要进一步核验 · n」。
- 浏览器 gate：新增 `apps/research/scripts/verify-trust-ux.mjs`（29 例，真实 CDP 输入，含 13 张截图）。

## Step 3.6A 新增（本次工作产物）

本轮只修「用户看到的状态、结果与可执行操作必须可信」。没有重新设计产品、没有视觉重构、没有 PDF / Mermaid，没有改 Agent Core / Host / Protocol / Client，没有动 Ask / Research / Edit 的副作用契约、Frozen Revision、Action Budget、Guide min/max、Evidence 真实性边界。

### 提案可信：pending 必须意味着「可以接受」（`service.ts` / `tools.ts` / `artifact.ts`）

- **生成时预检**：`createProposal` 现在先把 `base + 替换内容` 组装成 candidate report，跑**与 Accept 同一个** `validateReport`，通过才写入 pending。以前只校验「章节存在 + 新 claim 的证据真实」，章节的内容义务要等到用户点了「接受」才被检查——真实验收里用户读完提案、按下接受，才被告知「Q03：章节没有 synthesis」。
- **一次修正机会**：预检失败时把问题原样返回给模型（`code: "proposal_invalid"`），同一个动作内允许再提交一次；第二次仍失败则 `code: "proposal_not_created"`，本次 Edit 不产生提案，第三次及以后同样被拒（没有循环）。
- **用户语言**：失败结果里 `userMessage` 是给用户的句子（「我准备的改写丢失了这一节必须保留的综合判断，因此没有提交为修改建议。报告正文没有改变。可以换一种写法重新尝试。」），`problems` 仍是给模型的修复指令（含 Q 编号、claim id、hash）。前端 `conversation-logic.refusalOf` 优先取 `userMessage`，`problems` 只出现在 run `activity` 这种开发者日志里。
- **不放松契约**：没有删除 synthesis 要求、没有降低 Evidence 规则、没有跳过 Claim 校验、没有绕过必需维度——目标始终是让内容满足契约，不是让契约迁就内容。
- **义务是保留项**：工具说明与 Edit 阶段指令都写明「用户说『改成纯文字 / 去掉表格』改变的是表达形式，不是这一节的内容义务」，阶段指令还从 blueprint 里取出目标章节的 `cognitivePurpose / requiredQuestions / budget` 一并给出（与校验读同一份 blueprint）。首版 Edit 仍然只有 Section content edit，不改变 Blueprint obligation。

### 比较表与提案表格：不允许空白（`artifact.ts` / `document.tsx` / `service.ts`）

- **真实原因（先在真数据上确认过）**：本机 `researchpage-data` 里 4 份 v2 报告的 comparison 表都存成 `columns` + `columnDimensions` + `rowSubjects` 齐全、`rows: [{cells: []}, …]`——**报告结构化数据本身就空**（A），presentation DTO 原样透传（B 排除），而 React 渲染器对「行没写到这一列」的分支渲染的是**既无文字也无状态的空 `<td>`**（C），CSS 只有 `color` 一条规则（D 排除）。真数据断言：修复前 4 份报告存有 16–24 个空单元格；修复后渲染结果 `emptyTd = 0`，每格都有词。
- **渲染兜底（§8）**：空单元格一律走 `CellBody` 的兜底文案，取自项目真实的 adequacy 状态——`missing → 证据不足`、`unassessed → 有材料，待核对`、`limited → 有限支持`、`conflict → 冲突 / 不可比`、有材料但没写判断 → `尚未写出判断`；没有覆盖记录也不留空。PlainTable 的短行补齐到声明列数，表格永远不是缺角的。
- **Artifact contract（§7）**：`required comparison matrix` 出现空白单元格（含「行根本没写到这一列」）判 **fail**，消息按「第 n 行第 m 列」定位。给旧报告留了台阶：`carriedOverSectionIds`（本次编辑没有触碰的章节）里的空白记为 **warning**——契约是给现在写的内容的，一条改不了比较表的新规则不该让合成章节的修改变得不可能。新建/重新发布的报告没有任何豁免，仍然全部适用。
- **Proposal 表格（§9）**：`tableGapsOf(提案里所有表格)` 在预检里先跑，任何一行有空格子（或行短于列）都会被拒绝并走同一次修正机会；空白表格不会显示给用户。

### 研究结果可信：先回答「问题解决了吗」（`domain.ts` / `outcome.ts` / `runner.ts` / `routes.ts`）

- **ResearchResolution**（不新建 domain graph）：`deriveResearchResolution` 从「本轮新增的 evidence 绑定到哪些单元格 + 本轮新增 assessment 的目标单元格」得到本次动作的作用范围，再按这些单元格**当前的真实覆盖状态**给出 `resolved / partially_resolved / unresolved`：全部 `reviewed`（直接、正文级、支持）才算解决，部分算部分解决，全是背景或没落到任何单元格就是未解决。
- **语义**（§12）：两篇背景论文会写进 source/evidence/assessment，但永远到不了 `reviewed`，因此**结构上**解决不了任何问题——不会因为 `sourceCount > 0` 变成 resolved。没有百分比。
- **用户结果**（§13）：动作结束后写回 run 记录（`ResearchRunRecord.outcome`），句子里先给结论（「没有找到能直接回答这一问题的材料：… 仍然只有背景或间接材料。本轮新增 2 篇背景材料。报告正文没有改变。」），工具次数降级为次要素材。
- **「检查本轮新增证据」的上下文**（§14）：resolution 带着 `newSourceIds / newEvidenceIds / newAssessmentIds / supportingEvidenceIds / targetCells / remainingGap`，前端 3.6B 可以直接打开本轮材料而不是整个矩阵。本轮只做 DTO/API，没有改正式前端交互。

### 提案增量：真实 delta（`service.ts` → `proposal.researchAdded`）

- 用户动作签授权（`issueGrant`，`origin: "user"`）时快照 source / evidence / assessment 的 **id 集合**；`researchAdded` 改成 id 差集的大小。以前它写的是 `repo.listSources(task.id).length` 这类**项目总量**，所以「本次修改没有新增检索」也会显示「修改期间新增 17 个来源」。
- 0 就是 0：提案面板在该情况下显示「本次修改没有新增研究材料。」，不再给含糊状态。

### 来源角色：unknown ≠ none（`presentation.ts` + `sources.tsx`）

- 项目读数的 `sourceRoles` 给出 total / classified / unknown / primary / byRole 与一句 `userMessage`：全部未分类时是「原始论文 / 一手材料：未知（12 个来源尚未分类）」，部分分类时是「…1 个已确认；另有 2 个来源尚未分类（已分类 2 / 4）」——只有真的全部分类且为 0 才会说 0。
- **顺带修掉一个真实缺陷**：`service.read` 完成读取时用**角色写入之前**拿到的 source 副本回写同一行，把模型刚刚声明的 role 抹掉了（本机项目 11 个来源全部显示「未声明」就是这个原因之一）。现在 role 在读取完成时被显式保留。

### 状态语义：正交的 presentation DTO（`apps/research/src/server/presentation.ts`）

bundle 新增 `presentation`，六个字段各自回答一个问题，都由真实状态推导，都带 `displayName` / `userMessage`：

- `runState`（preparing / researching / report_ready / editing / failed）；
- `evidenceCoverage`（n / m 个比较项**已有材料**，并写明「材料覆盖不等于结论完成」）；
- `unresolvedResearch`（unresolved / limited / incomparable / resolved 四个计数）；
- `reportReview`（clean / needs_review + 原因）；
- `artifactQuality`（passed / warnings n / blocking n）；
- `sourceRoles`（见上）。

没有新状态机，没有改大布局。顶栏那一句改成从读数派生（有 `needs_review` 或仍有未决项时不再说「无待查项」），来源页那句改成读 `sourceRoles.userMessage`。

### 引导文案安全（`runner.ts` 的 guide 指令）

- 不推翻「one decision → one field」：引导指令仍然只写 `fieldTarget`，但明确允许模型在 `leadIn` 里说「我注意到你还提到了 X，后面我会继续和你确认」，并禁止说「我已经把你刚才说的都改好了」。没有实现 multi-field patch。

### 测试

- `packages/plugin-research/tests/edit-preflight.test.ts`（8 例，Scenario 1 的真实复现）：义务丢失的改写不会进入 pending、修好后可以接受且接受真的生效、两次失败后动作结束为 `proposal_not_created` 且不再循环、报告自身表格空白时仍可改别的章节（warning 而非 fail）、提案自带空白表格被拒、Edit 未检索时 delta 为 0、有检索时只算本次增量。
- `packages/plugin-research/tests/research-resolution.test.ts`（7 例，Scenario 2 的真实复现）：只有背景材料 → unresolved、一条直接一条背景 → partially_resolved、全部直接 → resolved、第二次动作没有新材料时 delta 为空、用户文案不泄露 Q 编号 / synthesis / claim / hash、纯 fixture 推导一致。
- `packages/plugin-research/tests/artifact-quality.test.ts`（+3）：比较表空白 → fail（含行列定位）、写明「证据不足」→ pass、旧报告既有空白 → warning 且不阻塞编辑。
- `apps/research/tests/presentation-status.test.ts`（8 例）：unknown 不等于 0、四个状态字段互不代偿、runState 的五种形态。
- `apps/research/tests/prompt-copy.test.ts`（3 例）：Edit 指令带目标章节义务、工具契约写明保留义务与一次修正、引导指令不允许过度承诺。
- `apps/research/tests/artifact-view.test.ts`（+1 并加强 1 例）：真实报告形状（`rows: [{cells: []}]`）渲染出 6 个有文字的格子、没有空 `<td>`；空单元格兜底为「证据不足 / 有限支持」。
- `apps/research/tests/editing-api.test.ts`（+2 组断言）：Edit 与 Research 动作结束后的 run `outcome`（含 resolution 与 delta）确实到达 bundle，且 `researchAdded` 等于本次动作的 delta（不是项目总量）。

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
## Step 3.5C-B 新增（本次工作产物）

本轮只做两件产品交互修正：引导式规划变成对话，报告助手变成与文档地位相当的 50/50 协作工作区。没有改后端语义（引导深度契约、readiness、Action Budget、Action Grant、Proposal、Revision、Claim Contract、Blueprint、Evidence 边界都没动），没有重做首页 / 矩阵 / 来源 / 设置 / PDF renderer，没有引入 Mermaid、Upload、MCP、第二 Blueprint 或 Tauri。

### 引导式规划：从表单变成对话（`guide-logic.ts`、`components/brief-guide.tsx`）

- **对话是推导出来的，不是前端记的**：`guideTranscript(brief)` 把服务端已有的 `guide.decisions`（问题 / leadIn / 选项 label / answerText）与当前 `active` 问题拼成一条条消息——每次决策留下「助手一问 + 用户一答」，正在问的那条可以回答，收束时是助手最后一段总结。刷新页面重建的是同一段对话，前端没有第二份历史。
- **一轮一个决策的语义没变**：选项与自由回答仍然走 Step 3.5A 的同一个 Guide API、写同一份草稿；UI 像聊天并不允许一次改多个字段（§8）。
- **视觉语法**（`public/styles.css` 的 `.rp-chat`）：助手左对齐、无气泡、小标签「助手」，leadIn 与问题都走 RichMarkdown（禁止 raw HTML，sanitize 后仍无 `rehype-raw`）；用户稍微右对齐、浅底、最大宽度 75%、小标签「你」；选项嵌在提问那条消息里；决定结果是一行轻量回执（`✓ 已更新「研究目标」`），不是第三张卡片。
- **进度说两条边界**：`关键决策 3 / 至少 5` → 达到下限后改成 `关键决策 5` 并写明「够清楚就可以开始研究，也可以继续完善」，到上限则说明「已经问到上限」。数值来自 DTO 的 `minDecisions / maxDecisions / readiness`，前端不复制服务端常量。
- **用户自己的出口**：`[方案已经够清楚，确认并开始研究]` 常驻在头部（二级动作，不与问题争主视觉），`canConfirm` 为假时禁用并直接写出原因（来自 `brief.validation.problems`）。
- **早退被拒的兜底**（§11）：`guideStalled(brief, busy)` 只在那一种状态给出 key——`complete === false && active === null && !busy && 已经有决策`——并且 key 里带 `taskId/version/readiness`，所以「同一个状态只自动重试一次」是逻辑上可验证的，不是靠计时器侥幸：面板等 6 秒再确认一次，仍然没有问题时改成「助手没有生成下一项决定。[继续引导]」交给用户。正常状态（还没开始、问题在跑、问题待答、已收束）都不会触发它。
- **收束不空页**：服务端 complete 时，最后一条助手消息说明方案已经完整并列出摘要（对象数 / 维度数 / 篇幅 / 读者），附「确认并开始研究 / 查看结构化方案」。
- 切回结构化再切回来，对话历史与服务端最新草稿都在；结构化改过的字段不会在引导里被重复提问（3.5C-A 的 readiness 口径仍然生效）。

### Studio：阅读 / 50-50 协作（`views/studio.tsx`、`components/dock.tsx`）

- **三种形态**（`studioLayout()`）：`reading`（没有面板，文档居中）、`inspect`（速览：证据 / 来源 / 论断 / 章节 / 修改建议，仍是 376px 的 Dock，文档仍是主体）、`coedit`（助手工作区打开，左右各半）。打开助手即进入 coedit；在协作模式里看证据、看提案仍然是 coedit（右栏切换主题，不退回速览宽度）。
- **默认 50/50 与分隔条**：`grid-template-columns` 用 `--rp-coedit-split` 发布比例（默认 50%，`clamp` 在 40–60）；分隔条是 1px 视觉线 + 约 11px 抓取区、`z-index` 高于面板（否则半个抓取区会被右栏吃掉）、`sticky` 到视口高度（否则一条跟文档一样高的线让「抓得到的地方」落在屏幕外）。支持指针拖动、左右方向键（每次 2 点）与双击复位。实测 1440：拖动 −140px → 42%，继续拖 → 停在 40%。
- **工作区上限 1760px**：1920 下两侧仍各 879px，助手不再是 520px 封顶的侧栏（§33）。
- **文档在半屏里**：`rp-canvas-scroll` 让出页面边距（26/24），sheet 内距收到 34px，正文实测 604px（1440）/ 640px（1366，正文一栏 683）；`.rp-doc__compare` 的负边距（那是为全宽页设计的出血）在半屏里取消，比较矩阵改为在自身列内横向滚动——页面级横向滚动与画布级溢出都实测为 0。整个工作区不再有横向滚动。
- **工具栏密度**：协作模式下隐藏只在别处重复的信息（主题菜单、工具栏里的「待复核」chip、状态的英文长文），研究对象动作栏收成图标（保留 Tooltip），研究边界 chip 限宽省略；1366 / 1440 / 1920 下工具栏都是一行且没有被裁切（`scrollWidth === clientWidth`）。
- **关闭即回到阅读**：右栏完全消失、文档重新居中、不留半屏空列；再次打开恢复对话、目标、composer 草稿与指令方式。

### 助手工作区：对话 + 内嵌动作（`components/assistant.tsx`、`conversation-logic.ts`）

- **对话是项目自己的记录**：`conversationOf(bundle, answers)` 取的是"人发起过的 run"——含有 `userText` 的 ask/gap/edit——按时间排序（最近 10 条）。Agent 自己的阶段（初次研究、自动补查、写作）不在对话里，因为它们不是用户说过的话。
- **用户原话是持久化的**（一处 presentation 级别的补充，见下）：run 记录里新增可选 `userText`，由 runner 在签发 Ask / 用户补查 / Edit 时写入；它是「用户说过什么」的唯一来源，不做解析、不改任何语义。刷新与重启后对话仍然可读。
- **助手说的话分两类**：Ask 的回答是模型自己的文字（RichMarkdown）；补查与修改的说明是产品写的，因为这两类 run 的叙述是模型的思考过程（gate 断言里检查它不会把工具名或原始 JSON 露出来）。
- **动作内嵌**：补查完成 → 一句结论 + 本轮统计（检索 / 读取 / 覆盖评估）+「正文没有改变」+ `[检查新证据] [基于这些材料修改本节]`；额度用尽时结论那句改成「这次补查已经用完了本轮的检索额度。」，下一条指令照常获得新额度（§26）。Edit → 提案以窄边块内嵌在对话里（现在 / 修改后 / 论断 / 证据变化 / 接受或放弃），接受后这段记录留在原地，而不是把对话换成一页。
- **步骤列表**（折叠）只说中文动作名（`TOOL_LABELS`），失败时标「被拒绝」，不再打印工具名与结果 payload（§22）。**被拒绝的调用不算工作量**：宿主信封对服务端拒绝的调用仍然报 `ok: true`（工具跑完了，是服务端说了不），计数与「额度用尽」的判断因此必须看结果体里的 `{"ok":false}`——否则一次动作会说自己检索了 3 次，而真实情况是检索 2 次、被拒 1 次。
- **目标行**（§30）：右栏顶部一行 = 「助手」+ 当前对象（项目 / 章节 / 论断 / 比较项 / 比较表）+ 清空回项目；编辑模式在这一行右侧是章节下拉框。
- **composer**：输入框默认约 76px 高（≥72）、可长到 9 行；指令方式（自动 / 提问 / 补查 / 修改）降级进 composer 的工具条，提交按钮在同一条上；placeholder 按模式变化；每次动作的安全说明只有一句（补查：补充材料，不自动修改报告；Edit：生成修改建议，接受前正文不变；Ask：只回答问题，不写入项目数据）。
- **额度文案**：补查模式下 composer 显示的是**这次动作自己的额度**（来自 runtime 的 `actionAllowance`），动作在跑时换成 `bundle.actionBudget` 的实时剩余；不再出现任何「项目还剩 n 次补查」的项目口径文案。
- **证据不迷路**：协作模式里从对话点开证据/缺口，仍在同一个右栏、仍是协作布局，并在标题上方给出 `← 返回对话`（`data-testid="back-to-conversation"`）；返回后对话原样还在。

### 后端改动（全部是 presentation adapter，未触碰语义）

- `packages/plugin-research/src/domain.ts`：`ResearchRunRecord` 增加可选 `userText`（JSON payload 列，无迁移；老记录读回为空）。
- `apps/research/src/server/runner.ts`：`StageRequest.userText`，只在 Ask / 用户补查 / Edit 三个由人发起的 stage 上设置并随 run 记录落库。
- `apps/research/src/server/routes.ts`：bundle 的 `runs[]` 增加 `userText`；bundle 增加 `actionBudget`（`service.actionBudgetOf(sessionId)`，只有在用户动作正在跑时非空）；runtime 增加 `actionAllowance`（一次用户补查的额度，取自 `USER_RESEARCH_BUDGET`）。
- `apps/research/src/browser/components/document.tsx`：报告 frame（研究问题 / 读者 / 范围）的文字也过 `withoutInternalIds`。这是报告正文之外少数几处模型写的文字之一，实测某个真实报告把 `sub_…` 写进了「范围」，读者因此会在正文页看到内部 id；按产品既有规则（内部 id 不出现在读者读到的文字里）修掉，未改任何版式或内容。
- 没有新增路由、没有改 Guide / 预算 / Proposal 语义、没有引入聊天子系统。

### 测试与浏览器 gate

- `apps/research/tests/guide-conversation.test.ts`（15 例）：对话重建（5 个决策 → 11 条消息、顺序与可回答的那一条）、用户原话（answerText / 选项 label / freeText 的取用顺序）、leadIn 走 RichMarkdown（强调渲染 + `<script>` 不成为元素）、`guideStalled` 的四种正常状态 + key 命名、进度两条边界、用户出口（可确认 / 不可确认带原因）、收束消息与摘要、空闲开场句。
- `apps/research/tests/workspace-conversation.test.ts`（11 例）：对话只取人发起的 run（agent 自己的阶段被排除）、Ask 的回答挂到自己的那一轮、步骤说成中文动作名且不含工具名/JSON、拒绝原因转述、最近 10 条上限、额度用尽的判定（只对补查）、提案按时间窗口归属到产生它的那次动作、分隔比例（默认 50 / clamp 40–60 / 拖动算术）、三种布局形态。
- `apps/research/scripts/verify-workspace.mjs`（+新增用例，CDP 真实输入）：引导段现在驱动真实对话——0 个决策的空闲态、逐个决策（其中一次用自由回答，并断言原文出现在用户那一轮）、3 / 5 / free-text 截图、进度口径、第 3 个决策时确认按钮可用、刷新后逐条一致的对话、切结构化再切回来历史仍在、guide run 数有界（每决策一问，最多再多一次自动恢复）、出现早退状态时能自动恢复（没出现则如实 SKIP）；Studio 段新增 50/50 与分隔条（真实拖动 + 上下限）、1366/1440/1920 三档两栏与工具栏不裁切、composer ≥72px、指令方式在 composer 内部、额度文案不含项目口径、补查两轮（第一轮结束后第二条指令照常发起）、证据 → 返回对话、提案内嵌在对话里且接受后只改目标章节。
- 截图（gitignored）：`guided-0/1/3/5`、`guided-free-text`、`studio-reading-1440`、`studio-coedit-1366/1440/1920`、`studio-ask-1440`、`studio-proposal-1440`、`studio-evidence-1440`。



## Step 3.5C-A 新增（本次工作产物）

本轮只改后端语义，不动正式前端视觉。三件事：引导式规划的深度契约、引导对话的数据、用户自己发起的 Research 的预算。没有做前端对话界面、Studio 50/50、Report renderer、PDF、Mermaid、Upload、MCP、第二 Blueprint、Tauri，也没有改 Claim Contract / Frozen Revision / Proposal semantics。

### 引导深度契约（`brief.ts` / `service.ts`）

- `GUIDE_MIN_DECISIONS = 5`、`GUIDE_MAX_DECISIONS = 7`（替换原来的单一 `GUIDE_DECISION_LIMIT = 5`）。承诺是**下限**：不足 5 个真实决策，Agent 不能结束引导；上限 7 由程序自动收尾，避免变成 endless onboarding。
- **提前 complete 会被拒绝，而且是可重试的**：`proposeGuideQuestion` 在 `readiness < GUIDE_MIN_DECISIONS` 时返回 `ok:false`（模型可读的 problems + guidance：「当前只完成 n/5 个关键决策…请继续围绕程序指定的字段 X 生成一个真正有区分度的问题」），**不写 `guideClosed`**，同一个 run 里模型可以再次调用 `propose_guide_question` 写出真问题（`brief-api.test.ts` 用脚本化模型验证了这条同 run 重试路径）。
- **`guideReadinessDecisions(task)`**（`brief.ts`）：把阶梯字段里状态不是 `suggested` 的个数算作「人做过的决定」——引导答案把字段置为 `confirmed`，结构化编辑置为 `edited`，两者都算；Agent 的默认 `suggested` 一个都不算。没有 score、没有权重。混合使用两种模式的人因此不会被机械重复提问：结构化改过的字段直接被阶梯跳过，同时计入 readiness。
- **用户自己的出口不受下限约束**：`BriefView.canConfirm`（= 未确认 && 草稿有效）随 DTO 下发；第 3 问就确认开始研究是允许的，第 5 问之后才出现 `guide.complete`。

### 引导对话数据（`guide` DTO / `GuideQuestion`）

- `GuideQuestion.leadIn`（可选，历史问题读为空字符串）：1–3 句对话过渡，由模型在写问题时一起给出，服务端限长 500 字并拒绝 HTML 标签（普通 Markdown 文本允许）；它不写简报、不是研究数据，STEP 3.5C-B 的对话界面用 RichMarkdown 渲染它。
- `GuideAnswerRecord.answerText` / `selectedOptionLabels`：答案以用户当时选的措辞记录（选了选项就是选项 label，自由回答就是原文）。历史记录**不做迁移**，读取时从 optionIds → 当前问题的 option label 推导（`guideAnswerTextOf` / `guideAnswerLabelsOf`）。原始 ids 保留用于审计。
- 所有 DTO 新增字段都在 `BriefView.guide`：`minDecisions` / `maxDecisions` / `readiness`（`limit` 保留 = maxDecisions，3.5B 页面继续可用），decisions 每条带 `leadIn` / `answerText` / `selectedOptionLabels`，active 带 `leadIn`。
- **下一问的 prompt 带上下文**（`runner.ts: stageInstruction({stage:"guide"})`）：当前简报的 topic / purpose / audience / subjects / dimensions / focus / exclusions / lengthTarget，加上最近 2 个已回答决策（问题 + 用户选择 + 写入字段，`GUIDE_CONTEXT_DECISIONS = 2`），并写明「至少 5 个、最多 7 个」的深度契约。问题因此是在承接刚才的回答，而不是每次重新发问卷。

### 用户动作预算（`semantics.ts` / `service.ts` / `runner.ts`）

- **两套预算分开**：项目预算（`task.budget` / `task.usage`）只约束 Agent 自主的研究（initial research 与自动 gap 轮）；用户明确发起的动作（Research 动作、Edit 的 allowResearch 补查）走**自己的 Action Grant budget**。
- `ActionGrant.origin: "pipeline" | "user"`（`createGrant` 默认 `pipeline`，只有应用为用户动作签发时才写 `user`）；`ActionUsage { searches, reads, gapRounds }` 活在 service 内存里，key 是 grant id，随 grant 一起产生与消失（重启即失效，与既有授权语义一致，不做 quota ledger）。
- 默认额度（`semantics.ts`）：`USER_RESEARCH_BUDGET = { 2 searches, 4 reads, 2 gapRounds }`、`EDIT_RESEARCH_BUDGET = { 1 search, 2 reads, 1 gapRound }`。一条指令有界，下一条明确指令重新获得新的一份。
- `budgetRefusal` 按 active grant 分流：user 动作只检查该动作自己的用量（"本次补查的检索次数已用完（2/2）"），**不检查** task 的 deadline / maxSearches / maxReads / maxGapRounds；pipeline 行为一字未变。因此「自动研究花完额度」不再导致「用户以后再也无法补查」，一个几小时前完成的项目仍然能继续补查（仍受 runner 的 stage timeout 约束）。
- **gapRounds 语义**：`assess_coverage(gapRound=true)` 只有在 pipeline 授权下才增加 `task.usage.gapRounds`；用户动作下改为记在该动作自己的 usage 上，不污染自动补查计数。
- 工具结果的分账：`search_sources` / `read_source` / `assess_coverage` 返回 `budgetScope: "project" | "user-action"`，`searchesRemaining` / `readsRemaining` / `gapRoundsRemaining` 反映**当前生效的那一份**；`load_research_state` 额外给出 `actionBudget`（只在用户动作里非空），项目 usage 继续作为累计 telemetry 累加。
- `startResearchAction` 删掉了「`usage.gapRounds >= maxGapRounds` → 永久拒绝」这条判断：每次用户发起都签发新的 user-action grant，返回 `actionBudget: { searchesRemaining, readsRemaining, gapRoundsRemaining }`（不再是 `gapRoundsRemaining` 这种项目口径）。route 的 409「补查轮次预算已用完」分支随之删除，任务不存在才 404。
- **Step 1 的安全边界没变**：用户 Research 依然只能改 Source / Snapshot / Evidence / Assessment，不写报告正文，完成后 `reportNeedsReview` 照常置位，Frozen Revision 不动；Edit 的补查仍然只为目标章节服务，接受前正文不变。

### 测试

- `packages/plugin-research/tests/brief-guide.test.ts`（40 例，+7）：O 段（深度下限 / 上限自动收尾 / 用户自己的出口 / 结构化编辑计入 readiness 且不被重复提问）与 P 段（leadIn、answerText、选项 label、历史记录读取时推导、HTML 与超长 leadIn 拒绝）。旧的「5 个决策后停止」改写为「到 7 个上限由程序自己收尾」。
- `packages/plugin-research/tests/editing-semantics.test.ts`（21 例，+5）：J 段覆盖 I–O——项目预算与 deadline 都花光后用户动作仍能跑且不动正文（I/M/O）、一次动作的 2 次检索 / 4 次读取边界（J，超出只拒绝本次动作的额外调用）、第二条指令重新拿到额度（K）、用户 `gapRound` 不增加自动计数而 pipeline 仍按 task 预算拒绝（L/N）。
- `apps/research/tests/brief-api.test.ts`（6 例，改写 2）：真实 HTTP 链路上验证深度下限——第 2 个决策后模型声明 complete 被拒（`4/5`，其中 2 个来自结构化编辑），同一 run 里被纠正后写出真问题；`canConfirm` / `minDecisions` / `maxDecisions` / `readiness` / `leadIn` 都在 DTO 上；下一个 guide stage 的指令确实包含上一个决策的答案文本与深度契约（用例 H）。
- `apps/research/tests/editing-api.test.ts`（5 例，改写 1）：删掉了「测试先把 maxGapRounds 抬高到 4」这个为了绕开旧 bug 的补丁——现在把项目 usage 推到 gapRounds 满 + deadline 过期，用户补查仍然 202，`actionBudget` 如实返回，报告 hash 不变、`reportNeedsReview` 置位、自动 gapRounds 不动；第二条指令再拿一份新额度；Edit 的两次查找第二次被 `（1/1）` 拒绝，提案照常生成且只作用于目标章节。

## Step 3.5B 新增（本次工作产物）

本轮只修四件事：简报的交互、报告与助手的协作布局、AI 文字的渲染、交互式报告里几处明显的表达问题。没有重做首页 / 矩阵 / 来源 / 设置 / PDF renderer，没有引入 Mermaid、Upload、MCP、第二 Blueprint 或 Tauri。

### Research Brief 页面（`apps/research/src/browser/views/brief.tsx`）

- **两种模式，一次只显示一种**：`[结构化编辑] [智能引导]` 是页面唯一的模式开关，默认结构化。切换模式时向服务端重新读取（`refresh()`），两侧都读 `bundle.brief` —— 没有前端镜像，也没有第二份草稿。
- **结构化模式不是表单墙**：字段以「可直接改的文档」呈现 —— 研究问题与读者是一段可点击进入编辑的正文（`InlineText`，失焦提交、Esc 放弃、Ctrl/Cmd+Enter 提交），比较对象与维度是可编辑的行（名称 / 说明 / 要回答的问题），关注点是可编辑 chip，篇幅带三个建议值。整页只有报告结构一块是只读的，并写明它由蓝图派生。
- **保存模型**：改动不逐字符 PATCH；每次提交都带 `expectedVersion`。成功的写入把服务端的值显示出来；**被判定为过期（409 stale）时不覆盖读者输入**——本地的文字留在屏幕上，页面提示「研究任务刚刚发生了变化，请重新确认这一项」，并给出「用最新版本重试 / 放弃我的修改」两个明确动作。列表字段（对象 / 维度）在新增一项还没起名字之前不会提交，已有项允许被清空（那是一次真实编辑，服务端会用问题清单回应）。
- **验证问题落在字段上**：`brief.validation.problems` 按声明词表映射到字段（`brief-logic.ts: problemFieldOf / problemsByField`），写在该字段下方并把它标红；「确认」在草稿不完整时不发送注定失败的请求，而是滚动并聚焦到第一个有问题的字段。服务端拒绝确认时，返回的问题清单同样按字段映射。
- **确认区**在页面底部（sticky），用一句话说清这次研究将围绕什么进行（对象数 · 维度数 · 篇幅），主动作是「确认任务并开始研究」；「换一个主题重新建立任务卡」退到「更多」菜单里，不再和主动作竞争。
- **已确认的简报**是干净的只读记录：没有可编辑控件、没有模式开关，显示「研究任务已确认」，并提供「去研究矩阵 / 打开报告」。

### Guided Mode（`apps/research/src/browser/components/brief-guide.tsx`）

- 一次只呈现一个决策：问题、一句 `whyThisMatters`、2–5 个选项卡（原生 radio，可键盘操作）+ 自由回答框，底部一个提交按钮。没有对话历史、没有气泡。
- 提交后显示一次回执（`✓ <字段> 已更新：<你选的选项> → 已写入 Research Brief`）并附「查看结构化 Brief」；随后服务端的下一个问题到达就自动接上。进度写「关键决策 n / 最多 limit」，上限来自 `brief.guide.limit`（DTO 便捷字段，不让前端复制服务端常量；Step 3.5C-A 之后它等于 `maxDecisions` = 7，同时下发了 5 这个下限与 `readiness`，正式对话界面的呈现属于 STEP 3.5C-B）。
- 必须处理的异步：`guide/next` 是 202 + 轮询，页面有明确的「正在准备下一个问题」状态；模型声明 `complete` 时收束成「研究方案已经足够明确」+「查看研究方案 / 确认并开始研究」。过期问题（版本或目标字段变化）显示提示并要求重新确认，不自动重放。
- 已做过的决定折叠在「已经做过的决定（n）」里。

### Studio：阅读 / 协作（`views/studio.tsx`、`components/dock.tsx`、`components/assistant.tsx`）

- **一种工作区，两种宽度**：右侧仍然只有一个上下文面板，宽度由内容决定 —— 证据 / 来源 / 章节是 376px 的速览 Dock，助手与修改建议是 `clamp(420px, 32vw, 520px)` 的工作区。宽度通过 `--rp-dock-w` 发布，布局与 sticky chrome 读同一个变量。
- **Reading Mode**：没有面板时文档居中（`data-layout="reading"`）。**Co-edit Mode**：打开助手后文档与宽栏并排，实测 1440 下文档占 66%、正文阅读宽度 755px；1366 下文档 873px / 阅读 729px，无横向滚动、工具栏不被挤成两行；1920 下助手封顶 520px、文档封顶 920px。
- **布局门槛按测量而不是设备名**：`min-width: 1350px` 时并排，更窄时浮层覆盖（借用既有的 `--rp-dock-offset` 机制）。
- **助手工作区**（`assistant.tsx`）：顶部一行是作用对象（`项目 / 章节 / 论断 / 比较项` + 具体名字，来自当前选中对象，可一键退回整个项目）；中间是动作记录（Action Card，宽栏里能读 600–1500 字回答）；底部是 composer —— 模式（自动 / 提问 / 补查 / 修改）是 composer 的一部分，提交按钮的文案就是动作本身（提问 / 补查材料 / 生成修改建议），旁边一行说明这条指令会做什么。
- **Action Preview**：只有 Edit 有副作用提示，提交前在 composer 上方出现一条三行 strip（将修改 / 可能 / 正文），不弹 Modal。没有选中章节时 preview 明写「还没有选择章节」并禁用提交，而不是发一个注定被拒的请求。
- **动作记录说真话**：Edit 的卡片只在这次 run 真的起草了提案（读 run 自己的 `propose_section_edit` 记录）时才说「已就绪」；没有产生提案时显示「这次没有产生修改建议，报告正文没有变化」，并把工具的拒绝原因（例如「已有待接受的修改提案」）原样转述。
- **草稿不丢**：composer 的文本 / 模式 / 目标存在 store 里，关闭助手再打开仍在；只有切换项目才清空。

### RichMarkdown（`components/markdown.tsx`，本轮新建）

- `react-markdown` + `remark-gfm` + `rehype-sanitize`；**没有 `rehype-raw`**，raw HTML 从不是元素，再由 sanitize 兜底（`script / iframe / style / 事件属性 / javascript:` 全部被拒）。链接一律新窗口 + `noopener noreferrer`（内部锚点除外）。
- 支持：段落 / h1–h4 / 粗斜 / 有序无序与嵌套列表 / 引用 / 链接 / 行内代码 / 围栏代码 / GFM 表格 / 分割线 / 删除线 / 任务列表。
- 视觉按 ResearchPage 的语法写（13.5px / 行高 1.72 / 74ch 上限 / hairline 表格 / 左侧细线引用 / 表格与代码各自横向滚动），不是 GitHub README 默认样式。
- 用在：Ask 的回答、动作说明、修改建议的理由。（报告正文仍由 document.css 的 artifact 语法渲染，两者不混用。）
- `RichInline` 是它的行内版本，用来渲染报告正文里模型写的 `**强调**` 与反引号：只允许行内元素，块级结构被 unwrap，因此段落里的 `**` 不会变成星号，也不会把段落变成列表。
- **AI 文字里的内部 id 会被摘掉**（`document-logic.ts: withoutInternalIds`）：模型看得见它引用的证据 / 对象 id，偶尔会写进回答或表头里；摘掉的是机器标识符本身，句子不动。

### 交互式报告（`components/document.tsx`、`document-logic.ts`、`public/document.css`）

- **比较表重排成矩阵**：报告的表是「一行一个对象、一列一个研究问题」，读起来是六列窄文字；画布上按「行 = 研究问题（名称 + 它要回答的问题）、列 = 比较对象」呈现，单元格只放有界判断，点击进入 Inspector 看证据与条件。表没有声明 `columnDimensions` / `rowSubjects` 时按报告原样呈现，不替它选方向。
- **空单元格不空着**：报告没写判断的格子显示该格当前的状态词（`待查 / 有材料，待核对 / 有限支持 / 冲突`，取自矩阵），可点击直接打开这一格的证据面板；不可直接比较 / 有限可比由 claim 的 `conditions.comparability` 决定，以文字标在格子里。没有排名、没有绿=好红=坏。
- **研究边界（Research Boundaries）**：矩阵里所有未确立的格子按研究问题聚合，每项给出状态计数、一句话原因、涉及对象；完整格子列表在「查看全部缺口」里。为此不再把十几个 `A × B limited` 铺在正文里。冻结版本显示自己的快照，不带今天的矩阵状态。
- **质量提醒**：正文顶部不再打印内部 warning 列表，只留一句用户语言的摘要（`n 处义务未完全达成，正文里已如实写出`）与「n 项需要进一步核验 → 研究边界」；校验明细（原始句子）在核验模式下默认折叠。
- **机制块**按输入 →（↓）步骤 →（↓）输出呈现，代价与权衡 / 什么时候不成立并列在下方；连接线用 CSS 画，不依赖字体里的箭头字形。步骤自带编号时不重复编号。
- **内部 id 不再出现在读者看的文字里**：表头与正文里的 `（dim_item1）`、`（sub_graphrag）` 这类括号标识符被摘掉（`readerText`）；对象与维度的名字改用项目自己的简报（`nameMaps`），取不到名字时留空而不是回落到 id。唯一的例外是校验明细里的原始 warning 句子，它按 §37 只出现在核验模式的折叠里，并保留 claim id 以便核对。

### 后端改动（全部是 presentation adapter 或缺陷修复，未触碰语义）

- `apps/research/src/server/routes.ts`：三处拒绝响应在 `error`（拼接后的句子）之外**多带一个 `problems` 数组**，让页面把每条问题放回它所属字段，而不必反过来按标点切分句子。
- `apps/research/src/server/runner.ts`：**修复 run 的动作记录被清空**。`transcriptOf` 读的是 client 快照里该 run 的 live timeline，而 run 一落地 live 就没有了；原来每次轮询都无条件覆盖 `record.activity`，于是每个 run 最终都记录成 0 步（动作卡里的「这次动作做了什么」永远是空的）。现在只在读到内容时覆盖。
- `packages/plugin-research/src/service.ts`：`BriefView.guide` 增加 `limit`（引导决策上限），避免前端复制服务端常量。
- `apps/research/tsconfig.json` 增加 `"jsx": "react-jsx"`：让 Node 那侧的测试项目也能 type-check 被测试 import 的 `.tsx`（`apps/web/tsconfig.json` 早已如此）。
- `apps/research/package.json` 新增三个依赖：`react-markdown@10.1.0`、`remark-gfm@4.0.1`、`rehype-sanitize@6.0.0`。未引入 Markdown editor、MDX 或任何 HTML 渲染开关。

### 测试与浏览器 gate

- `apps/research/tests/markdown.test.ts`（9 例）：RichMarkdown 的渲染与拒绝——段落 / 标题 / 列表 / GFM 表格 / 引用 / 强调 / 行内与围栏代码 / 外链目标与 `noopener`；`<script>`、`<iframe>`、`<style>`、`onerror`、`onclick`、`javascript:` 一律不出现在产物里，且被拒的标签的**文字仍在**；`RichInline` 不允许句子变成文档；答案里的内部 id 被摘掉。
- `apps/research/tests/brief-logic.test.ts`（15 例）：服务端问题 → 字段的映射与顺序、第一个要修的字段、行的 patch（保留 id、新增不带 id）、同构判断、未命名的新行不提交、移动行不丢 id、关注点集合、引导决定的回执措辞、确认摘要。
- `apps/research/tests/artifact-view.test.ts`（13 例，`renderToStaticMarkup`）：两种模式下读者能看到的文字里没有任何内部标识符；比较矩阵的行是维度名 + 研究问题、列是对象名；没有声明框架的表不被强排成矩阵；不可直接比较 / 有限可比出现在格子里；空格子一定写着状态词、并可以打开；研究边界按问题聚合且冻结版本不带今天的覆盖状态；顶部摘要句。
- `apps/research/scripts/verify-workspace.mjs` **重写**为 50 例真实输入用例（CDP，`Input.dispatchMouseEvent` / `Input.insertText`）：起始页、建立任务卡、简报的两种模式与结构化编辑（真的 PATCH + 版本递增 + 字段状态）、新增维度保留原有 id、不完整草稿把问题写在字段上并拒绝确认、引导问题 / 选项 / 回执 / 切回结构化看到同一份草稿、确认后冻结与矩阵一致、只读记录与写入上锁、报告工作台的阅读 / 核验、比较矩阵、研究边界、机制块、内部 id、质量提醒、证据检查器的两个问题、选中对象的动作栏、协作模式下的宽度与不横向滚动、关闭助手回到阅读且草稿保留、Ask / 补查 / Edit（含提案待接受时正文不变与接受后只有目标章节改变）、来源 / 模板 / 设置。截图写到 `--shots`（gitignored scratch），不进仓库。


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

- **问题由程序选题、模型写题**：新增 `guide` stage（`ResearchStage`）与 `propose_guide_question` 工具。程序按固定阶梯（purpose → audience → subjects → dimensions → focus → exclusions → lengthTarget）决定「下一件最值得确认的事」，**跳过用户已经决定的字段**；模型只负责措辞、`whyThisMatters` 和 2–5 个候选选项。当年的收尾规则是「5 个决策后停止或由模型声明不值得再问」，该规则已被 Step 3.5C-A 的深度契约取代（下限 5、上限 7、提前 complete 会被拒；见上）。
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

- 可信性与协同修改（Step 3.6A 后仍存在的限制）：
  - **旧报告的比较表仍然是空的**（本机 4 份 v2 报告实测 16–24 个空单元格）。契约现在拒绝再产生这种内容，渲染层也为每一格给出真实状态词，但**没有改写既有数据**：要真正修好这些报告，需要重写它们的 comparison 章节（属于 artifact 质量，不在本轮范围）。
  - 因此空白单元格的规则对**本次编辑没有触碰的章节**记为 warning，而不是 error——否则「改合成章节」会因为「比较表是先前的空表」被拒绝，那条路用户走不通。新建与重新发布的报告没有任何豁免。
  - `presentation` 的六个字段**已经推导好但没有全部接上界面**（本轮只改了顶栏状态句与来源页那句）。正式展示属于 STEP 3.6B。
  - resolution 的 scope 是「本轮 evidence 绑定的单元格 + 本轮 assessment 的目标」；一个问句里包含几个子目标（例如「中文处理与增量更新」）时，产品不解析自然语言，只如实报告每个作用域的覆盖状态——「仍然缺少」的两项来自单元格的名字，而不是来自对用户句子的切分。
  - resolution 里没有 claims 字段：本轮的新 evidence 只记录它绑定的单元格与来源，不反查它被哪条 claim 引用（§14 里写作「if known」，本轮未知）。
  - `userMessage` 是模式匹配出的「丢了哪类内容」（综合判断 / 机制过程 / 比较表 / 依据…），不是逐条问题的翻译；模式表之外的失败会落到「这一节必须保留的内容义务」这一句兜底。
  - Edit 的修正机会按**授权**计数（一个动作一次），不是按模型调用的次数上限：第三次及以后的提交仍然返回同一个 `proposal_not_created`，但账面上只算一次修正。
  - 动作基线只对 `origin: "user"` 的授权快照；如果将来有 pipeline 授权也要出提案，`researchAdded` 会是 0（当前不可能：`proposal` 能力只有 edit intent 才有，而 edit 一律由用户发起）。
  - **本轮之前生成的待接受提案没有经过预检**（本机数据里当前没有这样的提案）。它们仍然是 pending，因此仍可能在被接受时才因为新规则被拒——按既有语义标记 `invalid` 并提示重新生成，而不是静默接受不符合当前契约的内容。重新发起一次 Edit 就会走新的预检路径。

- 补查轮次上限 2、搜索 ≤6、读取 ≤10、单任务 8 分钟窗口（SPEC 初值，未收紧也未扩大）。这些是**项目预算**，只约束 Agent 自主的研究；用户明确发起的补查/Edit 补查走各自的一次性 Action Budget（Step 3.5C-A，见上）。
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

- 交互式报告与简报（Step 3.5B 后仍存在的限制）：
  - **生成的报告里，比较表是空的**（本轮最值得注意的发现）。四份真实 v2 报告（含 Step 3 留下的两份）的比较表全部是「6 个列维度 + 3 个对象行 + 0 个有内容的单元格」：模型写出了表头与行骨架，没有写判断。Q05/Q06 只校验「列维度与行对象声明得对不对、有没有静默省略维度」，不校验单元格有没有内容，所以这种报告是 pass 的，比较内容实际写在正文段落里。交互式画布对此的处理是：仍然画出框架，空格子写该格在矩阵里的状态词（待查 / 有限支持 / 冲突）并可点击打开证据，而不是留空白或假装有判断；**但这是呈现层的兜底，不是修复**。真正修它属于 Step 2 的 artifact 质量（生成侧或校验侧），本轮未动（§41 禁止改 Blueprint / Claim Contract）。
  - 校验明细里的原始 warning 句子保留 claim id（例如 `Q03：claim clm_mech_index（mechanism）…`）。它们只在核验模式下、默认折叠的「校验明细」里出现；读者正文与阅读模式都不含任何内部标识符。重写这些句子会失去它们作为审计记录的原文价值，所以选择保留。
  - 比较表在画布上按「行 = 研究问题、列 = 比较对象」呈现，与报告自己写的表（行 = 对象、列 = 问题）是转置关系：六列窄文字的读法确实更差，但报告开头的说明句按的是报告自己的方向，读得仔细的人会注意到这个不一致。
  - 报告正文里的 `**强调**` 由 `RichInline` 渲染成强调；这不影响 PDF/HTML renderer（那条路径本轮未动），导出文件里仍然是原文。
  - 引导问题仍然一次只针对一个字段，由一次有界的 stage run 生成（202 + 轮询）；模型声明「不值得再问」是否被接受由 Step 3.5C-A 的深度契约决定（readiness < 5 时拒绝并让模型改问，≥ 5 时接受，到 7 由程序收尾）。
  - **Edit 有可能不产出提案**：模型有时会回答而不是起草，或者 `propose_section_edit` 因为「已有待接受的修改提案」被拒。动作卡现在如实说明这一点并转述拒绝原因，但产品上没有「自动等你处理完再重试」的机制。
  - `busy` 是**服务端全局**的（一次只跑一个动作），因此一个项目在跑 run 时，另一个项目的动作按钮也是禁用的。
  - RichMarkdown 没有语法高亮（本轮未要求）；表格与代码靠横向滚动，不做换行重排。
  - 浏览器 gate 的模型用例需要真实模型、一次跑几分钟；没有模型凭据时这些用例报 SKIP 而不是 PASS。

- 对话式规划与协作工作区（Step 3.5C-B 后仍存在的限制）：
  - 引导对话里**不能编辑已经回答过的那一轮**：回答写进草稿即生效，要改某一项就回结构化模式改（服务端也没有「改写一条历史回答」的语义）；对话只呈现发生过的事。
  - 补查与修改那两类回复的**文案是产品写的**，不是模型的叙述——这两类 run 的文本是模型围绕工具调用的思考，读出来就是把 thinking 当结论。只有 Ask 的回答是模型原文。
  - 对话只包含**人发起过的动作**（Ask / 补查 / Edit，最近 10 条）；Agent 自己的阶段（初次检索、自动补查、写作、综合）刻意不出现在对话里。Ask 的回答仍只从会话历史读回（历史很长的项目里，很早以前的回答可能读不回来，3.5B 的限制仍然成立）。
  - 分隔比例**不持久化**：刷新或重开项目回到默认 50/50；双击分隔条也可以复位。
  - 协作模式在 **≤1099px** 退回浮层（两半都读不了）；速览 Dock 在 **<1350px** 仍然是浮层。这两种情况都保留原有行为。
  - 动作记录里不再出现工具名与结果 payload（§22 要求），代价是「这次动作做了什么」只剩中文动作名；需要技术细节时仍可从 `GET /tasks/:id` 的 run `activity` 读原文。
  - 协作模式下工具栏隐藏主题菜单与「待复核」chip（正文区的提醒仍在）以保持一行；主题切换在阅读模式里。
  - 报告**比较表仍然可能是空的**（Step 2 的生成侧问题，本轮未动，见上一条 3.5B 的说明）；协作模式只把它画得更窄、可滚动，不改变内容。**Step 3.6A 已补上呈现代理与契约**：空单元格现在一定写出真实状态词（证据不足 / 有限支持 / 有材料待核对 / 尚未写出判断），新报告与提案的空白表格会被拒绝；既有报告的空表作为 warning 保留，等它自己被重写。

- 简报与引导（Step 3.5A 后仍存在的限制）：
  - **界面未接**：本轮只做了 API，Brief 页面仍是只读卡片 + 「换个说法重新生成」；正式 Structured / Guided UI 属于 STEP 3.5B。因此现在通过界面**无法**编辑简报，也**无法**手动引导——必须走 API 或 3.5B。
  - 引导问题**一次只能针对一个字段**（`fieldTargets` 长度为 1），不支持「一个问题同时决定目标与关注点」。决策数量由 Step 3.5C-A 的深度契约管理（下限 5、上限 7），第 5 个之后模型的收尾判断才会被接受，用户也可以在此之前直接确认。
  - 引导问题由**一个 stage run** 生成，不是即时返回：`guide/next` 是 202 + 轮询，模型不可用时该轮不会产生问题（返回 409/空），不伪造问题。
  - 自由文本对 `subjects` / `dimensions` 是**整体替换**语义（按行解析），不是增量编辑；已存在的对象按名称匹配复用 id，改名同时改列表需要显式带 id（结构化 PATCH 可以精确做到）。
  - 结构性编辑（增删/重排对象或维度）在任务**已有实际读取材料**时被拒绝并返回 409，而不是静默删除证据；正常流程里未确认任务没有材料，所以这条只在异常数据上生效。
  - `topic` 也可编辑（项目标题），但本轮没有把它从 Brief 的语义讨论里单独拆出：`purpose` 才是研究问题的唯一来源。
  - 未做：mid-research reframe、简报的历史版本/回滚（只保留 `briefVersion` 计数与引导决策记录）、多字段问题、分支式问题树。

## Next Action

**STEP 4 — Artifact Delivery & Semantic Visualization**（下一步）：

- **PDF 双主题适配**：把 ThemeSpec 映射到 plugin 的 HTML/PDF renderer，使 Editorial / Swiss 在导出文件里也成立（现在只有 Editorial 有 PDF 版式）。工具栏的「样式（Editorial / Swiss）」已经就位，冻结时也记录 `themeId`，位置留好了。
- **Mermaid / DiagramSpec 机制图**：机制块的结构化数据（input / intermediate / steps / output / tradeoff / failure）完整保留，交互式报告里现在是 CSS 步骤流，替换成图形渲染不需要改数据。
- **File Upload 作为来源**、**第二 Blueprint**、**MCP 集成**：Source Workspace 与 Settings 对未接入能力已如实标注；Blueprint 信息现在显示在 Brief 与研究范围里（「技术比较」），模板页已收为「样式对照」，第二 Blueprint 出现之前不会再有「模板」这个误导性入口。
- 3.6B 交付后，界面看到的状态、结果与可执行操作与 3.6A 的真实语义一致，STEP 4 之前没有新的「数据有了、界面没接」的缺口。

3.6A 交付后，产品看到的状态、结果与可执行操作与它自己知道的真实状态一致；STEP 4（PDF 双主题、Mermaid / DiagramSpec、File Upload、第二 Blueprint、MCP）在此之前没有新的「数据有了、界面没接」的缺口。

## Step 3.6B 的验证入口

- 前端纯逻辑与渲染：`npx vitest run apps/research/tests/trust-ux.test.ts apps/research/tests/frontend-logic.test.ts apps/research/tests/artifact-view.test.ts`（结果块、材料按 id 取、提案五态、状态优先级、标签表无内部词、导航与默认视图，全部不需要浏览器）。
- 浏览器 gate（真实 CDP 输入，非 DOM stub）：`node apps/research/scripts/verify-trust-ux.mjs --url <product url> --task <有报告的项目> [--warnings-task <有质量 warning 的项目>] --shots <gitignored dir>`。29 例：导航三项与顺序、顶栏不显示额度、状态芯片 + 六条并列事实、研究范围入口、样式切换与正文重排、「需要进一步核验 · n」详情（技术细节默认折叠）、来源角色与无内部 id、矩阵状态词、未解决 / 部分解决的结果块与折叠活动、没形成提案时无接受控件、本轮证据只含本次动作的材料与「返回对话」、待确认提案完整展开 / 已接受折叠一行 / delta=0 的说法、五处页面全文无内部术语、动作提示不跨页、1366/1440/1920 的导航与工具栏。截图 13 张（report-main-1440 / research-main-1440 / sources-main-1440 / status-detail / research-unresolved / research-partial / action-evidence / proposal-pending / proposal-accepted-collapsed / proposal-not-created / brief-entry / report-theme-menu / 1366-report / 1920-report）。
- 需要 fixture 才能演示的状态（已解决的补查、部分解决、未解决、待确认 / 已接受的提案、没形成提案的 Edit）：在**数据目录的副本**上注入真实形状的记录即可，做法见 `.scratch/trust-ux/inject.mjs` 的思路（payload 就是 service 写的形状，页面从它推导一切）。`researchpage-data` 本身未被改动。
- 旧 gate 仍然可用：`node apps/research/scripts/verify-workspace.mjs --url <product url> [--task <id>] [--shots <dir>] [--model]`（本轮只同步了它引用的按钮文案与三处用例名，用例本身未改）。
- 离线全量、类型检查与构建：`pnpm typecheck`、`pnpm build:research`、`EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude …`（排除项同 Step 3.6A）。
- **本次实测**（2026-10-08，真实数据副本 + 注入的 fixture 记录，真实 Chrome）：`verify-trust-ux.mjs` 29/29 PASS；`pnpm typecheck` 三个 project、`pnpm build:research`、离线全量 `1908 passed / 7 skipped`（整仓并行时 `apps/web/tests/shell-*.browser.test.ts` 偶发 CDP 超时，单独重跑 34/34 通过，与本次改动无关）。
- 本轮没有跑真实模型动作（Ask / Research / Edit 需要数分钟一次且花费额度），也没有跑 PDF / Mermaid；结果块与提案的生命周期是在真实数据形状的 fixture 上、经真实 HTTP + 真实浏览器验证的。

## Step 3.6A 的验证入口

- 提案可信与 Scenario 1：`npx vitest run packages/plugin-research/tests/edit-preflight.test.ts`（真实 service + 真实工具，含预检、一次修正、接受真的生效、delta 语义）。
- 研究结果与 Scenario 2：`npx vitest run packages/plugin-research/tests/research-resolution.test.ts`。
- 比较表契约：`npx vitest run packages/plugin-research/tests/artifact-quality.test.ts`（末尾「the comparison table must be written, not just declared」三例）。
- 状态读数与文案：`npx vitest run apps/research/tests/presentation-status.test.ts apps/research/tests/prompt-copy.test.ts apps/research/tests/artifact-view.test.ts`。
- 全链路（含 run `outcome` 到达 bundle）：`npx vitest run apps/research/tests/editing-api.test.ts`。
- 真数据断言（可选，需要本机 `researchpage-data`）：把存储的 comparison 表渲染出来数空格子——修复前 4 份报告 16–24 个空单元格，修复后 `emptyTd = 0`、每格有词。临时脚本未入库，做法见本节第一段。
- 离线全量、类型检查与构建：`pnpm typecheck`、`pnpm build:research`、`EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude "**/real-provider.e2e.test.ts" --exclude "**/real-network.test.ts" --exclude "**/render-pdf.test.ts" --exclude "**/research-plugin.real.test.ts" --exclude "**/real-demo.e2e.test.ts"`。
- 本轮没有跑视觉 browser gate（未改布局，只改了四处文案与比较表渲染），也没有跑真实模型 Demo / PDF。

## Step 3.5C-B 的验证入口

- 对话与协作页面的纯逻辑与渲染：`npx vitest run apps/research/tests/guide-conversation.test.ts apps/research/tests/workspace-conversation.test.ts apps/research/tests/brief-logic.test.ts`（含 RichMarkdown 渲染断言，不需要浏览器）。
- 浏览器 gate（真实输入，非 DOM stub）：`node apps/research/scripts/verify-workspace.mjs --url <product url> --model --shots <gitignored dir>`；引导段与助手动作段需要真实模型，不加 `--model` 时如实 SKIP。引导段会自己建立一份全新草稿（readiness 从 0 开始），因此需要模型与几分钟时间。
- 离线全量、类型检查与构建：`pnpm typecheck`、`pnpm build:research`、`EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude …`（同 Step 2 的排除项）。
- 已知的既有 flaky（与本次改动无关，单独重跑即过）：`packages/host/tests/tool-policy.test.ts` 的 deadline 毫秒取整断言；`apps/web/tests/shell-*.browser.test.ts` 在整仓并行跑时的 CDP 超时。
- 本地跑 gate 的注意：产品服务的数据目录不要与正在运行的实例共用（SQLite 会拒绝第二个进程打开）；本次验证是在 `researchpage-data` 的副本上进行的，未改动原有 demo 数据。
- **本次实测**（2026-10-07，真实模型 `deepseek/deepseek-flash`，真实 Chrome）：浏览器 gate `78/78 PASS · 1 SKIP`（«早退被拒后的自动恢复» 那一项这一轮没有被模型触发，如实 SKIP，不报 PASS）；`pnpm typecheck` 三个 project、`pnpm build:research`、离线全量 `1792 passed / 62 skipped / 0 failed` 均通过。

## Step 3.5C-A 的验证入口

- 引导深度契约与对话数据（服务层）：`npx vitest run packages/plugin-research/tests/brief-guide.test.ts`（O/P 两段）。
- 用户动作预算（服务层）：`npx vitest run packages/plugin-research/tests/editing-semantics.test.ts`（J 段）。
- 全链路（HTTP → runner → tool → service，脚本化模型与本地 fixture，不需要网络或凭据）：`npx vitest run apps/research/tests/brief-api.test.ts apps/research/tests/editing-api.test.ts`。
- 离线全量、类型检查与构建：`pnpm typecheck`、`pnpm build:research`、`npx vitest run`。本轮没有跑真实模型 Demo 与浏览器 gate（未改前端视觉）。
- 已知的既有 flaky（与本次改动无关，单独重跑即过）：`packages/host/tests/tool-policy.test.ts` 有一条与 deadline 毫秒取整有关的断言；`apps/web/tests/shell-*.browser.test.ts` 在整仓并行跑时偶尔会在 CDP 等待上超时。

## Step 3.5B 的验证入口

- 页面纯逻辑与渲染：`npx vitest run apps/research/tests/markdown.test.ts apps/research/tests/brief-logic.test.ts apps/research/tests/artifact-view.test.ts apps/research/tests/frontend-logic.test.ts apps/research/tests/bundle.test.ts`。
- 浏览器 gate（真实输入，非 DOM stub）：`node apps/research/scripts/verify-workspace.mjs --url <product url> --model --shots <gitignored dir>`；不加 `--model` 时跳过需要真实模型的用例并如实报 SKIP（不报 PASS）。没有未确认项目时 gate 会自己通过 composer 建一个（需要模型）。
- 离线全量与类型检查同 Step 2：`pnpm typecheck`、`pnpm build:research`、`EVERY_DAGENT_NO_BROWSER=1 npx vitest run --exclude ...`。

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
