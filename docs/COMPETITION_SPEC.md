# 研页 · ResearchPage — Competition SPEC

> 2026-10-05｜三天、两人、比赛产品；仅三个开发阶段：A. Feasibility + Spec / B. Product Build / C. Freeze + Demo + Submission。
> 参赛：2026（第 3 届）全国大学生数智链应用大赛，人工智能 → 智能体 → 工具类智能体。
> 截止：2026-10-09 24:00（北京时间，用户提供）。目标提前完成提交，不把最后几小时当开发时间。

## 0. Status / Planning Basis

**SPEC：READY；可以进入 Phase A。Phase B 的放行条件是三个真实 spike 和业务 Plugin 接入验证通过，不是本文写完。**

- 比赛仓库工作目录：`D:/SomeProjects/AgentCompetition2026`；产品仓库称呼：`researchpage-agent`。当前根 `package.json` 仍名为 `every-dagent`，本轮不改名。
- 当前 baseline：`ebb3e7c28d84f825176b9842a0ec7f86c636ecb4` — `chore: bootstrap competition project from Every-DAgent Phase 4`。
- Upstream sealed baseline：`c5f97ba63f719ec81030746f3eb67fe7c538e01f`；来源见 [UPSTREAM_BASELINE.md](./UPSTREAM_BASELINE.md)。只在比赛仓库二次开发，不修改 upstream Every-DAgent，不引入其 Phase 5 工作。
- 已完整阅读 `D:/下载/Research_Report_Agent_IDEA_HANDOFF_v1.md`（v1.0），并实际核查 `packages/**`、`apps/web/**`、`docs/**`、根 manifests 及关键测试。
- 本轮只完成规划和源码核查，只新建本 SPEC 与 [HANDOFF.md](./HANDOFF.md)。未编码、未修改 tests、未安装依赖、未执行真实模型/搜索/读取/PDF spike，未复跑底座测试。
- 本轮要求优先于附件建议：首版只有一种主报告结构、一套视觉主题；Evidence Matrix 从可选展示提升为核心。历史 Phase 文档只是底座契约与证据，不沿用其实施组织流程。

## 1. Product Definition

**把模糊研究主题变成可执行研究结构，让 Agent 围绕证据缺口主动补查，生成关键结论可以回到实际来源片段的研究报告。**

面向学生组会、技术学习与初步技术比较。首版限制在公开技术论文及官方技术资料，不承诺任意行业的专业调研。

核心创新是 **Structure-Driven Research + Evidence Matrix**：研究问题不是只存在 prompt 里，而是被保存为任务卡、章节、比较对象、维度与证据要求；这些对象实际控制检索、补查和报告。最终交付是研究工作台、可核查报告、HTML 预览与 PDF，不是聊天记录。

不宣传 zero hallucination、automatic truth proof、systematic review completeness，也不承诺完全离线研究。

## 2. Why Not DeepSeek

DeepSeek、ChatGPT Deep Research 和现有研究工具可能已经支持联网、论文阅读、引用与文件生成。我们的价值不建立在它们缺这些能力、我们的 prompt 更好或某项技术独占之上。

用户选择 ResearchPage 的理由是研究过程有一个**明确、可观察、可操作的中间结构**：

1. 模糊需求成为可确认的 Research Task Card，而不是散落在对话中。
2. 章节和比较维度形成 Evidence Matrix；用户知道具体哪个对象、哪个维度还缺什么依据。
3. Agent 根据单元格的缺口定向补查；界面显示补查原因和变化，不仅显示“搜索中”。
4. 成品中的关键事实、数字和比较论断只能引用系统实际读取并保存的 Evidence。
5. 用户可直接检查 **Claim → Evidence → Source**，包括实际片段、定位、原文链接及读取范围。

这是可演示的产品差异，不是对竞品永久能力边界的判断。若最终只剩“搜索 + 长文 + 漂亮模板”，核心目标未完成。

## 3. User Journey

模糊主题 → 必要澄清 → Research Task Card → Executable Report Structure → Evidence Matrix → Search / Read Sources → Evidence Coverage → Gap Detection → Targeted Re-search → Evidence-backed Report → HTML Preview → PDF Export。

- 初始输入使用主题表单。最多三个关键澄清问题、至多一次追加澄清；输入已充分则直接出任务卡，允许接受显式默认值。
- 澄清只问影响研究的用途、读者、时间范围与重点，不问装饰偏好。用户确认卡片和结构后才开始检索。
- 先展示空矩阵和研究结构；检索与读取过程中更新来源、读取范围及材料缺口。
- Agent 根据覆盖情况进行有限补查，达到预算后保留缺失标记；不无限循环等“全绿”。
- 报告通过校验后展示。点击 Claim 引用打开 Inspector；PDF 由同一报告快照导出。
- 刷新后可选择并重开完成任务。中途大改主题/结构时新建研究任务，不做局部依赖更新或报告版本系统。

## 4. Structure-Driven Research

首版只做一个真正完整的结构：**技术研究与代表方法比较**。使用普通 TypeScript 配置对象，不做模板 DSL。

默认章节：

| 章节 | 必须回答的问题 |
| --- | --- |
| 研究任务与关键认识 | 为谁研究、研究什么、主要认识及证据边界 |
| 背景与方法分类 | 问题是什么，代表方法如何分类 |
| 代表工作比较 | 在共同维度下比较 2–4 个研究对象 |
| 实验与适用条件 | 数据/指标/设置是否可比，实际使用条件是什么 |
| 局限与证据缺口 | 文献局限、未找到依据的项目、不能下的结论 |
| 阅读建议与参考来源 | 有理由的阅读路径及真实来源清单 |

结构配置保存 `sectionId`、研究问题、比较对象、维度、证据要求、允许内容块与篇幅预算。章节是研究任务，不只是报告标题。

- 初始查询来自任务主题、章节问题和比较维度；每次查询记录所服务的章节/单元格。
- 候选对象可先由检索发现，再固定为本次任务的 2–4 个对象；不能模型凭空补来源来填对象。
- Matrix 单元格成为补查目标，例如“对象 B × 部署成本：需要官方实现条件，现有摘要不够”。
- 生成报告使用同一份结构与矩阵；必需维度缺证据时写出缺失，不静默删行、不把多个摘要直接堆成综述。
- 用户改变关注维度，必须能观察到查询目标、矩阵和比较表变化。这是“结构真的影响执行”的验收证据。

报告默认目标约 4–6 页（含参考来源），不为页数编造内容；输出预算不足时缩短成品，而不是提高底座硬上限。

## 5. Evidence Matrix

矩阵由本次任务对象与维度生成，GraphRAG 名称只用于 Demo，不进入业务条件分支。

下面只是**视觉示意，不是实测状态或演示固定数据**：

| 比较维度 | GraphRAG | HippoRAG | LightRAG |
| --- | --- | --- | --- |
| 核心思想 | ● | ● | ● |
| 图构建 | ● | ● | ● |
| 检索机制 | ● | ● | ● |
| 实验数据 | ● | ● | ○ |
| 部署成本 | ○ | ◐ | ○ |
| 局限性 | ● | ● | ◐ |

- **● sufficient**：已有实际读取的直接片段满足该单元格声明的证据要求；只表示本次材料足够写作，不表示事实被证明。
- **◐ partial**：只有摘要、间接信息、不完整设置或存在冲突；必须给出原因。若维度要求正文/实测设置，只有摘要不能转为 ●。
- **○ missing**：没有合格 Evidence，或读取失败；搜索摘要、仅元数据不能改善证据覆盖。

每格保存 `sectionId / entityId / dimensionId`、现有 `evidenceIds`、状态、原因、缺口说明和最近变化。状态由实际证据映射与规则共同产生，不由来源数量或模型自报“已完成”决定。模型判断支持关系，程序校验 ID、读取范围、维度要求和引用完整性；语义判断仍需人工核查。

点击单元格展示已有片段及缺口；点击“补查缺口”让同一 Agent 在剩余预算内处理该格，运行中不启动第二个 Run。自动补查和手动触发共用最多两轮预算。

进度反馈展示真实查询、目标格、读取结果和前后状态，例如“◐ → ●：新增官方正文片段”；补查失败则保留原状态与原因。数据尚未完成评估时显示“评估中”，不先涂绿。覆盖数量只统计本次声明的研究要求，不包装成领域覆盖率。

## 6. Source / Evidence Truth Model

**search != read。** 搜索候选、已读 Source 和可引用 Evidence 是不同事实。

| 对象/动作 | 可以建立什么事实 | 不可以建立什么事实 |
| --- | --- | --- |
| `search_sources` | 真实候选 metadata、URL/DOI、检索摘要、查询时间 | 已阅读全文、可直接引用的正文 Evidence |
| `read_source` | 成功获取的实际文本、读取状态/范围、可用定位 | 没获取到的正文、页码或片段 |
| Evidence 登记 | 从已保存读取快照切出的片段及可信内部 ID | 模型编写的“原文”或不存在的 Source |
| Report 校验 | 引用存在、片段可回查、结构符合要求 | 结论必然正确、检索全面 |

Source 必须保存真实 metadata（缺失字段为空）、URL/DOI、候选发现信息、`readStatus`、`readScope`、读取时间、实际读取文本/节选、获取地址及可用位置。范围使用 `metadata / abstract / body_excerpt / full_text`；对正文做截断必须标为 `body_excerpt`。失败记录不能冒充成功读取。摘要只有经读取层独立获取并保存后，才可建立 abstract Evidence，不能自动提升搜索摘要。

Evidence ID 由程序生成，绑定 `sourceId` 和不可变读取快照（如 `readId` / 文本 hash）、实际节选、字符范围及来源位置。正文保存在业务库，模型只拿有界片段和 ID。按段落/标题分片；模型可选择已有 ID，不提供任意原文字符串作为入库依据。必要的新截取必须由读取层从已存文本按位置验证并产生。

- 页码只接受实际 PDF 解析器返回的位置；HTML 用标题/段落/字符位置，未知位置为空。首版不以 PDF/OCR 解析为前置条件。
- 来源、片段、位置不是模型可自由创建的字段。模型生成 Claim 和证据关联；工具校验参数，不依赖 Core 自动进行完整 schema 校验。
- Report 引用不存在、跨任务或未读 Evidence，或 Evidence 不匹配读取快照时，`save_report` / validator 拒绝发布与导出；保留具体错误供一次有界修正，不能降级为无效脚注。
- 关键事实、数字、方法比较结论必须有 Evidence；综合推断单独标注，并绑定推断依据。过渡句无需机械加引用。
- 部署成本或实验数字需读取到对应设置/条件；不同数据集、指标、硬件不能直接排名，无法比较则明确说明。
- 人工抽查 Demo 的关键论断是否真被片段支持；存在 ID 不等于支持关系正确。

外部正文作为不可信资料而非系统指令。URL 只允许受控 HTTP(S) 来源，拒绝本地/私网地址及不安全重定向；有超时和响应大小上限。HTML 内容转义，报告不执行来源或模型提供的脚本。

## 7. Research Workspace UI

桌面主界面采用三栏 Research Workspace，不以 Chat UI 为中心：

| 区域 | 内容与交互 |
| --- | --- |
| 顶部 | 任务名称、实际阶段、取消、HTML 预览、PDF 导出；导出状态与研究状态分开 |
| 左侧（约 24%） | Research Task、Outline、Evidence Coverage；可切换为矩阵聚焦视图 |
| 中央（约 50%） | Report Workspace / Preview；生成前显示结构、矩阵与缺口动态，完成后以报告为主 |
| 右侧（约 26%） | Sources / Evidence Inspector；片段、scope、定位、来源链接、Claim 关联 |

Evidence Matrix 可在中央展开，保证 2–4 个对象及完整维度能被视频清楚读到，不把核心反馈压进狭窄侧栏。不能只用颜色表示状态，同时提供 ● / ◐ / ○ 与文字原因。

澄清使用短问答与可确认任务卡；Agent Chat 收起，仅用于初始澄清、追加要求和局部修改指令。首版不承诺局部再生成，收到这类指令说明现有范围并可新建任务重跑。运行日志默认折叠，不让工具 JSON 占据主体。

中央报告支持摘要、标题、段落、列表、比较表、提示块和引用。内容来自结构化 Report，编号、参考来源及 CSS 由固定渲染器决定；不让模型自由生成 HTML/CSS。

引用点击路径：Claim → Evidence Inspector → 实际 excerpt / read scope / location → 原来源。预览与 PDF 使用同一 `reportId` 和内容快照。PDF 保留编号、来源条目、链接、读取范围及证据节选索引；不能声称 PDF 也有完整交互面板。

## 8. Core Domain Objects

Phase A 由两人共同确定以下四个共享对象；Matrix 与 Outline 嵌入 Task，不新增通用工作流对象。

| 对象 | 最小字段与边界 |
| --- | --- |
| `ReportTask` | `id`、可信 `sessionId` 绑定、topic、purpose、audience、scope/timeRange、focus/exclusions、language、lengthTarget、confirmation、structure/outline、entities/dimensions、matrix、budget/usage、status/error、currentReportId、timestamps |
| `Source` | `id/taskId`、真实 metadata、URL/DOI、search provenance、readStatus/readScope、readAt、实际读取快照/文本、可用定位、failure |
| `Evidence` | `id/taskId/sourceId/readId`、实际 excerpt、字符范围/位置、关联单元格；身份和片段由程序建立 |
| `Report` | `id/taskId`、结构 ID、title/summary、sections/blocks、claims `{id,text,evidenceIds,kind}`、比较表、明确缺失项、validation、createdAt、export 状态/本地文件句柄 |

领域状态只需 `draft / researching / writing / ready / failed / interrupted`；PDF 单独 `not_exported / exporting / exported / failed`。`ready` 要有已保存且校验通过的 Report，`exported` 要有真实非空文件。任务完成不是 Host Run 结束文本中的一个自报标签。

推荐新增比赛应用私有 SQLite Repository，独立数据库文件/连接，简单四类记录及 JSON 字段即可。它同时供应用 API 与可信业务 Plugin 使用，不改 Host schema，不把 Host canonical 当领域数据库。写入关联与发布成品使用最小事务；不设计通用 ORM/迁移框架。

业务工具按 `RuntimeContext.sessionId` 解析应用保存的 task 绑定；不要信模型提供的 `taskId`，也不按当前 UI 选中项决定写入目标。Source/Evidence ID 必须属于绑定任务。Context 无 `runId`，Run 关联由应用启动请求及响应保存，不伪造运行上下文接口。启动前持久化绑定与 `submissionId`；应答丢失时先通过 `runs.get({submissionId})` 查询，不盲目重发或自动创建第二个研究 Run。

## 9. Core Tools

以下是**拟新增业务工具**，不是 baseline 现成 API。工具由单个 Research Plugin 注册；UI 的 CRUD、确认与文件导出走应用 API，不强迫用户操作经模型转发。

| 工具 | 输入与程序责任 |
| --- | --- |
| `propose_task` | 保存模型提议的任务卡/结构草稿；应用校验，不赋予用户确认状态。供澄清使用，未确认前禁止研究工具 |
| `search_sources` | 查询词、目标章节/单元格、数量限制；通过一个真实入口返回候选并保存 provenance，不造 Evidence |
| `read_source` | 本任务候选 ID、目标研究问题；真实读取并持久化，程序建立有限 Evidence，返回 scope、可信 ID 和短片段 |
| `assess_coverage` | 模型提议的格子与已有 Evidence ID/支持理由；校验后保存矩阵，返回具体 gaps 和剩余预算；这是单 Agent 的反馈，不是另一名审查 Agent |
| `save_report` | 结构化 Report；同一实现校验结构、关键 Claim、Evidence 和读取快照，成功后才发布 Report；无效时返回具体问题 |
| `load_research_state` | 返回当前绑定任务的有界任务摘要、矩阵、Evidence 索引和预算；不把所有全文交给模型 |

`validate_report` 是 `save_report` 的普通业务函数，可被应用复用，不要求另设服务或再做一套模型检查。`render_report / export_pdf / load_workspace` 同样优先为应用调用，不增加 Agent 工具数量。

业务预算初值：2–4 个对象，目标 6–8 个已读来源，最多 10 个不同候选来源读取；搜索至多 6 次、每次至多 5 个候选；定向补查最多 2 轮；网络请求设置超时，单任务默认约 8 分钟截止。工具执行层累计并拒绝超预算调用，不只靠 prompt；停止后允许以 partial/missing 生成诚实报告。Phase A 试跑只允许收紧范围或按事实微调这些初值，不扩大底座硬限制。

一次补查轮指根据一次 gaps 快照选择具体格子 → 搜索/读取 → 重评矩阵；无需所有格子都完成。优先最多三个关键缺口，读取无增益则停止。模型不允许自改预算或将空证据改为 sufficient。

## 10. Every-DAgent Reuse

### 已确认接口与限制

| 能力 | 源码核查结论 / 实施用法 |
| --- | --- |
| Plugin | `packages/plugin-system/src/plugin.ts` 定义 `Plugin.activate(context)`，通过 `context.tools.register` 注册 Tool、`onDispose` 清理；`plugin-calculator` 为实际参考。Context 不提供 Host/Session/文件/网络服务总线 |
| RuntimeContext | `packages/agent-core/src/runtime/runtime-context.ts:7–11` 只有 `sessionId / userId? / signal`，无 `runId/taskId`；据此建立可信应用绑定 |
| Host / composition | `packages/host/src/host.ts`、`composition.ts:90–95` 支持异步 readiness 与可信 composition 注入 ModelClient / ContextBuilder；不是通过 PluginContext 注入全底座 |
| Tool policy | 未分类工具默认 deny。Research 工具必须由 trusted composition 显式分类 allow；若使用工具对象 catalogue，policy 与 Plugin 必须共享同一 Tool 对象。Plugin manifest 或模型不能自行授予执行权限。首版不演示 HITL |
| Client / Protocol | typed Client 可创建/读取 Session、启动/查询/取消 Run并订阅投影；现有 HTTP/SSE carrier 可复用。没有通用业务 RPC、`tools.execute` 或 `runs.resume`；不为领域数据改 wire/ClientSnapshot |
| Session / Run | Host 有 SQLite durable repository、完整收敛历史、分页及 restart reconciliation；默认 Web 启动路径并未自动成为 durable。全局一个执行 Run；运行时不改插件生命周期，不开发并发调度 |
| 重启边界 | 旧 unfinished Run 会成为 interrupted/unknown，Session blocked；无自动恢复执行。保留已保存业务材料/报告；中断任务允许显式新建任务重新跑，不冒充 resume |
| Storage | `PluginStorage` 只有异步 `get/set/delete(string)`，无 list/CAS/transaction；`HostOptions.storage` 只是 factory 接线。Host schema v3 没有 plugin KV 表，未提供生产 SQLite PluginStorage 后端 |
| Model Client | 复用 `packages/model-pi-ai` 的 pi-ai adapter、trusted provider/model composition 和显式 credentials；支持的 bounded profile 不等于当前凭据/模型网络已可用。API Key 不进入 ordinary settings、会话、业务库、DTO 或源码 |
| Context Budget | 复用有界请求、输出 cap 和 model-only truncation。Host 输入窗口最多 16 个完整 turn / 256 KiB；不能从会话全历史恢复任务记忆。M2 默认输出 reserve 为 `min(4096, modelMaxOutputTokens)`，设置只能收紧 |
| Web Shell | `apps/web/src/browser/App.tsx:235–284` 当前主区是聊天/历史视图；两侧为会话/设置及 Host/Plugins。保留启动、Client controller、连接与必要设置，新增/替换为 Research Workspace |
| Browser / PDF | `apps/web/tests/helpers/chrome-cdp.ts` 已有 Chrome/Edge/Chromium 探测、headless/raw CDP 和截图测试载体；没有 PDF adapter，也没有 Playwright/Puppeteer 依赖或报告 renderer |

底座历史验收数字在 `docs/PHASE4_HANDOFF.md` 最后封板节中；不是本轮复测结果，也不构成 ResearchPage 产品验收。

### 必须新增的最小应用适配

1. 一个 Research Plugin，构造时注入可信 `repo/search/reader` 等业务依赖；声明准确工具 policy。不扩展 PluginPermission 或 Host service registry。
2. 一个业务 Repository 与应用 API：任务草稿/确认/读取、矩阵/来源/成品快照、导出与文件下载。`apps/web` 当前仅 static 与 connection/events/frames carrier，没有业务/artifact hook，需增加应用 route 分发，保留现有 carrier 语义。
3. 可信 ContextBuilder/task brief 适配：按 Session 绑定提供简短任务、结构、矩阵与 Evidence 索引。将 brief 纳入 fixed context 后再让已有 selector 选历史，不在预算计算后追加大段资料；同步 fixed-context seam 使用预热的应用缓存，不读取异步库、不产生副作用。
4. Research Workspace、固定 Report renderer 与打印样式；状态通过应用 API 低频轮询（运行中约 1–2 秒）即可，不开发新的事件协议。
5. PDF export adapter：Phase A 优先借鉴已有 Chrome raw CDP 载体，通过 `Page.printToPDF` 导出；生产代码不能导入 test helper。等待字体/渲染就绪、设置超时、处理 CDP error并清理进程；只导出固定成品快照。若不可用，当天选一种可实测替代路线，不并行做多套导出。
6. 比赛启动 composition：显式配置 durable Host repository、业务数据目录、模型凭据与搜索入口；未配置不能静默退回 ephemeral 却宣称可恢复。当前 CLI 的 memory-only 文案不能当存储事实，以 `host.describe` / retention 为准。

完整正文保存到业务库；工具返回目标控制在约 8 KiB 内，报告工具参数保持有界。Core neutral item 默认上限 64 KiB，超限不只是 UI 截断，可能使工具执行后 Session blocked；不以修改 hard limit 解决。Context budget 也不是证据存储或全文分片方案。

浏览器不能 import Host/Core/Node/plugin/model；通过应用 API 获取领域 JSON。既有 `shell-boundary` 测试枚举文件/import 边界，后续新增文件须精确更新合法清单并保留隔离断言，不以关闭测试解决。

### 现有验证入口

- `pnpm typecheck`：根项目与 browser project。
- `pnpm build:web`：现有 esbuild browser build。
- 正式 offline：`pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts' --exclude '**/.zcode/**'`，避免无意调用真实付费 provider；先跑相关业务/渲染检查，再做现有回归。
- `pnpm test:web:browser`：strict required-case gate（真实浏览器），新增 ResearchPage 产品路径需有自己的验收，不把通过旧 Shell case 当新产品已通过。
- 根 manifests 没有 lint script，不新增格式工程、不声称执行了不存在的 lint。

## 11. Scope / Cut List

**Must Have：** Topic/必要澄清/Task Card；一种可执行研究结构；Evidence Matrix；一个真实 search source；真实 read；Source/Evidence 持久化；最多两轮缺口补查；结构化 Report；Claim 回查；HTML；真实 PDF；刷新可重开完成成果。

**有时间才做：** 第二个报告结构、第二个视觉主题、来源手动纳入、报告版本、局部章节再生成。必须在主链路全部通过且不侵占冻结时间时才考虑；默认不安排。

**明确不做：** Multi-Agent、vector DB、generic RAG platform、template marketplace、rich text editor、Word/PPT/LaTeX/Typst 多格式链、auth/account、collaboration、generic workflow engine、heavy plugin framework changes、OCR/扫描论文、完整 PDF 版面理解、通用凭据平台或上游 Phase 5。

实施优先级：**完整闭环 > Evidence Matrix > Evidence Inspector > PDF 完善 > UI polish > extra features**。PDF 基础出口在 Phase A 验证且第一天必须可下载，不能以优先级靠后为由拖到最后。

时间不足的 cut order：局部再生成/版本/手动纳入 → 第二结构/第二主题 → 第二搜索入口及额外来源格式 → 图表/动画/高级分页/视觉细节 → 缩短报告与减少对象/来源。**不砍真实搜索读取、矩阵缺口、引用回查、校验、持久化或 PDF；仍无法闭环就承认未完成，不能改成伪演示。**

## 12. Three-Phase Implementation Plan

以实际启动时间为 H0，最多约 72 小时经过时间，不是两个人连续工作 72 小时。总投入按约 48–60 人时规划，其中至少 14–18 人时留给验收、视频、文档与提交。若启动较晚，压缩 B，不压缩 C；内部提交目标不晚于 2026-10-09 18:00，保留到官方截止的缓冲。

### PHASE A — Feasibility + Spec（H0–H4/6）

只验证关键路径并敲定四个共享对象，不做全套产品：

- **A1：真实搜索。** 优先试 arXiv 公开论文 API 作为单一技术论文检索入口；真实查询 GraphRAG 与另一技术主题，重复请求能得到有效标题、公开地址和候选，而非空返回或演示 fixture。它是论文检索而不是通用互联网搜索；API 的 metadata/summary 不算全文 Evidence。官方 API 文档已确认此类接口及连续调用间隔建议，但本轮没有执行 API 查询。若不可达，改为一个现成可用的搜索服务，不叠加第二入口。
- **A2：真实读取。** 从 A1 候选读取至少一份论文公开 HTML 正文或官方技术来源，保存真实片段并能展示位置/范围；额外确认 abstract-only 与读取失败诚实处理。优先开放 HTML，无法读全文就明确限域，不能凭搜索摘要验收通过。
- **A3：真实 PDF。** 用固定 renderer 生成一页包含中文、表格、引用与链接的 HTML，实际导出并打开 PDF；确认字体、链接、文件字节与导出快照。优先现有 Chrome 载体 + CDP，不先引入完整排版工具链。
- **Plugin 接入核验：** Research Tool 经 register/enable、trusted allow policy、Client 启动 Run 后实际执行；验证 Session→Task 绑定、短工具输出、显式模型凭据路径和业务保存/重开。共同定下四对象、矩阵字段和 API JSON 形状。

**放行：** 三个 spike 和 Plugin 接入都有真实证据、路径与失败边界，才能进入 B。四至六小时内若有阻塞，当天替换单一搜索/读取/导出路线或缩小范围；仍不能获得真实来源 + Evidence + PDF，不继续堆 UI。结果记入薄 HANDOFF，不新建评审/封板文档。

### PHASE B — Product Build（H6–H48）

两人并行开发，同一个纵向闭环，不再分 M1/M2/M3：

主题与澄清 → 确认任务卡/结构 → 初始矩阵 → 搜索/读取/保存 → 缺口反馈与有限补查 → 校验报告 → 引用 Inspector → HTML/PDF → 重开结果。

- **第一天结束（不晚于 H24）：** 至少一份真实来源支持的报告，关键引用可查，PDF 可下载并打开，完成结果可重开。主矩阵显示真实状态；允许有 partial/missing，先不要做额外结构/主题。
- **第二天结束（不晚于 H48）：** 缺口定向补查、Matrix 状态变化、Inspector、PDF 分页和主要失败文案形成可直接录制版本；完成核心自动检查与真实浏览器路径，不追求测试数量。
- 若 H24 闭环失败，两人停止装饰和扩展，合力修当前链路；不延后冻结时间。可读性、长表格和引用修正与构建同步处理，不另设 Review/Repair/Seal 阶段。

### PHASE C — Freeze + Demo + Submission（H48–H72）

**停止新增功能**，只修 demo blocker、rendering fix、obvious UX fix。至少保留最后约 18–24 小时给验收、录制、材料与打包。

完成真实 Demo dataset、第二主题验收、人工证据抽查、视频与原始录屏、README、技术文档、两份示例报告、第三方依赖/license 说明、source zip 与 submission checklist。重新运行关键链路和现有 build/typecheck/browser 检查；确认 zip 不含秘密、个人会话、`node_modules` 或临时过程材料。最终按实际比赛提交界面核对格式/大小/命名并完成上传，不能在截止点才首次提交。

## 13. Two-Person Split

| 成员 | 主责 |
| --- | --- |
| A | Agent / Research Plugin / Search / Read / Evidence / 业务数据 / 引用校验 / 可信 composition |
| B | Research Workspace / Matrix 展示 / Evidence Inspector / Report Renderer / PDF / Visual / Demo material |

Phase A 共同确定 `ReportTask / Source / Evidence / Report`、矩阵规则、Session 绑定及 API 数据形状；共享一份实际 JSON，不各自猜字段。A 提供真实 workspace snapshot，B 尽早用它渲染，不能录制 fixture。每天以当前整条链路联调；冻结期 A 主技术文档/复现/源码包，B 主视频/版面/材料，两人共同核对证据与提交文件。

## 14. Demo Story

主主题：“帮我整理 GraphRAG 方法与代表论文，明天组会要用。”

1. 澄清读者基础和重点，确认 Task Card；展示章节、比较对象与维度如何确定。
2. 展示 Evidence Matrix 从空状态到真实覆盖，强调某个部署/实验维度只有 ◐ 或 ○。
3. 展示 Agent 指向该格说明缺口，真实补查官方正文/论文相关段落；有依据则更新，否则诚实保留不足。这是视频最重要的反馈镜头，不预设必须“全绿”。
4. 展示报告关键结论，点击引用回到实际 Evidence、scope、位置与 Source。
5. 预览中文比较表、局限与参考来源，下载并打开 PDF；刷新重开已完成结果。

第二主题固定为一次真实验收：“参数高效微调：LoRA、QLoRA、DoRA 的机制、实验设置与资源条件比较。”走同一结构与工具链，不用 GraphRAG 专用分支；不要求这些对象的不同实验天然可比，不能凭标题编 GPU 内存结论。

视频建议约 2–3 分钟，具体时长服从赛事实际要求。耗时部分明确加速；缓存标注“已缓存真实资料”及获取时间，预生成成品标为成品展示，保留原始连续录屏。不伪造当场搜索、补查决策或生成。预存真实材料可用于稳定演示，但 A1/第二主题真实验收必须留有联网获取证据。

## 15. Acceptance Checklist

以下 **15 项目前均为待实施验收，不是已通过结果**。只围绕产品风险，不按 finding 数量或覆盖率制造工作。

| # | 场景与通过标准 | 验证方式 |
| --- | --- | --- |
| 1 | 模糊输入会必要澄清并形成可确认 Task Card；明确输入不重复追问 | 真实页面操作 |
| 2 | 结构/关注维度改变会影响查询目标、矩阵与报告，不仅改变标题 | 比较两次任务的实际查询与成品 |
| 3 | Matrix 的 ●/◐/○ 有真实 Evidence/规则/原因；检索命中不自动改善覆盖 | 业务检查 + 页面单元格回查 |
| 4 | 单一真实搜索入口稳定返回可访问候选并保存 provenance | 真请求与重复运行记录 |
| 5 | body_excerpt、abstract-only、metadata、失败状态准确，未知页码为空 | 读取检查 + Inspector |
| 6 | Evidence 来自已保存实际 read content，读取快照和位置可回查 | 片段一致性检查 |
| 7 | 缺证据会定向补查或保留明确缺失，超过两轮/预算不会继续 | 工具计数检查 + 真 Run 记录 |
| 8 | 关键 Claim 点击可到正确 Evidence 与 Source，且语义支持关系合理 | 页面点击 + 人工逐项抽查 Demo 关键论断 |
| 9 | 假 ID、跨任务 ID、伪片段、虚构定位无法正常发布/导出 | validator 负例与存储约束检查 |
| 10 | HTML 中文、标题、比较表、引用正常，无脚本注入或横向遮挡 | 自动渲染/浏览器 + 人工可读性检查 |
| 11 | PDF 是真实可打开文件，中文/表格/来源链接可读，内容对应同一 Report 快照 | 文件检查 + 实际打开/翻页 |
| 12 | refresh 后可重开完成任务、Matrix、Source/Evidence 与 Report，不依赖未落库 UI 状态 | 真实刷新与显式 durable 配置检查 |
| 13 | 第二技术主题走同一链路，真实来源/报告/PDF成立，无 GraphRAG 写死 | LoRA/QLoRA/DoRA 真验收 |
| 14 | Demo 连续复现成功；缓存/加速/成品使用准确标注 | 两次完整 rehearsal 与原始录屏 |
| 15 | 网络/读取/导出失败、中断及预算耗尽给出准确状态；未执行或未导出不显示成功 | 相关失败检查 + 页面重开 |

**已自动验证（本轮）：** 只核查最终文档结构、链接、变更范围与空白；源码核查确认接口存在，但不是运行时验收。

**后续自动验证：** 引用负例、读取片段与 scope、矩阵规则/预算、报告结构与持久化；现有 typecheck/build/offline/browser 入口。真实搜索、来源读取、实际 PDF 与第二主题不可被 fake provider 代替。

**待人工验收：** 按第 8 项逐条点击 Demo 关键论断，对照片段判断是否支持；按第 10/11 项阅读 HTML 与打开 PDF 全部页面，检查中文、分页、表格和参考来源；按第 14 项走两次完整脚本，确认镜头与真实性。人工检查只覆盖自动检查不能可靠替代的语义/视觉/演示质量。

## 16. Submission Deliverables

本轮只交付本 SPEC 与薄 HANDOFF；下面的材料在 Phase C 制作，不在规划轮提前制造额外文档。

- 视频成片与原始连续录屏；作品介绍、操作步骤、README。
- 技术文档：结构驱动研究、矩阵反馈与有限 Agent 回环、证据真值边界、四对象、复用底座/新增业务、异常处理、HTML/PDF路线。
- GraphRAG 与第二技术主题各一份真实 HTML/PDF 成品；可复查的来源/证据样例与缓存时间、获取方式说明。
- 可复现源码 zip：源码、锁文件、非秘密配置说明、安装/启动/build步骤、Node/pnpm/Chrome及中文字体要求；准确说明联网与凭据需求。干净目录验证启动路径，不复制个人凭据。
- 第三方依赖/许可证/署名及上游来源说明；字体若随包交付也需核对再分发许可，不把引用的开源模板宣传为已集成。
- Submission checklist：按赛事实际界面确认必交项目、格式、尺寸、命名、团队信息、截止口径、上传完成状态与回执；保留内部提前提交缓冲。

## 17. Risk / Fallback

| 风险 | 当天决策与可接受降级 |
| --- | --- |
| 搜索 API 的网络/账号/配额未知 | A1 真请求后只选一个入口；arXiv 不通就替换已可用服务。不能用固定列表或 search 摘要冒充真实检索/读取 |
| 正文不可读、论文只提供 PDF | A2 优先开放论文 HTML/官方正文；只读摘要就标 partial并限制论断。首版不补 OCR/全 PDF 解析；至少一个正文真实 Evidence 的 A2 条件仍需成立 |
| 模型凭据或 endpoint 未就绪 | Phase A 走已有 trusted composition 显式注入并真跑工具；失败先修应用配置，不开发 credential UI、放宽 endpoint trust 或写 key 到普通 settings |
| 插件与 UI 没有领域存储/RPC | 使用应用私有 SQLite + routes + 注入业务 repo，不借 Host 内部连接，不新增 protocol 语义；启动明确 durable 模式 |
| 正文或结构化报告超过预算 | 全文留库、工具返回短片段/ID、brief 有界；简化 blocks、减少对象、缩短报告。最多一次格式修正，不改 Core hard limits、不关 validator |
| 引用存在但不支持论断 | 人工抽查并缩小表述/标明综合判断/删除结论；不声称系统自动证明真理 |
| Chrome/PDF/中文字体或分页失败 | A3 验证单页，再验证成品；优先减少布局/表格列数。固定一种可再分发字体或明确环境安装要求。浏览器“打印另存 PDF”可临时演示 fallback，但不能替代成品下载出口验收 |
| 长研究中断/Host 重启 | 完成结果与已保存材料可重开；旧 Run 不恢复，清晰展示 interrupted，用户显式新建任务重跑。不自动重放工具副作用 |
| 外网影响视频 | 用已保存真实资料，标明缓存与时间，等待段加速；至少保留一次真实联网生成与第二主题验收记录 |
| 开发时间不足/提交细则未核验 | H24 无闭环就停扩展合力修复，H48 强制冻结；按 cut order 缩小产品，预留材料时间。提交格式在冻结前核对，不能用模板数量掩盖主链路失败 |

**停止条件：** Phase A 当天仍无真实搜索、正文 Evidence、真实 PDF 或 Agent 工具接入；或冻结时不能实现矩阵缺口与 Claim 回查，应报告核心未完成，而非把假资料/假引用变成“可交付”。

参考：附件全文；仓库实际实现与对应测试；[arXiv API User Manual](https://info.arxiv.org/help/api/user-manual.html)（本轮仅查官方说明，未证明 API 连通）；PDF 使用的 CDP 操作需在 A3 实测，不能由现有截图测试推定打印能力。
