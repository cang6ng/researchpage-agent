# STEP 3.7D — F01–F08 Release Repair Plan

## Baseline

- 仓库：D:/SomeProjects/AgentCompetition2026；已核实 HEAD = `25d92505e980794c416def6a575f4d3b044479a8`，规划前工作区干净。
- Source of Truth：`.scratch/independent-release-review-20261009/review.md`；沿用其 F01–F08，不重新开展全面架构审查。
- 已核对原 `probe-results.json`、`model-failure-results.json`、`pipeline-results.json`、`artifact-results.json`、两个 browser results 及 PDF 第 5 页截图，并核对涉及源码。
- 下文 P = packages/plugin-research/src，A = apps/research/src，M = packages/model-pi-ai/src；源码行号均指上述 HEAD。
- E = `.scratch/independent-release-review-20261009`（只读证据）；W = `.scratch/release-repair-20261009`（本次新建隔离数据、日志、截图、PDF）。
- 现有产物：task_d7a11775375d371a / rep_818ea3ad126f548b，8 sections、9 claims、6×3 表格；原 Validator 12 checks PASS，18 格非空。
- 原数据库 `.scratch/overnight-goal-20261009/real-run/store/research.db` 只读；使用 SQLite backup API 创建 W 下自有副本，不能直接复制活动 DB 而遗漏 WAL。
- 本轮只交付规划文档；DSFlash 按以下 4 组连续实施，每组 Gate 通过即继续；全部验收使用离线模型、检索及 MinerU fixtures。

## F01–F08 文件级修复表

| Finding / 根因位置 | 必改文件与函数 | 依赖 / 保留不变量 |
|---|---|---|
| F01：P/claims.ts:175–181，任意前缀否定豁免，正则只读首次命中 | P/claims.ts：assertsRanking、拒绝构式识别、validateClaimContract 调用点；补完整 validateReport 用例 | G1；保留真实拒绝句、Q08 可比性门槛、Q09 来源链，不能改成模型判断 |
| F02：P/tools.ts:1238–1261，去标点后 substring 混淆版本 | P/tools.ts：comparable、labelNamesSubject、readTable；解析局部对象索引 | G1；canonical 格数、claimIds、非空单元格、拒绝路径及写入原子性不变 |
| F03：A/server/runner.ts:1775 只终止 run；presentation.ts:427 信任遗留 running | A/server/runner.ts：execute、ensureReportAttempt、startReport、reconcileInterrupted、shutdown；A/server/composition.ts 启动顺序；P/service.ts：beginReportGeneration、recordReportStage；A/server/routes.ts：taskBundle / report 路由；A/server/presentation.ts：reportGenerationOf；A/browser/api.ts、views/research.tsx：reportActionOf | G2，先完成 F04 安全故障类型；保留材料、草稿、计数、正式报告保护、单任务互斥 |
| F04：M/pi-ai-client.ts:297/400 丢失可信状态；A/server/model-failures.ts:64 误分类；runner.ts:1060/1465 盲重试后 synthesis | M/pi-ai-client.ts：stream、providerFailure、localFailure、Options；M/index.ts 导出新安全类型；M/composition.ts 转发测试 fetch；A/server/model-failures.ts：SafeFailure、classifyModelFailure、ledger；A/server/composition.ts：withFailureLog；A/server/runner.ts：execute、afterStage；P/domain.ts：ReportGenerationFailure；A/browser/api.ts 同步 DTO | G2；只扩展 adapter/app，不改 Core/Host/Protocol；不透传秘密，保留 ledger 隔离/TTL 与既有预算 |
| F05：P/render.ts:74/152，首格正文当 nowrap 标题、整表禁止分页 | P/render.ts：renderBlocks、renderReportHtml、renderRevisionHtml、REPORT_CSS；P/revision.ts：RENDERER / FrozenRevision.renderer 类型；A/server/export.ts：exportRevisionPdf 元数据 | G3 依赖 G1；18 格正文、对象/维度身份、引用、Frozen 内容/hash 均保留 |
| F06：A/server/routes.ts:688 只返回启用项，开关消失 | A/server/routes.ts：settingsBundleOf；A/browser/api.ts：SettingsBundle；A/browser/views/settings.tsx：RetrievalForm | G4；复用 P/settings.ts 的 providerChoices 与服务端非空/order/revision 校验，不增加 provider |
| F07：A/browser/views/settings.tsx:52、routes.ts:718，把 integrated 当可用，静态主备 | 同 F06 文件；settingsBundleOf 的 capabilities；CAPABILITY 标签及动态说明 | 与 F06 同组；implemented/configured/enabled/order/health 分离，GET 不自动探测 |
| F08：A/browser/components/research-progress.tsx:267，两分支均传 null；ResearchAttempt 无 endedAt | A/server/presentation.ts：新增 timingOf；A/server/runner.ts：新增 hasResearchWork；A/server/routes.ts：taskBundle 及两个调用点；A/browser/api.ts：TaskBundle.timing；A/browser/views/research.tsx 传参；components/research-progress.tsx：elapsed / ResearchProgress | 与 F03/F04 同组；计时来自真实记录，不改预算、不回填历史 DB、不混入报告恢复 |

## 必要算法与状态转移

### F01：限定否定作用域

1. 保留排名词表；按句标点、逗号和转折词切段，中文最长词优先（但是/然而/不过/但/却），英文 but/however/yet 用词边界；不按“、”拆对象列表。
2. 每个排名正则复制为带 g 的局部正则，枚举全部命中，合并重叠谓词范围；禁止共享 lastIndex，禁止仅 exec 一次。
3. 先识别完整“拒绝构式”的起止区间，再对每个排名命中检查是否被该区间覆盖；任何未覆盖命中均返回 assertsRanking=true。
4. 闭集构式只接受：直接否定排名谓词（A 不优于 B / A does not outperform B）；否定认识动词（不能/无法/无从/不足以 + 判断/认定/得出/证明/合成/给出）；“没有依据/证据表明/证明/支持”；“no method/approach/system/model + 排名谓词”。
5. 认识动词构式的宾语只接受一个排名谓词及对象，或“一个/谁/哪个/更便宜”等排名名词短语加“的判断/结论/排名”；允许引号、“对 A、B”及本报告/这些数字等明确主语，不允许任意动词或 .* 跨越排名。
6. 对象 token 来自 ClaimContext.subjectNames 的精确名称/ID，以及 A/B、谁/哪个/二者/the other 等闭集占位词；可给 assertsRanking 增加可选对象上下文，保持现有单参数测试可调用。
7. 拒绝构式必须在语法边界结束；并列的新谓词（且/又/and/also）、无关“处理中文/open source”谓词不得被消费。双重否定、no doubt 不生成拒绝区间；无法可靠解析时按存在排名处理。
8. 三条原反例必须被完整 Validator 的 Q08 拒绝；“不能合成一个更便宜的判断”、现有真实成本长句、“不能对 A、B 给出更便宜的判断”必须保留通过。
9. 新增同词重复命中、无标点转折、并列第二个排名、双重否定及“不如”肯定劣势用例；对照“GraphRAG 优于 LightRAG”仍拒绝，不放宽 conditions.comparability。

### F02：精确对象身份

1. ID 使用 trim 后原样精确相等；名称使用 NFKC、trim、连续空白折为一个空格、ASCII 大小写统一；保留数字、点、横线、下划线、括号内容和版本后缀。
2. 以 Task subjects 构建规范化名称 → ID 集合；名称只能在唯一命中且 ID 等于声明 rowSubjects 时接受；未知声明、同名歧义、substring 均拒绝。当前没有别名配置，不推断或新建别名。
3. N 列对应 canonical cells 必须正好 N 格；legacy N+1 数组先验证独立标签再取后 N 格；legacy N 数组仅在该行未声明 rowSubjects 时作为纯 cells 接受。
4. 无声明的 N+1 标签若唯一精确命中则存 ID；未解析的旧标签保留显式标签及既有 warning，不能猜成另一个对象；任何拒绝均不覆盖已有草稿。
5. 复用 E/probe-results.json 的 cross_version_subject 与真实数组样例；补 GraphRAG/GraphRAG 2、v1.0/v10、名称前后包含、歧义名、精确 ID、全角括号正例及拒绝前后草稿相等断言。

### F03 / F04：Generation 与 Host Run

- 持久化 Generation 仍仅 running/draft_saved/validated/failed；idle/accepted 是页面投影，不能新增为持久化状态。一个 generation attempt 可包含 report、synthesis 和至多一次契约修复。
- 新增内部 StageRequest.generationAttemptId；所有后续阶段继承它。给 recordReportStage 增加可选 expectedAttemptId 参数并同步接口；旧 attempt 的回调/队列不得改新 attempt，检查在 grant 与模型调用之前完成。
- ensureReportAttempt 返回有效 state/refusal；自动 report 首次创建后把 ID 传给后续请求，matching attempt 的 synthesis 从 draft_saved 转 running 并更新 stage，不重置 startedAt/resumes；终态不能被旧自动请求重新打开。
- 自动 report 在 afterStage 的调度点开启 attempt 后再 enqueue；先检查 hasReportWork，已有人工报告工作则沿用其队列、不再开启第二份。显式 retryResearch 的新研究 attempt 正常完成后可开启新的 generation，不能误用上次 failed 状态。
- startReport 返回型明确改为 ReportGenerationState | Refusal | undefined，并同步 ResearchRunner、route 与测试 stub；beginReportGeneration / ensureReportAttempt 拒绝后不 enqueue，不返回伪 202。
- enqueue 明确返回是否入队；stopping 或拒绝入队时关闭刚开启的 generation。人工恢复创建新 attemptId/start，resumes 增加一次，保留 repairs/signature、资产与研究预算。

| 事件 | Host / ResearchRunRecord | 持久化 Generation / 页面投影 |
|---|---|---|
| 请求合法、已排队 | 尚无 Host run，可无 run record | running，endedAt=null；实际队列存在才投影 accepted，canResume=false |
| 执行 report 或 synthesis | Host accepted/running；业务 run running，runId 可短暂为 null | running；实际活动报告阶段才投影 running |
| report 正常完成、已有草稿且无正式报告 | report completed；排队 synthesis | draft_saved，endedAt=null；队列仍在时投影 accepted，继续同 attempt |
| Validator 通过且正式 save 成功 | 可完成；save 后崩溃也以正式产物为准 | validated，endedAt 为实际保存/完成时间；只此状态意味着正式报告 |
| 启动失败、取消、超时或不可重试/重试耗尽 | failed；硬崩溃遗留 run 在下次启动变 interrupted | failed，关闭 endedAt，保留草稿；有草稿可投影 draft_saved+failure，允许显式恢复 |
| 正常 shutdown | stopping 后不新增工作；现有 active 可按原策略排空 | 清理被丢弃的 queued attempt；未保存且无法继续 synthesis 的 active 关闭为安全 aborted，已保存者仍 validated |
| 硬终止后重启 | 遗留 running → interrupted，时间表示检测到中断 | 无正式报告且遗留 running（含无 run）或 draft_saved/endedAt=null → failed/run_interrupted；恢复按钮开放，不自动调用模型 |

- 启动收敛只在 A/server/composition.ts 现有位置执行：Host 初始化/旧 run 恢复、client 已连接、新 runner 无 active/queue，HTTP listen 前一次；检查上述前置条件，重复调用幂等，活动 runner 上拒绝执行。
- 延续应用一个 dataDir 一个服务所有者的运行边界；不能让两个进程共同打开测试数据。禁止周期性按年龄判死或对当前进程正在执行的 run 做收敛。
- currentReportId 优先于遗留状态：仅校正 generation 为 validated，使用 reportsOf 中该正式 report.createdAt 或已有可信 endedAt；不重写报告/Revision/材料。已有合法终态记录保持不变。
- run_interrupted 加入安全 code 闭集；若 boot 发现 generation=failed 却 endedAt=null，则保留失败原因并收敛结束记录，计时仍标 unknown，不能把 boot 检测时间冒充完成时间。
- reportGenerationOf 的 busy 只取该 task 的 hasReportWork（active+queue）；runningStage 仅取 report/synthesis；遗留 persisted running 不能单独关闭恢复入口。
- execute 的 runs.start catch、轮询异常、cancel/timeout 和 shutdown 都走新增统一终止收尾；clearGrant 在每个已结束 run 的 finally 中执行，重试发起新 grant，不能遗留写权限。
- afterStage 在没有正式报告的模型失败分支先终止并 return；report 失败不得 enqueue synthesis，research/gap 的永久模型失败也不得启动下游 report。正常成功但草稿未校验者才继续 synthesis / 原有有界修复。

### F04：安全错误与唯一重试层

- SDK 0.87.1 支持请求级 StreamOptions.fetch。在每次 stream 的局部 fetch wrapper 中读取 Response.status；onResponse 位于成功 withResponse 后，不能单独用它分类 4xx/5xx。
- 新增 PiAiRequestFailure extends NonRetryableModelError，kind 为闭集，消息固定；只携带 kind 及可选数值 retryAfterMs，不携带响应正文、URL、Token、原始 cause/stack 或 headers。
- PiAiModelClientOptions 增加可注入 fetch 并在 composition 转发；生产包装正常 fetch，不改 global fetch；测试用 loopback/scripted HTTP。同步 throw、异步迭代 throw、error terminal 均统一分类。
- signal.aborted 或 terminal aborted 优先；可信数值状态其次；200 后异常、无可观察状态及仅消息“HTTP 402”都为 unknown。旧固定失败消息也不能推断余额。
- SafeFailure 增加 retryable 与内部可选数值 retryAfterMs，ledger 原样传给 runner；公开 failure DTO 明确只投影 category/code/problem/guidance/retryable，后者在旧 JSON 缺省 false；unknown 不误导检查余额，不承诺未经计数的“未消耗检索预算”。
- classifyModelFailure 只读新安全类型或受信 adapter 的精确固定错误白名单；自由文本不解析状态码。withFailureLog 在 classify/ledger.record 前将 context.signal.aborted 规范化为新 aborted 类型；报告中断另用 run_interrupted。

| 可信原因 | 安全 code / 指引 | 同一阶段请求自动策略 / 全失败无工具 fixture 实际调用数 |
|---|---|---|
| 402 | model_payment_required；检查支付/余额/配额，不断言具体余额 | 不重试；1 次；synthesis=0 |
| 401 / 403 | model_authentication_failed；检查凭据/授权 | 不重试；1 次；synthesis=0 |
| 429 | model_rate_limited；等待后可重试 | 至多额外 1 次；持续失败总计 2 次；synthesis=0 |
| 503 | model_service_unavailable；服务暂时失败 | 至多额外 1 次；持续失败总计 2 次；synthesis=0 |
| abort / 明确取消 | model_aborted；已取消，可显式恢复 | 不重试；已调用中取消为 1 次，调用前取消为 0；synthesis=0 |
| unknown / 其它未识别状态 | model_request_failed（模型边界）或 run_failed（运行边界）；原因未知 | 不自动重试；已进入调用者 1 次；synthesis=0 |

- SDK maxRetries=0；以上新错误全部仍继承 NonRetryableModelError，Core 不重试。withFailureLog 记录安全 ledger 后也把自由 unknown Error 包成安全 NonRetryableModelError，不能再抛 raw error 触发 Core 隐藏重试。
- Runner 是唯一自动重试层：StageRequest 新增 retryAttempt=0/1、deadlineAt，沿用同一 generation 与原 deadline；不能用历史 stageAttempts 判当前请求的额度；taskless stages 同样受控。
- 默认延迟 1 秒；仅可读取/解析数值 Retry-After 为安全时长。超过 30 秒或剩余 stage deadline 时停止自动重试；等待可取消，stopping 不再 enqueue，不能截短后立即冲击限流。
- 连续失败停止当前 generation；仅 429/503 → 一次重试成功才恢复正常 pipeline。人工恢复是新请求，不能自动认为凭据已经修复；验证失败仍遵守 MAX_REPORT_REPAIRS=1 与重复 signature 拒绝。

### F08：终态时间来源与冻结

- 新增只读 TaskBundle.timing = { research, report }，每项为 { startedAt: string|null, endedAt: string|null, state: idle|running|ended|unknown }；timingOf 输入 Task、runs、该 task 的真实 research/report busy。
- ResearchAttempt 本来没有 endedAt；不虚构该字段、不迁移历史 DB。research.startedAt 取当前 attempt.startedAt；筛选此后自动 research/gap run，排除 userText 动作及第一次 report/synthesis 开始后的 run。
- 新 hasResearchWork 只匹配上述该 task 的 active/queue，不能使用 taskBundle 现有全局 busy；新 researchBusy 参数同步 session/task 两个 GET 调用与全部 stub。
- 研究仍执行/排队时 state=running；相关 run 全部正常完成或失败时 endedAt=max(真实 run.endedAt)，即便后续报告正在执行，研究耗时也已停止；后来的 Ask/Edit/报告恢复不能改变此边界。
- 首次报告开始即固定本次研究的候选 run 集合；retryResearch 创建新 attempt 才重置研究开始时间，已冻结预算/usage 语义不变。
- report.startedAt/endedAt 取本次 generation；只有真实 hasReportWork 且 endedAt=null 才 running；报告恢复使用新 generation 的起止，单独显示“报告耗时”。
- interrupted 的 boot endedAt 是检测时间，不能当真实执行终点；该计时投影 unknown。旧终态缺结束记录、非法时间或 end<start 也显示“—/无法确定”，不取 updatedAt/最近活动/打开页面时间替代。
- elapsed 仅 state=running 使用 Date.now；ended 只计算 end-start。终态 reload、poll、时钟前进都不增长；同一 report attempt 终态 endedAt 不再改写。

### F05：HTML 语义、打印及隔离重导出

- renderBlocks 接收已有 subjectNames / dimensionNames；表头每列 <th scope="col">。有 rowSubjects 时增加独立“对象”标题列及 <th scope="row">，每行原 N 格全部用 <td>，禁止把第一格正文挪作标题。
- 对象标签用冻结 frame 的精确 ID 映射；无声明的表不虚构对象，有部分空声明则明确“对象未声明”；维度说明用 dimensionNames，不改变 canonical 行列顺序/文本/claimIds。
- REPORT_CSS：matrix width/max-width:100%、table-layout:fixed；th/td white-space:normal、overflow-wrap:anywhere、min-width:0；取消 tbody th nowrap，保留可读字体。
- print 下 matrix/tbody/tr 允许分页，thead 重复为 table-header-group；移除整表 break-inside:avoid，允许过高行跨页。不能靠 overflow:hidden、删字、摘要替换或极小字号掩盖裁切。
- RENDERER 更新修复版本；FrozenRevision.renderer 类型改为兼容旧版本字符串的只读 identity。旧 revision.renderer/hash/createdAt 不动；HTML 区分冻结来源 renderer 与本次实际 renderer，ExportArtifact.rendererVersion 写实际 renderer。
- 从 W 的 SQLite backup 创建 ResearchService，使用 service.revisionsOf(taskId) 找该 report 的已有冻结 revision，记录其 id/hash；调用 exportRevisionPdf({service, revision, reportDir:W 下全新目录, browserPath})，不用 exportTaskReportPdf/freezeRevision。
- 新导出只写隔离库 exports 和新文件；模型/search/read/MinerU stub 一旦调用即 fail。导出前后比对原 DB 逻辑内容、原 PDF SHA、report payload 与 Frozen payload/hash 均不变。
- 新增离线 report-pdf-offline.test.ts（A 所属 tests）：调用真实 findPdfBrowser / exportHtmlToPdf 路径；使用已保存 frozen bundle fixture，不启用现有联网 render-pdf.test.ts。
- 从 frozen table 生成 18 项 manifest（row/column/subject/dimension/完整正文/引用）；pypdf strict 验证真实 PDF，并以 PDF 位置提取工具按列边界、跨页行段收集各格正文，仅规范化空白。
- 每一格需绑定实际 PDF 页码和位置、完整文字匹配及引用对应；重复“证据不足”必须分别核对坐标，不能用集合成员/前缀命中充当多个格通过。不得去除正文数字来伪造匹配。
- 用 Poppler 或 pypdfium2 渲染所有表格所在页，逐格检查身份/全文/引用、无横向裁切和页底缺失；保存 manifest、PDF、截图至 W。**18/18 全文+位置+视觉核对才关闭 F05，HTTP 200 不作内容判据。**

### F06 / F07：最终 Provider DTO

- Health = { status: not_checked|reachable|unreachable, checkedAt: string|null }；not_checked 必须 checkedAt=null；另两种必须来自对应对象的实际观察且带时间。
- retrieval.providers 为完整 settings.providerChoices Catalog，每项 { id, name, implemented, configured, enabled, orderIndex: number|null, health: Health }；order 为非空、去重的启用 ID 列表，orderIndex 为其中的 0-based 序号，禁用项为 null。
- capability 保留现有 { id,name,implemented,configured,status,detail,checkedAt? }，增加 { enabled:boolean|null, orderIndex:number|null, health:Health|null }；provider 项复用同一 Catalog DTO，非开关/排序能力对应 null，本地无需网络健康的能力 health=null。
- provider 目前没有健康探测记录，因此 health=not_checked；implemented/configured 或检索成功不能冒充健康探测通过。MinerU 保留现有显式检查结果及限额语义，不据 tools/list 推导 Token/额度可用。
- integrated 标签改为“已接入/已实现”；reachable 只表示已观察服务可达；主用/备用/未启用说明从有效 order/enabled 推导，网络失败后不能仍宣称“可用”。
- RetrievalForm 始终展示 Catalog；禁用删除 active ID，重新启用追加 ID，保留其它项顺序；选中/未选中 chip 如实变化。提交仍是 {providers: activeOrder, expectedRevision}，后端非空/revision 校验不降级。
- GET settings 不新增探测、模型调用或转换子进程；保存预算仍只影响新 Task，已建 Task/Retry/Frozen 预算保持原语义。

## 实施顺序

1. **G1 契约（F01/F02）**：先身份规范化/拒绝范围，再完整 Validator 与真实 save_report tool path 用例；运行 G1 Gate，绿色后继续。
2. **G2 执行与计时（F03/F04/F08）**：先 adapter 安全类型/分类及 DTO，再 runner 单一重试层/收尾/attempt guard/启动收敛，最后投影/API/按钮/计时；运行 G2 Gate。
3. **G3 交付（F05）**：先 renderer 语义/CSS/版本 provenance，再隔离 frozen export、实际 PDF 18 格核验；运行 G3 Gate。
4. **G4 Provider（F06/F07）**：先 routes/API 最终 DTO，再表单/能力文案，最后浏览器双向 round-trip 与有效检索顺序；运行 G4 Gate，再最终回归。

- runner/domain/presentation/API 的冲突在 G2 内顺序解决；G4 仅在 G2 完成后修改共享 routes/API。失败时修复本组再继续，不把跳过或 NOT VERIFIED 记为 PASS；各组无人工批准等待点。

## 测试与关闭标准

| Finding | 复用反例 / 必要新增测试 | 客观关闭判据 |
|---|---|---|
| F01 | E/probe.ts 的内存报告副本与 ranking 三例；扩展 report-ranking-lexicon、truth-boundary，全 validateReport 正负例 | 三例及新增独立排名都 Q08 FAIL/ok=false；诚实拒绝及真实原报告 PASS，Q09 不弱化 |
| F02 | E/probe 的 cross_version_subject；扩展 report-table-contract，用实际 tool.part=write | 错版本拒绝且 draft 未变；精确名称/ID、真实数组和两种合法宽度通过；无补齐/丢格 |
| F03 | E/browser-results restart-api / restart-browser-recovery；新增 report-recovery-restart.test.ts、离线 child helper | 真实子服务硬终止后以同一自有 DB 重启，GET 不 busy且 canResume=true；实际 Chrome 按钮启用、POST 202 后离线 fixture 正式保存 |
| F04 | E/model-probe / pipeline-probe 的错误和 4 次调用；新增 model-failures.test.ts，扩展 pi-ai-client / report-recovery-api | 可信 402/429/503/abort/unknown 分类与上表次数相符；SDK/Core 无隐藏重试，永久错误及耗尽 synthesis=0；秘密 canary 不出公开字段/日志 |
| F05 | E/artifact-results 的 18 cellChecks、html-table-geometry、pdf-page-5.png；新增 report-pdf-offline.test.ts | 新真实 PDF 18/18 全文、位置、身份、引用及所有表格页截图通过；原 report/Frozen/原 PDF 不变，真实外部调用=0 |
| F06 | E/browser-extra-results.onlyOneProvider；扩展 settings-api、product-settings；新增 settings-view.test.ts + Chrome round-trip | arXiv 关闭→保存→reload/restart→开关仍在→重新启用→保存→reload/restart 保持；再对 OpenAlex 做反向路径 |
| F07 | 同 E.onlyOneProvider.text；scripted discovery-resilience 顺序/失败及 capability DTO/UI 用例 | Catalog 总数不变，enabled/order/主备/health 在 API与UI一致；未检查不写可用，禁用项无真实检索调用 |
| F08 | E/browser-results.progress-summary；扩展 research-progress / research-progress-view，新增 timingOf 固定时钟用例 | 完成/失败后一小时数值不变；研究 10:00–10:02、报告 10:02–10:05、11:00 恢复不改变研究 2 分钟；旧/中断时间诚实 unknown |

- F03 新 child helper 调用真实 startResearchApp + scripted model，以现有 esbuild 按 build.mjs 的 Node ESM/banner 参数打包到 W，spawn 绑定临时端口；先等持久化 running，再终止且等 PID 退出，再重启，不启动真实凭据 main 分支。
- 分别覆盖 crash 在 begin/enqueue 与 runId 回填之间、report completed/draft_saved 到 synthesis 入队前、已有草稿、save 成功后回调前、启动收敛幂等、真实 active 不被收敛、shutdown 丢弃队列、runs.start 抛错；恢复资产/usage 不变。
- 新增“人工报告已排队时研究阶段结束”互斥用例和“显式重新研究后进入新报告 attempt”用例，确保上述自动/人工入口状态一致。
- 使用可中止的等待模型，不用不可结束的 async generator；测试退出必须 await close、只清理自己的子进程/浏览器 profile。重启后在点击恢复前模型调用必须为 0。
- report-recovery-api 的正式报告保护 G 用例改成真正通过 Validator 的 fixture；POST 必须 409/report_exists且零 enqueue/模型调用，禁止 incomplete fixture 失败后 fallback 202。
- F04 新 fake source 必须执行 options.fetch；另用本地 HTTP + 真实 SDK 验证 hook 与计数。原 errorScript 的 402 文本无可信数值，应测 unknown；补 429/503 持续失败、一次成功、等待取消、plain Error、含正文秘密的响应。
- 继续验证 failure ledger 的 session 隔离、since 时序、10 分钟过期与 200 项上限；新增 retry 元数据不能使旧失败归入新请求。
- F06 同时验证拒绝全关、stale expectedRevision 冲突且不写；scripted HTTP 断言仅启用 provider 被调用，fallback 顺序按 activeOrder，页面加载无健康网络请求。
- E 中旧探针会写回原 results：只能读取或复制并参数化为 W 输出；新增 fixtures/helper 放 tests，验收输出放 W，不能直接重跑会覆盖 E 的原脚本。
- G1 命令：`pnpm exec vitest run --no-file-parallelism packages/plugin-research/tests/report-ranking-lexicon.test.ts packages/plugin-research/tests/report-table-contract.test.ts packages/plugin-research/tests/truth-boundary.test.ts packages/plugin-research/tests/artifact-quality.test.ts packages/plugin-research/tests/edit-preflight.test.ts`。
- G2 命令：`pnpm exec vitest run --no-file-parallelism packages/model-pi-ai/tests/pi-ai-client.test.ts packages/model-pi-ai/tests/pi-ai-composition.test.ts apps/research/tests/model-failures.test.ts apps/research/tests/report-recovery-api.test.ts apps/research/tests/report-recovery-view.test.ts apps/research/tests/report-recovery-restart.test.ts apps/research/tests/research-progress.test.ts apps/research/tests/research-progress-view.test.ts`；新增 timing 用例并入 progress 文件。
- G3 命令：`pnpm exec vitest run --no-file-parallelism apps/research/tests/report-pdf-offline.test.ts apps/research/tests/artifact-view.test.ts packages/plugin-research/tests/editing-semantics.test.ts`；再运行该测试配套的实际 PDF 提取/渲染核验，依赖从现有 bundled Python / Poppler 获取。
- G4 命令：`pnpm exec vitest run --no-file-parallelism apps/research/tests/settings-api.test.ts apps/research/tests/settings-view.test.ts packages/plugin-research/tests/product-settings.test.ts packages/plugin-research/tests/discovery-resilience.test.ts`；附实际 Chrome 两方向恢复截图/DTO。
- 最终必跑 `pnpm typecheck`、`pnpm build:research`；离线全量串行一次（包含新增离线测试），覆盖 Report/Claim/Evidence、Proposal/Frozen、Intent、Document/MinerU，不为已经通过且未再改的部分反复加跑。

~~~powershell
pnpm exec vitest run --no-file-parallelism --exclude '**/real-provider.e2e.test.ts' --exclude '**/real-network.test.ts' --exclude '**/render-pdf.test.ts' --exclude '**/research-plugin.real.test.ts' --exclude '**/real-demo.e2e.test.ts'
~~~

- 清除真实网络 opt-in；只设置离线 fixture 所需的占位凭据，禁止导入生产 .env。最终 Chrome 回归 Intent 1100/1366/1440、Report/引用、Progress 默认/展开、Recovery、Settings；Document/MinerU 使用既有 fake MCP，不做真实解析/健康检查。

## 不允许变更的边界

- 不开发模型网页配置、MinerU Token 网页配置、通用 MCP 平台、新搜索引擎或 F01–F08 之外功能；不重写 Agent Core、Host、Protocol，不提高模型/研究资源上限。
- 不降低 Report Contract、证据定位、可比性和正式报告/Proposal 保护；不把 warning 隐藏为通过，不以改变 fixture 的事实/引用绕过失败。
- 不写用户历史 DB、E、原报告目录或已冻结 revision；不覆盖旧 PDF、不再次调用真实 DeepSeek/MinerU，不修改 node_modules、不升级依赖来代替本组修复。
- 本规划不修改业务代码、不 Commit、不 Push；DSFlash 的修复验收也不包含 Commit/Push/部署或无关产品路线工作。

## 最终 Definition of Done

- F01–F08 全部达到上述客观关闭判据，4 组 Gate、typecheck、build、最终离线回归均通过；真实 PDF 18/18 已逐格核验，真实服务重启和 Provider 双向启用均有浏览器证据。
- W 保存命令/计数/重启记录/DTO/18 格 manifest/PDF/截图；原证据、数据库逻辑内容、report/Frozen payload/hash 与原 PDF SHA 校验不变；外部付费模型/转换调用计数为 0。
- 自查所有新增接口与调用方一致；persisted/projection 状态无冲突；旧 JSON 兼容；新 tests/helper 实际存在且命令可运行，不能把缺依赖/跳过当验收通过。
- 无遗留运行/永久 busy、无失败后的自动 synthesis、无无限终态计时；所有测试自有进程正常清理。仅在这些条件满足后报告修复完成。
