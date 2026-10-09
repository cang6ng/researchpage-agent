# ResearchPage — Step 3.7D User Acceptance Failure Review

审查日期：2026-10-09，UTC+8。仓库：D:/SomeProjects/AgentCompetition2026。

基线：4c415d188acafa8af21692602a47365ec5bcec61。
实际 HEAD：37b2c81f9c4b76bf26d7fe20119bebc146d2bd17，与预期一致。

本轮仅审查、只读诊断、内存中离线复现和修复规划；未修改生产代码，未提交、未 Push，未重启服务，未修改用户数据库，未调用真实 DeepSeek 或重新执行 MinerU OCR。唯一新增文件为本报告。

已核对 STEP_3_7D_PLAN.md、HANDOFF.md、MINERU_WINDOWS.md，以及 b8812e5、a28a618、37b2c81 三个提交。基线到 HEAD 的完整补丁按文件遍历：34 个文件，7811 行增加、267 行删除；重点逐路径检查六项用户问题。该补丁没有修改 apps/research/src/server 或 packages 下的后端实现；前端交付继承了既有报告生成问题。

证据标记：“已证实”表示源码与实际记录或定向复现相符；“高可信推断”表示机制支持但尚未完成现场验证；“未验证”表示现有证据不足；“新需求”表示需要新增产品能力。

## 1. Executive Verdict

**READY FOR DEMO: NO**

- **REPORT GENERATION ROOT CAUSE: PARTIALLY CONFIRMED**
- **REPORT DELIVERY: BLOCKED**
- **MODEL CONFIG: FINDINGS**
- **RESEARCH SETTINGS: FINDINGS**
- **INTEGRATIONS / MINERU: FINDINGS**
- **INTENT UX: FINDINGS**
- **PROGRESS UX: FINDINGS**
- **READY FOR DSFLASH REPAIR: YES**

报告格式损坏和部分校验误判已确认；后续快速 INTERNAL_ERROR 的底层原因尚未确认。修复交接已具备实施条件，但当前产品未达到演示交付门槛。

最严重的三个问题：

1. **BLOCKER：模型确实写出了比较表内容，但解析器把数组行静默转成空行，导致 Q03 拒绝全部 20 个单元格。** 再次生成同类数组仍会丢失文本，增加检索不能修复这个问题。
2. **BLOCKER：报告恢复没有独立状态和有效错误诊断。** 多轮 report/synthesis 在约一秒内 INTERNAL_ERROR，前端最终只收到“没有保存有效报告”；重新研究、恢复草稿和重试执行器故障没有清楚区分。
3. **MAJOR：设置页无法完成基本配置，并错误描述已实现能力。** 模型与研究预算只读，上传与 MinerU 被标成“未接入”，用户无法正确配置或判断产品能力。

### 严重性清单

| 级别 / 编号 | 问题 | 证据性质 |
| --- | --- | --- |
| BLOCKER B01 | 表格 schema、实际模型输出与解析器不一致；静默丢正文，无法保存报告 | 已证实 |
| BLOCKER B02 | 连续报告恢复失效；执行故障被统一文案覆盖，缺少有效恢复闭环 | 恢复缺陷已证实；INTERNAL_ERROR 底层原因未验证 |
| MAJOR M01 | Q08 排名词检测将“不能合成一个‘更便宜’的判断”识别为排名 | 已证实；不代表所有 Q08 拒绝都错误 |
| MAJOR M02 | 网页不能设置 Provider / Base URL / API Key / Model | 已证实现状；可编辑、安全持久化和检查为新需求 |
| MAJOR M03 | 新任务预算只能取固定常量；设置不能影响后续任务 | 已证实；默认预算编辑为新需求 |
| MAJOR M04 | 来源与集成静态旧文案；MinerU 无网页 Token 配置，限制说明不一致 | 已证实 |
| MAJOR M05 | Intent 已有用户容器，但区分度弱、长确认编辑区挤压输入，阅读层级不足 | 源码及历史截图支持；当前任务浏览器未重新验收 |
| MAJOR M06 | Progress 默认仍展示十条日志，累计与本轮指标混用，失败建议缺乏针对性 | 已证实 |
| MINOR N01 | 设置页无 runtime 时每次候选数兜底为 6，实际默认为 5 | 已证实，settings.tsx:118 |
| MINOR N02 | 报告空态仍引导用户判断材料是否足够，与自动报告流程及恢复需求不符 | 已证实，studio.tsx:643 |

### 为什么开发 Gate 通过，人工验收仍失败

2122 项离线测试、22/22 浏览器 Gate 是历史开发记录，本轮没有重新运行这些全套检查。其覆盖范围不能等同于新报告交付：

- [verify-intent-documents.mjs:561](D:/SomeProjects/AgentCompetition2026/apps/research/scripts/verify-intent-documents.mjs:561) 以 logCount >= 0 判断活动记录，通过条件恒成立，不能证明记录来自后端。
- 同文件 [565–579 的入口](D:/SomeProjects/AgentCompetition2026/apps/research/scripts/verify-intent-documents.mjs:565) 接受报告空态或页面出现“报告”文字，只证明工作区能打开，没有要求本次任务保存有效报告。
- [verify-workspace.mjs:1079](D:/SomeProjects/AgentCompetition2026/apps/research/scripts/verify-workspace.mjs:1079) 的旧报告回归可读取既有产物，缺失报告还可被跳过；它不验证从真实模型新建报告。
- [HANDOFF.md:117](D:/SomeProjects/AgentCompetition2026/docs/HANDOFF.md:117) 和 [STEP_3_7D_PLAN.md:582](D:/SomeProjects/AgentCompetition2026/docs/STEP_3_7D_PLAN.md:582) 已承认真实报告生成未通过。旧产物回归不能补足这项失败。
- 本次实际模型使用数组表格，既有规范对象形状的测试无法覆盖该输出。没有证据表明“全部离线测试通过”涵盖了本次输入。

因此应纠正 READY FOR DEMO，强化验收条件；不能把失败归结为用户不会使用。

## 2. Report Failure Root Cause

### 2.1 实际服务、任务和产物

已从进程启动参数确认：PID 69648 运行 apps/research/dist/research-server.mjs，参数为 --port 8791 --data .scratch/my-run-data。另有端口 4310 的 researchpage-data 服务；本报告没有混用其数据。

真实目录：D:/SomeProjects/AgentCompetition2026/.scratch/my-run-data。

| 项目 | 本轮只读快照 |
| --- | --- |
| Task | task_6468f12be2749dc6，GraphRAG / HippoRAG2 / LightRAG / vanilla RAG 的多跳检索与成本比较 |
| Session | 86427eda-90fb-4512-b27b-87b5ae29432c |
| Intent | itn_4bbf04f2f29e3235，已确认，version 11，7 条 turn，已绑定 Task |
| Task / Brief | 02:28:45 创建 Task，02:28:59 确认 Brief |
| 首次失败 / 最后记录失败 | 02:32:15 / 02:34:49，均为 2026-10-09 UTC+8 |
| 当前任务 | failed；busy=false；hasReport=false；currentReportId=null |
| 研究资产 | 12 个来源、6 个成功读取快照、52 条 evidence、17 条 assessment |
| 矩阵 | 共 20 项：已核对 8、冲突/不可比 2、有限支持 3、缺失 7 |
| 草稿 | 标题、摘要、框架、9 条 claim、8 个 section 已持久化；比较表的规范化行为空 |
| 正式产物 | reports=0，exports=0，proposals=0，revisions=0；reports 目录没有报告文件 |
| 执行记录 | 21 条 research_runs、82 条 activity；research attempt.number=3 |

用户截图的 7 次检索请求、7 个候选、4 个读取来源属于较早阶段。初轮活动可核对到 7 次物理 discovery 请求和 4 个不同读取来源；后续重开研究增加了来源和读取，故当前是 12 / 6。物理请求次数包含回退/重试，不等同于预算中的逻辑 search 调用数。

当前累计使用为 6 次 search、6 次 read、3 次 gap round；最后一轮 attempt 使用为 0 / 0 / 0。累计三轮出现 3 次 gap 不能据此认定单轮突破了 2 次上限。

research.db 通过 SQLite readOnly 读取，并用端口 8791 的只读 Task / Runtime API 交叉核对。host.db 被运行中服务锁定，使用 mode=ro&immutable=1、query_only 读取；它不是在线事务一致性快照，可能遗漏实时变化。因此下文关于 Host 的结论限于已读记录，不宣称恢复了未保存的底层错误。没有复制数据库、写入 checkpoint 或停止进程。

### 2.2 首轮确实进入报告生成

| 阶段 | 时间，UTC+8 | 结果 |
| --- | --- | --- |
| research | 02:28:59 → 02:29:45 | completed |
| gap_research | 02:29:45 → 02:29:57 | completed |
| report | 02:29:57 → 02:30:46 | completed，写入草稿；没有正式报告 |
| synthesis | 02:30:46 → 02:31:44 | limited，max_steps；存在 finalize 校验拒绝 |
| synthesis retry | 02:31:44 → 02:32:15 | failed，INTERNAL_ERROR |

这里的 report run completed 表示执行阶段完成，不表示 Report Contract 通过或报告入库。若把它展示成“报告已完成”，会误导用户。

### 2.3 从按钮到最终失败的完整链

| 环节 | 当前实现与实际结果 | 源码定位 |
| --- | --- | --- |
| 前端点击 | 确认 Brief、空闲且无报告时可撰写；通过 act 调用 API | [research.tsx:321](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/research.tsx:321) |
| HTTP | POST /api/research/tasks/:id/report；返回 202 表示已受理 | [api.ts:1432](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/api.ts:1432)、[routes.ts:1674](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/routes.ts:1674) |
| 入队 | startReport 在既有 session 入队，未建立独立报告恢复 attempt，也未先清理报告失败状态 | [runner.ts:1475](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:1475) |
| Prompt | report 写章节，synthesis 综合并 finalize；说明 columns / rowSubjects，但缺少完整 cells 形状示例 | [runner.ts:635](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:635)、[runner.ts:653](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:653) |
| 工具 Schema | section / block 是宽泛 object，没有声明完整嵌套必填字段 | [tools.ts:577](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/tools.ts:577) |
| 模型输出 | 生成了正文和表格字符串；多次遗漏 section.id；表格 rows 为数组行 | Host 真实 save_report 调用记录 |
| 解析 | 数组不能作为 row object，退化成空 object，最终 cells=[]；没有返回格式错误 | [tools.ts:1143](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/tools.ts:1143) |
| 校验 | preview / finalize 执行 Q03 和 Claim Contract；首轮同时出现 Q03、Q08、Q09 | [service.ts:4353](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:4353)、[artifact.ts:365](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/artifact.ts:365) |
| 保存 | 草稿增量保留；finalize 校验失败时不执行 repo.saveReport、不进入 ready | [service.ts:4285](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:4285)、[service.ts:4393](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:4393) |
| 前端终态 | act 受理后刷新/轮询；runner 在没有 currentReportId 时写入统一失败文案 | [store.tsx:1149](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/store.tsx:1149)、[runner.ts:1367](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:1367) |

HTTP report 路由目前只检查任务存在；Brief、任务级 busy、待确认修改以及已有报告的服务器保护不完整，不能只依赖前端按钮。旧报告必须继续走 Ask/Edit → Proposal → 用户接受 → Frozen Revision，不能通过新增重试入口覆盖。

### 2.4 Q03：根因是文本丢失，不是模型完全没有写表

**已证实。**

真实 save_report 记录中，表格有 5 个维度列、4 个 rowSubjects；每行是 6 个字符串，第一个字符串重复对象名称，其余是维度说明，包含明确的证据不足或不可比陈述。多轮修复仍提交这种数组形状。

现有解析器只接受 rows 中每行具有 cells 属性，且每个 cell 是含 text / claimIds 的对象。数组行经 asRecord 得到空对象，生成 cells=[]。因此真实正文在进入 Validator 前已经丢失。

这是三个层面的不一致：

- Schema 没有明确要求 section.id、rows[].cells[].text 等关键结构。
- Prompt 描述了比较表语义，但没有给足解析器实际接受的完整形状。
- Normalizer 对不支持格式静默降级，Validator 看到的是“空白”，无法告诉模型“你提供的数组行无法解析”。

Q03 在 [artifact.ts:108](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/artifact.ts:108)、[artifact.ts:548](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/artifact.ts:548) 检查新比较表的单元格及结构义务。**它已允许明确写“缺乏直接证据”“有限可比”“不可直接比较”等内容，并没有要求 20 个单元格都必须有充分证据。** 因而“关闭 Q03”或“加大预算填满所有证据”均不是最小修复。

实际 Host finalize 返回明确列出 20 个空白单元格；其后模型改写数组里的缺口文字，解析器仍丢失这些文字。首轮还可见多次 section.id 缺失导致的工具拒绝，说明同类 schema 问题消耗了修复步数。

本轮内存离线复现：

1. 加载当前真实草稿：validateReport 返回 Q03 和两个 Q08 问题，Q09 当前已通过。
2. 只在克隆草稿中把空格填为“缺乏直接证据；本轮无法形成判断”，claimIds=[]：Q03 消失，Q08 仍保留。
3. 用真实 createResearchTools 和内存 service 调用 save_report：字符串数组行被转成 cells=[]；规范 cells 对象保留文本。

这些检查没有写回数据库，也没有把克隆草稿发布成报告。

### 2.5 Q08 / Q09：必须分别处理

**Q08 有误判，也有应保留的真实性约束。**

[claims.ts:63](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/claims.ts:63)、[claims.ts:132](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/claims.ts:132) 对“更便宜”等词直接做 regex 匹配。离线复现确认 assertsRanking 对“不能合成一个‘更便宜’的判断”仍返回 true。实际草稿的成本限制 claim 使用了这种否定表达。

但初次拒绝还涉及仅有限可比、LightRAG 缺乏支持，以及 tokens / calls 和 memory 等不同成本口径混用。[claims.ts:258](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/claims.ts:258) 阻止这些口径合成成本排名有合理性，不能全部清除。

最小方向：对明确的否定/禁止排名表达做局部、带回归用例的识别；同时把作者报告的成本按指标、阶段、实验条件拆开。保留“不同口径不能推出谁更便宜”的规则。不能仅看到“不能”就豁免整段里其它肯定排名。

**Q09 初轮拒绝是合理的。**

跨来源综合 claim 首次只有一个不同 source，即使绑定四条 evidence 也不满足两来源综合要求。后续当前草稿的 Q09 已通过；不能把它列为最后仍存在的阻断，也不能通过同一来源重复 evidence 凑来源数。

### 2.6 为什么重试没有改善

有两种失败，需要分开：

1. **初轮生成与修复失败：已确认机制。** 同类数组再次提交继续丢文本，section.id 缺失反复被拒绝，成本 claim 还触发 Q08。局部修复上下文未提供足够具体的规范形状。
2. **后续执行失败：底层原因未知。** 第二轮新增了资料，但其后的 report/synthesis 约 0.8 秒即失败；最后一轮 research/report/synthesis 和两次手动 report 的相关 run 多为 0.45–0.86 秒失败，没有新的 assistant/tool 事件。Host 记录为终态 error、INTERNAL_ERROR，公开 error_code 未携带细因；session 已回到 ready，activeRun 为空，不是一个永远未结束的运行。

在已读 Host 快照中，tool_call 与 tool_result 配对完整，没有发现未回答调用或错配，不能把“历史消息配对损坏”写成已确认原因。也不能凭快速失败推断为 API Key、429 或上下文超限。

没有找到属于该数据目录和这些 run 的可用持久服务日志；其它 .scratch 日志对应不同试验目录，不应混用。[composition.ts:130](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/composition.ts:130) 的日志包装主要覆盖 stream 抛错，compose / context 等边界仍需定向诊断。

[runner.ts:993](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:993) 可自动重试同一 StageRequest；计数与 research attempt.startedAt 关联。重复请求未必重新取最新草稿缺陷。report 执行失败后，只要没有 currentReportId，仍可能进入 synthesis；最后统一覆盖成“没有保存有效报告”，丢失用户可操作的错误分类。

重新研究会开始新的研究 attempt，复用旧资产但再执行研究；手动撰写则复用 session 入队 report。两者不是同一个操作，也没有被完全禁止，但缺少独立报告恢复状态、准确错误和有界修复，实际都未产生正式结果。

### 2.7 推荐的最小 P0 修复

**第一步：先补诊断，再修表格契约。**

- 在应用 composition / runner 的现有边界记录 taskId、runId、reportAttemptId 和固定安全分类：context_build、model_request、tool_schema、validation、storage、runtime_unknown。公开 DTO 返回安全分类、关联 ID、受影响章节/单元格和可用操作；不回传原始堆栈、请求头、凭据、文档正文或任意异常文本。
- 对同一真实任务的快速失败先定位分类。现有证据不足以授权把某个 Core 模块认定为根因；只在边界证据明确后做局部修复。
- 完整声明 section.id、block.kind、columns、rowSubjects、columnDimensions、rows[].cells[].text / claimIds；Prompt 使用同一规范示例。
- 对不支持的数组行立即返回带路径的 schema 错误，保留原始工具参数供定向修复，禁止静默转为空格。P0 不必接受任意格式；如兼容旧数组，必须明确识别与 rowSubjects 相同的首列、校验长度并重新验证 claim 绑定，不能猜测删列或截断。
- 复用已保存正文/claim/资料，让模型只修错误路径。真实表中的事实陈述仍需对应 claim/evidence，不能把原始数组绕过校验直接发布。

**第二步：保留真实性，交付有明确局限的有效报告。**

| 必须阻断正式发布 | 可带警告交付 |
| --- | --- |
| 不存在/跨任务的 source 或 evidence；引用与快照来源不一致 | 某维度没有直接证据，表格明确说明 |
| 编造论文、引用、实验数字；摘要冒充全文；无依据的确定判断 | 只读摘要/节选，明确标注读取范围并收窄论断 |
| 不可比成本合成排名、综合 claim 不满足来源要求 | 作者口径不同，分别陈述并明确“无法直接比较” |
| 无法解析的结构、必要字段缺失，导致可溯源性无法验证 | 有限覆盖、冲突尚未解决，显示 gapNotes / 覆盖警告 |
| 覆盖冻结版本或绕过用户接受 Proposal 的边界 | 部分矩阵单元只给缺口说明，不强造结论 |

优先沿用现有 ready + validation.ok=true + gapNotes / warnings，不新增一套并行 Report Contract。展示层称“有效报告 · 证据有限”；它通过相同硬约束，差别是覆盖警告，而非真实性门槛降低。

只在真实缺项写清楚缺口；不得自动把被拒绝的具体断言统一改成“证据不足”来隐藏错误。旧章节 carry-over 的特例也不能用来让新报告绕过 Q03。当前数据不支持把章节数量认定为主要根因，本次无需重写章节合同。

草稿没有全部丢弃：它已持久化，但用户只能看到没有正式报告。可显示“未发布草稿 / 尚有 N 项阻断”帮助恢复；不得把它当正式产物导出或标记为成功。

**第三步：独立、有限的报告恢复。**

- 复用 POST /tasks/:id/report，允许空 body 兼容旧客户端；有草稿时默认 resume。增加服务器确认、任务级互斥、待确认修改与已有报告保护，已有正式报告返回 report_exists 并引导既有修改流程。
- 建立独立 reportGeneration 元数据：attemptId、status、stage、startedAt、endedAt、safeFailure、可恢复路径。受理时清理本次报告失败状态；保留 Brief、任务预算、Sources / Evidence / Assessments 和草稿。
- 每个报告 attempt 在初次执行后最多进行一次针对最新错误的局部修复；修复前刷新 validation，而非重放旧 instruction。持续失败则停止并显示真实原因。
- 非可重试执行故障停止后续 synthesis 连锁调用。schema / validation 问题走定向修复；transient 错误仅在明确可重试分类和上限内再试。
- 前端默认按钮为“用现有资料恢复报告”；“重新研究”作为另一项明确会开启新研究预算的动作。缺某个证据时才建议补资料/定向补查。
- HTTP 202、run completed、草稿已写入、Report 已验证保存必须是四个不同事实；只有最后一个允许报告成功展示。

## 3. Settings & Integration Review

### 3.1 模型配置

**现状已证实。** [settings.tsx:88](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/settings.tsx:88) 仅展示 runtime。模型从启动配置与环境变量取得；[main.ts:95](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/main.ts:95) 的启动路径要求凭据，[composition.ts:164](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/composition.ts:164) 只装载选中的一个 built-in profile，并用启动时 credential 创建 composition。网页不能完成首次配置。

现有 pi-ai composition 已具备 credentials / endpoints resolver、模型 profile、有限 context / output 校验，可复用。已审计调用协议为 openai-completions 与 anthropic-messages；不能在菜单里承诺所有 Provider 协议。[composition.ts:81](D:/SomeProjects/AgentCompetition2026/packages/model-pi-ai/src/composition.ts:81)、[pi-ai-client.ts:103](D:/SomeProjects/AgentCompetition2026/packages/model-pi-ai/src/pi-ai-client.ts:103)。

现有 [client.ts:120](D:/SomeProjects/AgentCompetition2026/packages/client/src/client.ts:120) 有 settings.get/update，但这是 desired/effective 分离接口。[host/state.ts:217](D:/SomeProjects/AgentCompetition2026/packages/host/src/state.ts:217) 明确实例运行期间不更新 effective，保存后需要重启。**不能接一个 settings.update 就宣称新请求已使用新模型。**

最小实现：

1. 新增 ResearchPage 应用层 settings manager，持久化非秘密配置和 revision。在现有 TrustedComposition 边界，每次 run 开始取得已验证的模型配置/profile/client 快照，调用既有 pi-ai adapter；不改 Host 的 effective 生命周期语义，也不让静态 Host metadata 冒充实际模型。应用 Runtime 来自该有效快照。
2. 配置保存仅在无研究/报告执行、无排队工作时立即应用；忙时返回 409 configuration_busy，保留未保存表单。这样不需要热切换活跃 run 或重启整个服务。每个 run 记录 configRevision；保存成功后的新 run 必须用新配置。
3. 无配置时允许启动网页，显示“未配置”；开始研究前返回 configuration_required。首次配置不能以已有环境变量 Key 为前提。
4. 网页提供受支持 Provider/协议、Base URL、password 型 API Key 输入、可编辑 Model ID、模型列表、连接检查、保存及应用状态。列表不能替代手输。
5. /models 只在 adapter 明确支持时调用。404/405 等“枚举不支持”保留手输；认证失败/网络失败独立显示。列表给出 ID，不证明 tool 支持、context 长度或 output 上限。
6. 手输 ID 绑定已审计兼容 profile，使用有限 context/output 参数；未知能力必须显式声明并检查，不能自动假设无限上下文。连接检查是一笔有界模型/工具兼容调用，区别于仅成功获取 /models。

**持久化与生效边界：**

- 保存值优先，环境变量作为未保存字段的默认/兜底，最后才用产品默认；显示来源和 effective revision。
- API Key / Token 用 write-only 操作 keep / replace / clear；GET 只返回 configured 和来源，不返回值、掩码片段或密文。
- Windows 最小方案采用 CurrentUser DPAPI 或系统凭据存储；数据库只保存 secret reference，秘密文件位于受保护的数据目录，限制 ACL，并排除 Git。不得用明文 host settings namespace、普通日志或 localStorage 存密钥。
- 先校验候选配置并准备 secret reference，再原子发布配置 revision；失败不改变 effective，孤立 reference 可清理。旧值在确认新配置已应用前不能被破坏。
- 显式切换 MinerU Flash 模式必须忽略环境变量 Token；clear 的含义与“恢复环境默认”分别定义，避免删掉网页 Token 后又悄悄回到 env Token。

**自定义 Base URL 的必要约束：**

复用 [model-pi-ai/composition.ts:183](D:/SomeProjects/AgentCompetition2026/packages/model-pi-ai/src/composition.ts:183) 的 canonical URL 与 endpoint allowlist 校验，再在产品配置边界管理经过批准的精确 origin/base。默认 HTTPS；拒绝 userinfo、控制字符、不合法路径/参数，检查解析地址，阻止私网、保留地址、link-local、云 metadata 和 IPv6 等价地址；处理 DNS 变化与重定向，禁止携带凭据跨 origin 跳转。对枚举、检查及实际生成使用同一受控 transport，而不只保护“连接检查”。响应大小和时间有界。本地 HTTP 仅用于服务器明确启用的受信本地 profile，不自动探测内网。设置写入沿用本地产品的访问边界并验证 Origin/CSRF，不因新增表单开放跨站配置。

这属于新增可配置 URL 的实现要求，不是将此前关闭的安全问题重新判定为现有漏洞。

### 3.2 最小后端 API 契约

下表均以 /api/research 为前缀，属于修复计划，尚未实现。

| API | 最小输入 / 输出与行为 |
| --- | --- |
| GET /settings | 返回 revision、effectiveRevision、redacted model、研究默认预算、实际 discovery 顺序、MinerU 模式/配置状态、capability、checkedAt；无秘密 |
| PATCH /settings | expectedRevision、非秘密字段及 write-only secret operations；成功返回已应用 revision。冲突 409 revision_conflict，工作忙 409 configuration_busy，非法参数 400；不得返回“已生效”却仍用旧配置 |
| POST /settings/model/models | 检查候选配置，允许一次性 write-only Key，不自动保存；返回 supported=true + IDs 或 supported=false + manualAllowed；失败安全分类 |
| POST /settings/model/check | 显式触发一笔有界生成/工具兼容探测，不创建研究 Task；返回 checkedAt、protocol、安全结果 |
| POST /settings/mineru/check | 调用现有 readiness 的受控公开投影，返回可达性、parse_documents 能力、模式和时间；不上传文件、不执行 OCR |

保存接口实现完成后，前端刷新有效配置，不以表单本地值作为运行事实。保存不隐式执行付费模型检查或在线转换。

### 3.3 研究预算

**当前来源和冻结时机已证实。**

[domain.ts:244](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/domain.ts:244) 固定默认为 searches=6、candidates/search=5、reads=10、gapRounds=2、deadlineMs=480000。[structure.ts:153](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/structure.ts:153) 在创建 Task 时复制预算，早于确认 Brief；并非设置页读出的动态配置。

[service.ts:1446](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:1446) 的新 attempt 重置单轮用量，保留累计量与任务预算；失败重试不能套用新全局默认。[service.ts:1714](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:1714) 主要按本轮用量和 elapsed 判断研究动作。额外用户动作 allowance 应继续独立，不被默认预算保存悄悄扩大。

8 分钟不是整个报告流水线的硬完成期限：研究动作检查 deadline，report/save 没有统一同样的总截止；[runner.ts:710](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:710) 还有独立阶段超时。设置页“单次运行时限”应改为“研究动作时间预算”，进度页不能把它当 ETA。

**最小方案：**

- 全局设置只影响后续新建 Task。创建 Task 时由服务器校验并复制预算，记录 defaults revision；已有 Task、运行中任务和失败重试维持原快照。
- Intent 先建立、Task 后建立时，在 Task 创建时取默认值；界面清楚说明生效时点。
- 可在后续新增任务预览时允许一次覆盖，必须在服务器创建时校验冻结；本轮最小交付不需要改 Intent API 或让用户修改活动任务。
- 建议产品边界：searches 1–30、candidates 1–20、reads 1–50、gapRounds 0–5、deadlineMs 60000–1800000。它们是建议上限，不是当前事实；实施时统一定义并评审。拒绝非整数、负数、NaN / Infinity、溢出和超界值，不能静默舍入。
- 设置页展示“新任务默认”；任务页展示“本任务固定预算”。分别显示逻辑 search、物理 provider 请求、不同来源读取、本轮与累计用量。

### 3.4 实际来源能力

静态“只有 arXiv、上传未接入”的描述来自 [settings.tsx:140](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/settings.tsx:140)，与实现和用户数据不符。

| 能力 | 实际实现 / 边界 | 应展示状态 |
| --- | --- | --- |
| arXiv | 已实现；真实任务有成功请求；读取优先 HTML 正文，必要时摘要页 | 已集成；最近成功与时间，不能用硬编码徽章代替实时健康 |
| OpenAlex | 已实现，默认在 arXiv 失败或无结果后回退；不是每轮并发搜全网 | 已集成；未检查时显示“未检查”，不能假称本轮成功 |
| 检索 fallback | 已有有限重试、breaker、超时与 telemetry；abort 不继续 fallback | 展示实际 arXiv → OpenAlex 顺序及安全失败分类 |
| 网页 / arXiv HTML | 尝试抽正文，失败可退摘要；body_excerpt、abstract、metadata 必须区分 | 已实现有限正文读取，不承诺所有 URL 全文 |
| 远程 PDF URL | 正文读取不会自动把远程 PDF 下载送 MinerU | 单列“远程 PDF 自动解析暂未实现”，不能混成所有 PDF 未接入 |
| Markdown Library | 已实现直接上传和持久化文档 | 已集成且本地可用 |
| 本地 PDF / DOCX | 已实现上传 → Conversion Job → Markdown Document | 已集成，在线转换可用性由 MinerU 状态决定 |
| MinerU MCP | 官方固定适配器、parse_documents；真实任务有 converted / mineru / server_verified 文档 | 已集成；本轮未重新探测当前健康 |
| OCR | 历史验收有真实扫描件成功；转换接口没有暴露 OCR / language 选项 | 支持扫描件转换已有实测；不承诺所有扫描件，也不伪造 OCR 开关 |
| 用户文档作为 Research Source | 已有显式研究来源用途及 provenance；不是每个上传自动变来源 | 展示用途及“加入研究来源”；之后仍须真实读取/评估 |
| 通用 MCP 平台 / 其它搜索引擎 | 未实现 | 暂未实现 |

检索证据：[discovery.ts:155](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/discovery.ts:155)、[discovery.ts:215](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/discovery.ts:215)。
读取证据：[read.ts:158](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/read.ts:158)、[read.ts:259](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/read.ts:259)、[read.ts:299](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/read.ts:299)。
文档来源边界：[service.ts:2795](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:2795)。

本任务的两份 ready 文档均为 intent_context，linkedSourceId=null；其中一份来自 MinerU 转换。它们没有自动计入 Research Source 是正确的用途边界，不能为了凑阅读数直接改计数。

设置应分开 capability、configured、health。已实现且配置完成又有近期成功检查才能标“已集成且可用”；缺必要配置标“已集成但未配置”；确有连接失败标“服务不可达”；没有实现标“暂未实现”。额外需要“未检查/检查已过期”，否则会把未知强行伪装成可用或失败。

最小检索设置仅暴露现有 arXiv / OpenAlex 开关和顺序，至少保留一个 Provider；保存后新 attempt 冻结该策略。默认仍保持既有回退语义，不把“优先级”扩展成新的多引擎插件架构。

### 3.5 MinerU Token、readiness 和限制

[mineru.ts:284](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/mineru.ts:284) 启动时从 MINERU_API_TOKEN 取值；有 token 为 Token，无 token 为 Flash。[mineru.ts:218](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/mineru.ts:218) 只向受控 child environment 注入 MinerU Token，不把模型 Key 顺带传入。

每次 probe 或 conversion 建立子进程连接，finally 关闭，见 [mineru.ts:341](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/mineru.ts:341)、[mineru.ts:414](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/mineru.ts:414)。因此正确的配置更新无需维护一个长期进程重启按钮；但当前 settings 是启动快照，现状仍需父服务重新启动才能读到环境变量变化。

[mineru.ts:461](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/mineru.ts:461) readiness 主要验证初始化和 tools/list 中是否存在 parse_documents，不证明 Token 有效、账户额度足够或文件能 OCR。缓存 TTL 为 60 秒，见 [conversions.ts:75](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/conversions.ts:75)。

**限制必须如实区分：**

- 目前 HTTP 与 Conversion Manager 对所有模式实际强制 10 MiB 上传上限，见 [conversions.ts:719](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/conversions.ts:719)。Token 不能突破它。
- 仅接收 PDF / DOCX；Token 不会让本产品自动支持更多文件格式。
- 公共 DTO 均发布 maxPages=20，见 [routes.ts:1285](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/routes.ts:1285)。源码页数错误识别主要来自上游 Flash 拒绝，未发现对所有模式统一进行本地页数预检。不能把这个字段直接宣称为 Token 已验证的解析上限。
- 设置应明确“本产品上传上限 10 MiB”“Flash 服务页数上限 20”“Token 页数按服务响应，尚未验证”。如要对 Token 也承诺本地 20 页硬限，须实际增加并验收页数约束。
- 现有“配置 Token 可用更大限制”的引导与本产品硬限冲突，应修正文案，而非凭 UI 宣称限制已解除。

**更新方案：** Token 使用上述 secret store；模式显式 flash/token，token 模式没有凭据则“未配置”。保存时要求 conversion 队列及运行任务空闲；下一次 probe/conversion 取新配置，清除旧 readiness 缓存。不能通过调用整个 conversions.shutdown 来更新配置，因为它会清理 job 和工作目录。

Conversion Job 当前在内存中；成功文档持久化不等于 job 收据跨重启保存。更新配置不能丢弃仍可重试文件、转换收据或已经落库的文档；刷新恢复优先查询 Document Library，不把重启后的 job 404 当作文档也丢失。

前端展示模式、Token 是否配置、检查时间、PDF/DOCX、实际限制和第三方在线解析提示，沿用已有用户上传同意边界。公开结果继续使用 [routes.ts:1273](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/routes.ts:1273) 的受控字段，不暴露 MCP stderr、命令行、预签名 URL、内部路径或 Server 的不可信自报字段。

## 4. UI/UX Review

公开参考显示：ChatGPT deep research 用步骤与来源摘要追踪工作，Claude Research 强调逐步检索及可核查引用。Codex 的历史公开任务介绍提供进度和日志/测试证据。[OpenAI deep research](https://openai.com/index/introducing-deep-research/)、[Claude Research](https://support.claude.com/en/articles/11088861-use-research-on-claude)、[Codex 历史介绍](https://openai.com/index/introducing-codex/)。

以下“摘要优先、详情按需展开”的布局是本报告根据这些公开原则及当前组件作出的设计建议，不声称是三者当前界面的逐项复制，也不展示私有推理过程。

本轮使用 computer-use 技能尝试只读浏览器检查，但自动化环境启动失败，未进行新的页面操作。视觉核对限于既有 03-direction.png / 06-progress.png 历史 Gate 截图，它们是其它任务，不是本次 GraphRAG 的新截图；浏览器当前验收仍未完成。

### 4.1 Intent Conversation

[intent.tsx:73](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/intent.tsx:73) 已区分 user / assistant；[styles.css:1361](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/styles.css:1361) 已右对齐用户容器，浅底色和边框偏弱。不能写成“完全没有用户消息样式”。

[intent.tsx:385](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/intent.tsx:385) 已有默认折叠的“助手对回答的理解”；[intent.tsx:357](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/intent.tsx:357) 已有推荐回答预填；这些功能应保留并提高层级。

主要问题是助手正文/提问权重接近，why 解释持续占流，方向编辑区位于输入区前方，长表单把 composer 推到页面下面，见 [intent.tsx:413](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/intent.tsx:413)、[intent.tsx:487](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/intent.tsx:487)。

**具体布局：**

- 保持当前纸面底色、rp-ink / rp-line / rp-accent 与 Mantine 组件；中央对话列 720–760 px。
- 用户气泡靠右，最大约列宽 70%，加深浅色背景/边框对比，保留“你”和时间；助手左侧保留清楚身份图标/标签，正文 14–15 px、行距约 1.7。
- 当前非 direction turn 的 text 作为本轮提问区域；why 放到“为什么问”折叠说明。不要用正则拆分混合正文来发明协议不存在的语义字段。
- 推荐回答紧接当前问题作为辅助 chips，选择后只预填、允许编辑，不自动发送；较多选项折叠，不打断历史阅读。
- composer 固定在中央列底部，输入最小 2 行、最多约 6 行。按现有状态展示“正在澄清 / 等待你的回答 / 研究方向待确认”；忙时禁用发送，不用 UI 自行猜测模型思考内容。
- 宽度 >=1280 px 时，方向确认卡放右侧约 320–380 px；较窄桌面放在对话列中独立折叠卡，确认按钮清晰固定在卡内。普通聊天、可编辑方向和正式确认有明确边界。
- 文档附件/Library 用现有折叠区域或 drawer 保留上传和用途确认，避免长列表挤压输入。
- 保留 version 冲突处理、重新读取最新 Intent、显式用户确认、已绑定 Task 的恢复逻辑。自动滚动只在用户已位于底部时触发；检查焦点、键盘、中文输入法组合状态和 aria-live。

不新增聊天框架，不改 Intent API，不把点推荐选项等同于确认研究方向。

### 4.2 Research Progress

[research-progress.tsx:67](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/components/research-progress.tsx:67) 的 expanded=false 只截成最近十条，并未真正隐藏详细日志。组件同时显示大量事实、timeline 和失败操作；内部 stage 字符串仍可出现在事件行。

[presentation.ts:446](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/presentation.ts:446) 组合任务、运行和活动；completedStages 根据整个历史推导，不能直接用来画当前 attempt 全部完成。searchAttempts 为累计物理请求；各计数必须标明口径。

**默认摘要卡：**

| 区域 | 具体内容 |
| --- | --- |
| 主标题 | 真实 currentStage 的用户文案，如“正在读取研究资料”“正在生成报告”“报告生成失败” |
| 当前操作 | 只使用后端已有 activity 的安全摘要；没有当前具体问题字段时不虚构“正在核对某个问题” |
| 成果 | “项目累计找到 N 个候选、已读取 M 个不同来源、仍有 K 项缺口” |
| 等待 | 本轮已用时间、最近活动时间；研究阶段显示固定研究动作预算 |
| 详情入口 | 默认关闭“查看活动详情”，内部按搜索、读取、补查、评估、报告/校验分组，保留完整原始 Activity Log |
| 失败操作 | 按 P0 safeFailure 显示“恢复报告 / 修复配置 / 补充指定资料”等；重新研究为独立次级操作 |

阶段条采用真实里程碑，不根据预算用量伪造百分比；跳过、重复和回退阶段应允许。所有事件通过统一映射显示中文名称，详情中仍可供诊断查看安全 ID。

**ETA 判断：目前没有足够依据给完成时间范围。**

一个任务的 21 个 run 混有 max_steps、快速故障、重开研究和不同阶段，不构成同模型、同预算、同复杂度的完成时间分布。deadlineMs 也不是报告总时间上限。

先交付“已运行 X 分钟 / 当前阶段 / 最近活动 / 完成时间暂无法准确预估”。研究预算是预算而非倒计时承诺；真实 backoff 的 waitingUntil 才可显示重试等待倒计时。报告恢复使用其独立 reportAttempt.startedAt，不拿最初研究时间冒充本次耗时。终态以 endedAt 冻结计时，并校正服务端与浏览器时钟差。

以后若积累足量成功样本，可按模型、阶段、预算/资料规模分桶给分位数范围；这是后续能力，不应为本轮编造“还需 23 秒”。

## 5. File-by-file Repair Plan

下表是建议修改位置，**本轮没有实施**。各源码证据行号以上述 HEAD 为准；新增文件名是建议名。HTTP 新增只集中于 routes.ts，其余复用或更新 DTO。

| 文件 | 为什么 / 修改什么 | HTTP | 旧功能影响 / 验证 |
| --- | --- | --- | --- |
| [plugin-research/tools.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/tools.ts:577) | 完整嵌套 schema；拒绝损坏格式；返回字段路径与 canonical 示例，保留输入而非空降级 | 无 | save_report 增量语义；实际数组、规范 cells、缺 section.id、未知 block 测试 |
| [plugin-research/prompt.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/prompt.ts:46) | 明确缺证据可陈述缺口；与规范表格 schema 共用示例 | 无 | 工具调用策略；契约一致性及真实 Flash 验收 |
| [plugin-research/artifact.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/artifact.ts:108) | 输出可定位的校验问题；保留 Q03 与已有缺口规则，不关闭硬约束 | 无 | 旧 carry-over 与新报告分支；缺口通过、捏造/空白仍拒绝 |
| [plugin-research/claims.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/claims.ts:132) | 修正否定排名误判；保留跨口径与多来源约束 | 无 | Q07/Q08/Q09；肯定/否定混合句、不同成本、同 source 多 evidence |
| [plugin-research/service.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/service.ts:4285) | reportAttempt 生命周期、局部恢复、safeFailure、服务器预算快照输入 | 无 | 草稿、正式保存、retry、Proposal 接受；失败不丢资产/不覆盖冻结报告 |
| [plugin-research/domain.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/domain.ts:244) | 类型：默认预算输入、配置 revision、报告生成元数据；保留常量兜底 | 无 | 旧任务可读取；边界和兼容快照测试 |
| [plugin-research/structure.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/structure.ts:153) | 创建 Task 接收已验证预算并冻结，不能继续无条件复制固定常量 | 无 | card→Task；新默认生效、旧任务及重试不变 |
| [plugin-research/repository.ts](D:/SomeProjects/AgentCompetition2026/packages/plugin-research/src/repository.ts) | 持久化报告恢复元数据及所需产品配置；必要时增量迁移 | 无 | 旧数据库、restart 恢复、事务失败；migration 测试 |
| [research/server/runner.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/runner.ts:993) | 独立恢复 attempt、最新局部修复 instruction、有界重试、错误分类与停止连锁调用 | 复用 report | 自动流水线/手动恢复；不触发额外 search/read、互斥、故障终态 |
| [research/server/presentation.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/presentation.ts:446) | 报告失败路径、真实当前 attempt、累计/本轮口径、起止时间 DTO | 无 | bundle/polling；旧记录缺新字段时降级 |
| [research/server/routes.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/routes.ts:1674) | report 服务器 guard；settings/read/check API，红线过滤与 revision 冲突 | 新增第 3.2 节接口 | 旧空 body report 兼容；busy/brief/report_exists、秘密泄漏、非法 URL 测试 |
| [research/server/composition.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/composition.ts:124) | 应用级有效配置 resolver，per-run profile/client snapshot，安全诊断，动态 Runtime | 无 | 既有 pi-ai / context builder；配置 A→B 后新 run 真用 B、旧 run 固定 A |
| [research/server/main.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/main.ts:95) | 启动恢复保存配置、环境兜底；允许未配置网页启动 | 无 | 原 CLI/env 路径；无 Key 初次设置与重启恢复 |
| research/server/settings.ts（拟新增） | 统一候选校验、预算范围、revision、idle apply、有效状态与实际 capability | 无 | 与 Host desired/effective 区分；原子保存、冲突与忙态 |
| research/server/secrets.ts（拟新增） | DPAPI/系统凭据、write-only secret operations、ACL 与清理 | 无 | env fallback；重启、替换/清除、所有 DTO/log 无 Key/Token |
| research/server/provider-config.ts（拟新增） | 复用 pi-ai profile / transport；有限能力声明、受控 endpoint、枚举与有界检查 | 无 | 支持协议不扩张；无 /models 手输、SSRF/redirect、有限 token/context |
| [research/server/mineru.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/mineru.ts:284) | 显式模式及 secret resolver，统一真实限制与安全 readiness 投影 | 无 | 官方 MCP/受控 child env；Flash/token切换、模型 Key 不传子进程 |
| [research/server/conversions.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/server/conversions.ts:434) | idle 配置快照、probe cache invalidation；修正文案，避免 shutdown 更新配置 | 无 | queue/job/file cleanup；更新不丢文档/收据、10MiB所有模式一致 |
| [research/browser/api.ts](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/api.ts:1432) | settings API 与 redacted DTO，报告恢复分类 | 新接口客户端 | 旧 API 兼容；状态码、无枚举支持、错误投影 |
| [research/browser/store.tsx](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/store.tsx:1149) | 受理/执行/验证保存分开；配置刷新、报告恢复 polling 与 stale-response 防护 | 无 | Intent恢复、轮询、切任务；不把202当交付 |
| [research/browser/views/research.tsx](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/research.tsx:321) | 主操作恢复报告；重新研究说明及次级位置 | 无 | Brief确认、busy gate；双击和失败恢复浏览器验收 |
| [research/browser/views/studio.tsx](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/studio.tsx:643) | 未发布草稿/真实阻断空态，已保存报告的有限证据提示 | 无 | Report/Ask/Edit/Proposal展示；草稿不冒充正式报告 |
| [research/browser/views/settings.tsx](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/settings.tsx:88) | 可保存表单、有效revision、write-only secrets、真实集成/限制 | 无 | 主题与导出设置；首次配置、保存生效、重启恢复、状态真实性 |
| [research/browser/views/intent.tsx](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/views/intent.tsx:73) | 消息层级、why折叠、固定输入、独立方向卡 | 无 | 不改协议/确认边界；多轮恢复、预填不发送、IME/焦点 |
| [research/browser/components/research-progress.tsx](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/components/research-progress.tsx:67) | 默认摘要、关闭详情、阶段映射、口径/计时、针对性恢复 | 无 | Activity完整可查；终态计时、旧attempt不冒充当前 |
| [research/browser/styles.css](D:/SomeProjects/AgentCompetition2026/apps/research/src/browser/styles.css:1338) | 当前设计体系内提高对比、列宽和响应式布局 | 无 | 常见桌面宽度、长中文/URL、键盘焦点及内容不被composer遮挡 |
| [verify-intent-documents.mjs](D:/SomeProjects/AgentCompetition2026/apps/research/scripts/verify-intent-documents.mjs:549) | 去掉恒真判断，新增真实新任务保存报告的独立 gate | 无 | 仍保留Intent/上传门槛；空报告明确FAIL |
| [verify-workspace.mjs](D:/SomeProjects/AgentCompetition2026/apps/research/scripts/verify-workspace.mjs:1079) | 旧报告回归与新报告生成分别统计；不以skip补齐新生成PASS | 无 | 旧Ask/Edit/Proposal/Frozen/PDF不回归，新增门槛不可跳过 |

测试落点复用现有 artifact-quality.test.ts、truth-boundary.test.ts、pipeline.e2e.test.ts、retry-api.test.ts、bundle.test.ts、intent-view.test.ts、research-progress*.test.ts、polling.test.ts、conversion-api/fixtures/dto-leak.test.ts 和 migration.test.ts；配置新增针对性的 settings / secret / provider tests。测试必须用实际损坏输入和行为断言，不能只镜像新实现。

既有 report.ts / revision.ts / export.ts 的冻结、可溯源和导出路径作为回归保护；本次没有证据要求重写它们。若增加警告展示，读取既有 contract 数据即可。

## 6. Ordered Repair Phases

### P0 — 报告可靠性

1. 安全诊断与真实错误分类，定位快速 INTERNAL_ERROR；同时固化本次数组/section.id/否定排名复现。
2. schema / Prompt / Parser 对齐，阻止静默数据丢失；修正 Q08 否定误判且保留真实性。
3. 使用现有资料执行局部恢复，独立报告 attempt，有限重试、互斥和准确前端失败操作。
4. 证据不足也能保存有明确 gapNotes 的有效报告；强化新生成 Gate。
5. 用修复后的真实 DeepSeek 至少保存一份新报告，并完成浏览器与 HTML/PDF 尝试，回归旧工作流。

诊断与契约测试可以并行；恢复 API/状态需先明确错误及契约；真实模型验收必须在离线 P0 检查通过后进行。快速 INTERNAL_ERROR 未解决前不能只靠改表格就宣布 P0 完成。

### P1-A — 设置、预算、来源、MinerU

1. 确定应用级配置 revision / secret / effective snapshot 契约。
2. 模型配置与受控连接检查；默认预算及创建时冻结。
3. MinerU模式/Token、readiness和真实限制；来源状态与现有Provider顺序。
4. 网页保存、重启恢复、真实新请求生效验收。

模型与MinerU表单、预算表单可在共享配置契约确定后并行实施；秘密存储和有效配置管理是共同前置依赖。研究默认编辑依赖 Task 创建路径改造。此阶段不能延迟 P0 真报告门槛。

### P1-B — Intent 与 Progress

Intent布局与静态视觉样式可独立准备；Progress摘要、失败恢复及计时依赖P0/presentation DTO。1366、1440、1920桌面验收及多轮状态恢复完成后，才接受UX交付。

最小修复次序为：**诊断 → 表格契约/局部校验 → 报告恢复及真实保存 → 应用配置/秘密 → 模型/预算/集成 → Intent/Progress。**

## 7. Acceptance Matrix

“本轮结果”只表示审查中做过的验证；右栏是修复后门槛，不能用历史通过代替。

| 项目 | 验证类型 | 本轮结果 | 修复后通过条件 |
| --- | --- | --- | --- |
| 用户任务定位与无正式产物 | 只读进程/DB/HTTP | 已确认 | 保留原数据，修复验证用隔离副本/新任务 |
| 数组表格丢正文 | 内存离线复现 | 已复现 | 同样输入不静默丢字；规范格式或明确可修复错误 |
| 缺证据单元格 | 内存离线validator | 显式缺口可消除Q03 | 低证据报告 validation.ok=true、有gapNotes、无编造 |
| Q08否定排名 / Q09来源数 | 离线规则/实际草稿 | 否定误判已复现；当前Q09通过 | 否定限制不误判，肯定混合排名仍拒绝，重复evidence不凑source |
| INTERNAL_ERROR | 实际run记录 | 症状确认，底因未知 | 定位安全分类；同任务复用资料成功或给出真实可操作故障 |
| report恢复及互斥 | 离线API/runner集成 | 源码确认缺口，未实施 | 不额外检索、独立attempt、202≠成功、双击/未确认/已有报告拒绝 |
| 窄主题有效新报告 | 真实DeepSeek | 本轮未调用；现有用户任务失败 | 新Task生成、验证、入库reportId，不能使用旧报告替代 |
| 大量缺口主题报告 | 离线+真实模型 | 当前任务BLOCKED | 明确缺口/不可比，合法引用；保存有效有限报告 |
| 浏览器报告和导出 | 真实浏览器/导出 | 本轮浏览器环境阻塞；旧截图仅参考 | 打开本次新report；HTML有效；尝试PDF并检查结果，依赖故障明确呈现 |
| 旧Report/Ask/Edit/Proposal/Frozen | 离线+旧报告浏览器 | 历史回归记录；本轮未重跑 | 用户接受边界、不可变版本、引用及既有PDF路径不回归 |
| 模型配置保存与生效 | 离线受控transport+浏览器+有限真实模型 | 当前无网页配置 | A→B后新请求真用B；旧run保持A；重启恢复；无/models可手输 |
| APIKey/Token与URL | 离线安全/泄漏测试 | 本轮源码评审 | DTO/log/browser持久化无秘密；私网/重定向拒绝；有效配置失败原子回滚 |
| 研究默认预算 | 离线Task/retry集成+浏览器 | 固定常量/创建冻结已确认 | 新Task用新值；旧Task及重试不变；上下限拒绝且计数准确 |
| 集成状态与fallback | 离线provider故障模拟+浏览器 | 旧文案已确认 | 空结果/超时回退真实；未检查不冒充可用；不存在的搜索/MCP无假开关 |
| MinerU配置/readiness | 离线+浏览器+一次真实readiness | 本轮未探测；历史转换记录存在 | mode切换、secret配置和cache刷新；不把tools/list当Token额度验证 |
| MinerU转换/OCR | 真实MinerU | 本轮未重新执行；历史PDF/DOCX/OCR验收 | 复用可信历史证据；配置改动后必要时一次小文件验收；不批量OCR |
| MinerU限制与Job | 离线API/fixtures+浏览器 | 10MiB所有模式、20页DTO差异已确认 | Token不虚称突破上传限；格式/页数说明与执行一致；配置更新不丢Job/文档 |
| Intent视觉与恢复 | 组件测试+真实浏览器 | 源码/历史截图评审；新浏览器未验收 | 1366/1440/1920下用户归属明显、输入可见、方向卡分离；version/确认/IME正常 |
| Progress与等待预期 | 组件/DTO测试+真实浏览器 | 信息口径与层级缺陷已确认 | 默认摘要简明，完整日志可展开；阶段来自后端，计时终态固定，无虚构ETA |

**READY FOR DEMO 的硬门槛：修复后的真实 DeepSeek 至少生成并保存一份新的有效报告。** 新报告生成门槛不得因为旧报告存在、报告空态可打开或网络失败而记成 PASS。HTML/PDF 的结果及任何环境依赖限制必须单独记录。

本轮普通命令及浏览器自动化遇到 Windows sandbox 启动错误；获准的只读命令完成了诊断。此环境问题不作为 ResearchPage 产品缺陷，也没有因此减少上述修复验收要求。

## 8. Explicit Non-goals

- 本轮不实施生产修复、不提交、不Push、不改用户测试数据。
- 不重新审查整个Agent Core，不重做通用MCP、安全架构或聊天框架。
- 不关闭Report/Claim Validator，不降低引用、读取范围、实验事实、可比性或来源真实性。
- 不覆盖Frozen Revision，不绕过用户接受Proposal。
- 不把上传完成当研究已阅读，不把摘要当全文，不把MCP初始化当转换/OCR成功。
- 不新增虚构搜索插件、通用MCP平台、未经实现的OCR开关或Token大文件承诺。
- 不通过扩大预算、无限重试、重做三轮检索或旧报告替代真实新报告门槛。
- 不伪造百分比、推理过程或精确ETA，不在本轮批量调用模型/在线OCR。

交接文件：[STEP_3_7D_USER_REVIEW.md](D:/SomeProjects/AgentCompetition2026/docs/STEP_3_7D_USER_REVIEW.md)。

**READY FOR DSFLASH REPAIR: YES。READY FOR DEMO: NO。REPORT DELIVERY: BLOCKED。**

---

# 附录 — 实施与关闭结果（2026-10-09，本轮修复后追加）

本附录由修复执行者追加，**不修改上面的原始审查**。原始审查的结论、行号与证据保持原样，
「本轮结果」栏描述的是审查当天的状态；这里是它的后续。

## A. 关闭结论

| 编号 | 原始结论 | 本轮结果 | 证据位置 |
| --- | --- | --- | --- |
| B01 | 表格 schema / 输出 / 解析器不一致，静默丢正文（已证实） | **CLOSED** | `packages/plugin-research/src/tools.ts` 的 `readTable` / `readCells` / `readSection`；`packages/plugin-research/tests/report-table-contract.test.ts` |
| B02 | 报告恢复没有独立状态与有效诊断（恢复缺陷已证实；底层原因未验证） | **CLOSED** | `ReportGenerationState` + `reportGenerationOf`；`apps/research/src/server/model-failures.ts`；`apps/research/tests/report-recovery-api.test.ts` |
| M01 | Q08 把否定排名读成肯定排名（已证实） | **CLOSED** | `packages/plugin-research/src/claims.ts` 的子句级否定；`packages/plugin-research/tests/report-ranking-lexicon.test.ts` |
| M02 | 网页不能设置模型 | **OPEN（本轮未做）** | 设置页如实标注「暂未实现」，未提供假控件；见 `docs/STEP_3_7D_OVERNIGHT_REPORT.md` §7 / §11 |
| M03 | 新任务预算只能取固定常量 | **CLOSED** | `packages/plugin-research/src/settings.ts`；`structure.ts createTask({budget})`；`packages/plugin-research/tests/product-settings.test.ts` |
| M04 | 来源与集成静态旧文案；MinerU 限制说明不一致 | **CLOSED** | `apps/research/src/server/routes.ts` 的 `settingsBundleOf`；「本地上传未接入 / PDF 解析未接入」已删除 |
| M05 | Intent 区分度弱、确认编辑区挤压输入 | **CLOSED** | `apps/research/src/browser/views/intent.tsx` 的两栏布局 + 折叠的提问理由；`apps/research/public/styles.css` |
| M06 | Progress 默认展示十条日志、口径混用 | **CLOSED** | `apps/research/src/browser/components/research-progress.tsx`；`apps/research/tests/research-progress-view.test.ts` |
| N01 | 设置页无 runtime 时候选数兜底为 6 | **CLOSED** | 设置页改为读取服务端 `/api/research/settings`，不再使用前端兜底常量 |
| N02 | 报告空态引导用户判断材料是否足够 | **CLOSED** | 默认动作改为「使用现有资料恢复报告」，由 `reportGeneration` 四态驱动 |

## B. 对审查中「未验证」部分的回答

- **「后续执行失败：底层原因未知」** —— 已定位：**模型服务返回 `HTTP 402 Insufficient Balance`**。
  证据：失败与阶段类型无关（research / report / synthesis 都在 0.42–0.59 秒失败，而此前 13.61 秒的 gap 阶段成功）；
  run 只有 `turn/start` / `message/user` / `turn/end(error)`，没有任何 assistant/tool 事件；
  Host 按设计遮蔽底层原因（`state.ts` 的 `unknownFailure()`、`run.ts` 的 `catch {}`）；
  直接探测 provider 得到 402 `Insufficient Balance`；账户充值后再次探测为 200，真实端到端运行随即成功。
  审查当天「不能凭快速失败推断为 API Key、429 或上下文超限」的判断是对的 —— 真正的答案是**余额**，
  而它只能通过直接观测确认。
- **「公开 error_code 未携带细因」** —— 现在携带安全分类：`context_build` / `model_request` / `tool_schema` /
  `validation` / `storage` / `runtime_unknown` + 固定 code + 操作建议，且不泄漏 provider 正文、状态行、
  请求头、凭据、URL 或堆栈。
- **「旧报告回归不能替代新生成」** —— 认同，本轮按此执行：新报告的 `reportId` 是 `rep_818ea3ad126f548b`，
  经 `reports` 表行、`validation.ok` 与 12 项质量检查确认，不是页面能打开就算通过。

## C. 对本轮修改的既有测试的处理（不是删测试换 PASS）

- `packages/plugin-research/tests/edit-preflight.test.ts` 两例：空白表格现在在**读行阶段**就被按字段路径拒绝，
  比原来的 proposal-preflight 更早、更精确，因此不再出现中间态 `proposal_invalid`。
  它们原本守护的承诺（一份会带空白格到读者手里的表格永远不会成为待确认提案）仍在断言中；
  「一次修复后停止、循环不再继续」的状态机由同文件的 obligation-losing 用例继续覆盖。
- `apps/research/tests/research-progress-view.test.ts`：默认行为从「显示最近十条」改为「折叠 + 可展开 +
  可按类型分组」，断言随之改写为对新契约的检查（含摘要计数与环境依赖分开）。
