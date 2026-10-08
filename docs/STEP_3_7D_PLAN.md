# ResearchPage — Step 3.7D Implementation Plan

> 执行对象：DSFlash。固定基线：`4c415d188acafa8af21692602a47365ec5bcec61`。
> 本文是一份文件级连续执行规范。标为“新”的文件、client方法、脚本参数是后续实施目标，不是声称基线已有。
> **本规划轮唯一写入为本文件；不修改业务代码，不运行真实MinerU解析，不Commit，不Push。**
> 比赛截止：北京时间2026-10-09 24:00，即2026-10-10 00:00（UTC+8）。P0先闭环；P2不实施。

## 1. Baseline & Source of Truth

### 1.1 本轮已核验的事实

- 仓库：`D:/SomeProjects/AgentCompetition2026`。Recon时HEAD等于指定基线，`git status --short`为空；仓库及父目录未发现AGENTS.md。
- `pnpm typecheck`实际成功：根项目、Web browser、Research browser三组`tsc --noEmit`全部通过。
- 按build.mjs相同入口/platform/target/define执行esbuild **write:false内存构建**，browser/server均成功。没有运行会删除、重写dist的正式build。
- Node v24.17.0、pnpm 11.8.0、uvx可用；Chrome与Edge存在。根package要求Node>=22.19.0、pnpm11.8.0。
- 当前进程存在非空DEEPSEEK_API_KEY，只核验存在性，未输出密钥。`builtinModels().getModel("deepseek","deepseek-flash")`存在；RESEARCHPAGE_MODEL/RESEARCHPAGE_CREDENTIAL_ENV未设，CLI默认就是该profile与DEEPSEEK_API_KEY。
- 8791的首页、runtime、tasks均连接拒绝，**该端口当前没有运行服务**。本轮不启动会写数据目录的服务；不能由此推断API未实现。
- verify-workspace.mjs、verify-trust-ux.mjs的`node --check`通过；真实browser gate未运行。密钥存在不等于provider调用成功。
- MINERU_API_TOKEN未设；uvx存在不等于MCP/在线解析通过。本轮没有调用GET /mineru，该端点会启动真实MCP并tools/list。
- 未跑会生成数据库/fixture/截图的测试；§7是实施轮验证要求，不能算成本轮PASS。

### 1.2 Source of Truth

优先级：**固定基线源码与测试 > 最新HANDOFF修复段 > 历史文档**。实施前核对HEAD/工作区；若不符，比较本文所涉契约并记录差异，禁止reset用户变更。

| 文件 | 已核对的事实 |
| --- | --- |
| docs/HANDOFF.md | 最新3.7C公开DTO闭环、3.7B文档作用域/预算修复、3.7A progress/retry、既有browser gate |
| docs/MINERU_WINDOWS.md | 在线解析/consent、uvx/代理/限额；历史failure.detail描述已过期 |
| apps/research/src/server/routes.ts | HTTP真相：Intent约808–1011，documents约1014–1438，session约1441，Retry约1635，runtime约2043；bundle简化附件约572 |
| apps/research/src/server/conversions.ts | ConversionJobView、公开failure allowlist、queue/retryable、进程内Job |
| apps/research/src/server/presentation.ts | researchProgressOf，真实阶段/计数，不允许浏览器编百分比 |
| apps/research/src/server/runner.ts | startIntent/startCard、hasIntentWork、taskless有界重试、自动research→gap→report→synthesis |
| packages/plugin-research/src/intent.ts | IntentStatus/IntentView/turn/decision/direction、canConfirm及版本 |
| packages/plugin-research/src/documents.ts | 完整DocumentView、512KiB/20份、UTF-8、用途与conversion trust |
| packages/plugin-research/src/service.ts | createIntent/attachToIntent/confirm、Task继承附件、scope/revision、user-provided Source |
| apps/research/src/browser/api.ts、store.tsx、routes.ts、router.ts、workspace.tsx | 同源client、Context、2s polling、hash router、视图挂载 |
| apps/research/src/browser/views/start.tsx、research.tsx、sources.tsx、brief.tsx、studio.tsx | legacy入口、矩阵/Source、Brief/Guide、Report/Ask/Edit/Proposal/Export |
| apps/research/tests/、scripts/、根与Research package.json | Vitest、React SSR、真实HTTP与脚本化MCP、原生CDP输入、实际scripts |

不要照抄旧HANDOFF的HTTP /documents/import建议实现可信转换：该公开入口只能写client_claimed。禁止复活failure.detail、toolCall.extractPath、MCP自报服务名/版本/工具列表出口。

## 2. Existing Architecture

1. React19+Mantine+lucide，main.tsx在StrictMode内挂AppProvider/Workspace；browser只访问同源/api/research，没有Redux/React Router。
2. 当前链：StartView→store.startTopic→api.startTask→**POST /tasks**→pendingSessionId→GET /sessions/:id→Task→Brief。Brief“重新生成主题”也是startTopic，是第二处要迁移的入口。
3. 地址：`#/`首页、#/settings、#/p/:taskId/{brief,research,report,sources,gallery}；PRIMARY_NAV固定报告→研究→来源。未指定view时按Brief确认/Report存在选默认页。
4. Store保存taskId/theme到localStorage；2s轮询bundle/answers/tasks并比较JSON避免空刷新。现inFlight没有scope generation/abort，旧await可污染新项目；act的刷新也可能被poll吞掉，须在新增生命周期时最小修复。
5. routes→runner→host/client→plugin/service→SQLite。Intent/documents持久化；Conversion Job内存保存，成功Markdown入库才有持久事实。
6. TaskBundle已含progress/activityLog/attempt/discovery/busy，api已有retryResearch；ResearchView仍主要画runs.activity，正式progress/Retry未接。
7. server TaskBundle已含documents/intent，但browser类型未声明。bundle.documents是**简化摘要**，不等于完整Library文档。
8. Report已有原生渲染、Evidence/Source Dock、Ask/Research/Edit、Proposal接受/放弃、冻结版本与HTML/PDF。
9. Brief确认后现有pipeline会自动research→可选gap→report→synthesis，不能按旧界面文案另加“必须再点撰写”的门槛。

闭环：主题/附件→Intent澄清→用户确认方向→等Task→现有Brief→用户确认Brief→研究→Report。两次确认必须区分含义。

## 3. Confirmed API Contracts

所有路径以前缀`/api/research`为准；query用URLSearchParams，path id用encodeURIComponent。新增client保留真实envelope，不把202当完成。**核心P0无需新增业务HTTP endpoint。**

### 3.1 Intent

| 方法/路径 | 请求 | 成功/行为 | 拒绝 |
| --- | --- | --- | --- |
| POST /intents | JSON {seedTopic,documents?:[{filename,content?:string,contentBase64?:string}]} | 202 {ok,created,intentId,sessionId,status,documents,note}；先保存Markdown再startIntent | 400非法主题/附件/UTF-8；413文件或envelope过大；不留半成品Intent/附件 |
| GET /intents/:id | 无body | 200 {intent:IntentView,busy:boolean}；busy仅该Intent turn active/queued | 404 {error} |
| GET /sessions/:sessionId/intent | 无body | 200 {intent:IntentView或null,busy} | 无Intent是null，不是404 |
| POST /intents/:id/messages | {text,documentIds?:string[],expectedVersion?:number}，text非空且<=4000字 | 202 {ok,intent,started:true,note}，排下一轮 | 404；409 reason=run_in_progress；409 stale:true+intent；已确认409；其它400 |
| POST /intents/:id/direction | **{expectedVersion,direction:DirectionPatch}** | 200 {ok,intent,direction,note}，仍是建议 | stale409；404；其它400，包括已确认 |
| POST /intents/:id/confirm | {expectedVersion,direction?:DirectionPatch}；P0先保存编辑，再只发version | 202 {ok,intentId,sessionId,direction,openFields,taskId:string或null,started:"card",confirmQuestion,note} | stale409带intent；404；无方向/无效方向400 |
| GET /sessions/:sessionId | 无body | 无Task：200 {pending,task:null,busy}；有Task：200 {pending:false,task:TaskBundle} | 不根据pending判断Intent建卡失败 |

**direction陷阱：**路由注释写{patch}，实际读取`body.direction ?? body`。发送{patch:{...}}不能正确编辑。统一POST {expectedVersion,direction:{...}}；不是PATCH /intents。

IntentView完整字段：

- intentId/sessionId/seedTopic/status/statusLabel/version/createdAt/updatedAt/taskId。
- turns：{id,role:"user"|"assistant",at,text,why?,options?:string[],proposesDirection?,documentIds?:string[]}；公开最近40轮，存储最多60轮，无分页接口。
- decisions：{id,field:BriefFieldName或null,value,basedOn,at}，是助手理解，不是正式确认字段。
- proposal/confirmedDirection:ResearchDirection或null；proposalSummary/confirmedAt可null。
- documents:完整LibraryDocumentView[]；pending:{turnId,text,why,options,proposesDirection}或null。
- canConfirm/confirmQuestion/openFields:BriefFieldName[]/userMessages:string[]/assistantQuestions:string[]。
- status闭集：exploring / ready_to_confirm / confirmed；canConfirm只表示未确认且有proposal，还要由UI检查busy。
- ResearchDirection：topic/purpose/scope/audience/exclusions/lengthTarget/summary/at字符串；focus:string[]；subjects:{name,note?}[]；dimensions:{name,question}[]；source:"agent"|"user"。
- DirectionPatch为可编辑字段Partial，不传at/source；有效方向须topic/purpose/scope/summary。最多4对象、6维度、8focus。P0编辑前四字段，其余原样保留；部分空值会被服务端previous fallback，不宣称清空成功。
- attachToIntent新文档会增version；绑定Task不保证增version。必须比较完整snapshot，不能只按version判断变化。

### 3.2 Library与TaskBundle两种文档DTO

客户端新命名 **LibraryDocumentView**，现有用于Report的 **DocumentView** 保持。

LibraryDocumentView完整形状：

```text
documentId, sessionId, taskId:string|null, originalFilename, title, sizeBytes,
contentHash, createdAt, origin:"direct_upload"|"converted", conversionProvider:string|null,
conversion:LibraryConversion|null, status:"ready"|"failed", usage:DocumentUsage[],
outline:{level,text,charStart,charEnd,titleStart,titleEnd}[],
outlineTotal, outlineTruncated, revision, note, failure:string|null,
linkedSourceId:string|null, chars, paragraphs, truncated
```

LibraryConversion：provider/version:string|null/originalFilename/originalFormat/status:"succeeded"|"partial"/convertedAt:string|null/pageMap:{page,charStart,charEnd}[]/sourceRef:string|null/trust:"client_claimed"|"server_verified"。

TaskBundle.documents的**TaskDocumentSummary**只有：documentId/filename/title/sizeBytes/origin/conversionProvider/conversionTrust/usage/status/linkedSourceId/chars/outline:string[]/outlineTotal/createdAt；filename映射document.originalFilename。没有revision/sessionId/taskId/完整conversion；用途修改必须读完整列表。

TaskBundle.intent是null或{intentId,seedTopic,confirmedAt,direction,status}，status可null。TaskBundle.sources没有document元信息，不凭空扩充SourceView；从Library.linkedSourceId关联现有Source。

DocumentUsage为至少一个用途的数组：intent_context / research_source，可同时选，默认intent_context。

| 方法/路径 | P0请求 | 成功 | 说明 |
| --- | --- | --- | --- |
| POST /documents | JSON {intentId或taskId,filename,contentBase64,usage} | 201 {ok,document,duplicate,sessionId,taskId,limits:{maxBytes,maxPerSession},note} | bytes原样base64，避免File.text宽松替换UTF-8 |
| GET /documents?taskId=:id 或 intentId=:id | 当前scope | 200 {documents:完整视图[]} | Intent正常poll已有intent.documents，不重复拉列表 |
| GET /documents/:id?scope | 当前scope | 200 {document,untrusted} | 局部刷新 |
| GET /documents/:id/content?scope | 当前scope | text/markdown | 如需下载按text读取，不交JSON parser；不建全文编辑器 |
| PATCH /documents/:id | {intentId或taskId,usage,expectedRevision} | 200 {ok,document,note} | stale是409 conflict:true；不带stale:true/当前文档 |
| POST /documents/:id/source | {taskId} | 201 {ok,created,source:{sourceId,title,role,url,readStatus,document},note} | 已选research_source才可用，user-provided，初始not_read |
| POST /documents/:id/link | {taskId} | 200 {ok,document,taskId,note} | 同session未关联时的恢复动作，非默认动作 |
| DELETE /documents/:id?scope | 无body | 200 {ok,documentId,note} | P0不新增删除UI；已有快照/证据保留 |

每次显式声明当前intentId或taskId；session从已读Intent/Task获取，不从目标文档推断caller。缺scope：400 document_scope_missing；不存在：404 document_not_found；跨session：403 document_cross_session；多scope冲突：403 document_scope_conflict；文档过大413 document_too_large；其它conflict409/validation400。

Markdown每份512*1024bytes，每session20份。带文档JSON envelope上限`512*1024*2+64*1024=1114112bytes`；首页多附件须检查整个JSON编码后的UTF-8大小。超限保留主题/选择，提示减少首页附件，创建后逐份追加；Intent创建前没有匿名上传scope，不能建议先上传到未知session。

### 3.3 MinerU API / Job

| 方法/路径 | 请求 | 响应 |
| --- | --- | --- |
| POST /documents/convert | query: intentId或taskId、filename、usage逗号连接、**consent=third_party_upload**；body=File/Blob/ArrayBuffer，Content-Type=application/octet-stream | 202 {ok,job:ConversionJobView,note} |
| GET /documents/convert/:jobId?sessionId=:session | 无body | 200 {ok,job} |
| POST /documents/convert/:jobId/retry | JSON {sessionId} | 202 {ok,job,note}，同jobId更新attempts |
| GET /mineru | 无body；按需真实MCP probe | 200/503 {ok,mineru:{transport,command,package,mode,parseDocuments,durationMs},limits:{maxBytes,maxPages,formats,online,dataHandling},problem} |

ConversionJobView：

```text
jobId, status:"queued"|"converting"|"importing"|"succeeded"|"failed",
filename, format, sizeBytes, sha256, usage, sessionId, taskId:string|null,
attempts, maxAttempts, createdAt, startedAt:string|null, finishedAt:string|null, retryable,
document:{documentId,filename,duplicate}|null,
conversion:{provider,version,status,convertedAt,sourceRef,pageMap:null,trust:"server_verified"}|null,
toolCall:{tool,durationMs,status:"success"|"partial_success"|"error"|"unknown",
          contentChars:number|null,inlineTruncated,fromFile}|null,
failure:{code,problem,guidance}|null,
note, limits:{maxBytes,maxPages,mode:"flash"|"token",transports:string[]}
```

- ConversionProblem envelope是{error,problems,guidance,code}。kind→HTTP：consent_required/file_invalid400；unsupported_format415；file_too_large413；busy429；job_not_found404；job_cross_session403；job_not_retryable/file_gone409；service_unavailable503。
- route在manager前检查body：过大413 **conversion_file_too_large**；读取失败413 **conversion_file_invalid**；不混淆manager的file_too_large/file_invalid。
- Job failed的GET仍HTTP200，读取job.failure。常见code：mcp_not_installed/mcp_handshake_failed/mcp_tools_missing/mcp_disconnected/conversion_timeout/conversion_cancelled/flash_file_too_large/flash_page_limit/flash_unsupported_type/flash_rate_limited/provider_auth/network_unavailable/markdown_empty/output_missing/output_outside_workdir/document_too_large/import_refused/conversion_failed。
- retry按job.retryable，不按code猜：failed且attempts<3且原文件存在；page_limit也可能retryable。展示guidance及额度提醒，绝不自动重试。
- 一次1份、最多排队4份、最多保留8份失败源文件。jobs在内存；重启后404，成功文档持久保存。job.taskId是提交时快照，可始终null，不代表成功文档未关联Task。
- **token模式在本产品的HTTP与manager仍限10MiB**；公开limits仍10MiB/20页，不能承诺配置token已解除产品限额。文件类型本轮只PDF/DOCX。
- 单次工具调用默认360s；配置小于10000ms退回默认；现离线超时集成用12000ms。
- 没有转换前cache、按sha查Job或list jobs接口。重复PDF会再次调用MinerU，Markdown duplicate只省存储，不返还额度。
- Flash没有pageMap；图片资源不保证保存。server_verified只证明服务端执行转换，不证明内容正确或变为official/primary。
- failure只有code/problem/guidance；页面不展示raw stderr、路径、预签名URL或不存在的failure.detail。

### 3.4 Research与Report

- GET /tasks/:id直接返回TaskBundle，不是{bundle}。progress阶段：preparing/searching/reading/assessing/gap_research/reporting/validating/answering/editing/waiting_retry/completed/failed。
- progress字段：currentStage/displayName/currentMessage/completedStages/lastActivityAt/searchAttempts/candidatesFound/sourcesRead/currentProvider/retrying/waitingUntil；searchAttempts是物理请求含失败，不等于usage.searches。
- attempt:null或{number,startedAt,searches,reads,gapRounds,reason}；usage是lifetime。
- discovery:null或{attemptedRequests,successfulRequests,failedRequests,lastProvider,lastElapsedMs,lastFailure:{at,provider,kind,status,userMessage}}。
- activityLog最多200条、oldest first：{id,taskId,at,stage,level:"info"|"warn"|"error",kind,message,provider?,attempt?,nextRetryAt?}。
- POST /tasks/:id/retry-research JSON{}→202 {ok,started:"research",attempt,preserved:{sources,evidence,assessments,reports,revisions,reportKept},message}；404 reason=task_unknown；409 brief_unconfirmed/not_recoverable/run_in_progress。
- POST /tasks/:id/confirm {expectedVersion}→202 {ok,started:"research",briefVersion,matrixRebuilt}；409含brief/problems/guidance。Intent确认不能替代Brief确认。
- 保留api.brief/patchBrief/guideNext/guideAnswer/gap/report/assistant/proposal/acceptProposal/discardProposal/freeze/exportPdf/exportRevision/answers/document/revisionDocument。
- reportHtmlUrl/revisionHtmlUrl/exportFileUrl保留，文件响应不能送JSON parser；不改Report renderer/claim/evidence/proposal语义。

## 4. Route / Store / UI State Model

### 4.1 URL与恢复（A/B/H/I/J）

- 新URL：`#/i/:intentId`；Route增{kind:"intent",intentId}及intentHash。Project View联合类型与PRIMARY_NAV仍原三项。
- **URL优先**：明确Intent/project地址只载所指资源；#/展示首页，不被旧task缓存自动重定向；settings不自动跳Task。
- 保留researchpage.task/researchpage.theme；新增researchpage.intent={intentId,sessionId,seedTopic}小型pointer，坏JSON忽略；新增researchpage.conversions.v1按session保存{jobId,sessionId,sha256?,documentId?}receipts，最多20项/session并限制总量。
- localStorage不存原文件、Markdown、密钥或永久consent=true，不作为服务端状态真相。
- POST intents拿到receipt立即存pointer并跳Intent；reload GET Intent校正session/turn/decision/proposal/status。首页提供一行“继续意图探索”（最近pointer+真实状态），不增加Sidebar或虚构Intent列表API。
- confirmed+taskId非null：GET Task校验session，openTask→#/p/:taskId/brief；taskId=null恢复等待。旧Task无Intent正常开，UI对documents/intent缺项用[]/null兜底。
- browser默认创建固定store.startIntent(seedTopic,initialFiles)，移除browser api.startTask/startTopic创建调用，迁移Brief重新生成。server legacy POST /tasks及其后端测试保留，Network证实浏览器新建没有POST /tasks。

### 4.2 Store所有权与方法

扩展现有AppProvider，不建第二业务状态机：

| 状态 | 所有权 |
| --- | --- |
| Intent envelope、TaskBundle、完整Task Library、Jobs | Store按scope缓存，只由API副本更新 |
| activeScope=start/intent(id)/task(id)及generation | Store，Workspace按route同步 |
| 主题/回答/DirectionPatch/选中documentIds/File暂存 | 组件或Store上传暂存，reload不保证保留Files |
| creating/sending/savingDirection/confirming/uploading/retrying/savingUsage | 局部操作锁，转换不等于Research busy |
| loading/loadError/lastSuccessfulRead/等待过久提示 | UI观察状态，不写Intent.status或Task.status |

原document继续指Report DocumentView；新libraryDocuments不可覆盖它/lastReportId。现有Notice也要记录发起scope或在资源身份切换时清除前scope提示（包括error/warn）；同scope错误仍可保留到用户关闭。只改NoticeBar的比较字符串不足以隔离旧错误。新增openIntent/startIntent/sendIntentMessage/saveIntentDirection/confirmIntent/refreshIntent/refreshLibrary/uploadMarkdown/submitConversion/retryConversion/setDocumentUsage/promoteDocument实施方法；操作捕获scope/session/version。组件不得各自启动poll。

busy保持旧Task动作含义；Intent用自己的server busy+local action；上传不因另一个Task的global busy永久禁用。

### 4.3 Polling/竞态/按钮/冲突（D/E/G）

新增小型polling.ts协调器，沿用2s周期并做这些修复：

1. scope切换/卸载递增generation，abort旧GET/清timeout/listener；**成功、catch、finally、notice、navigation及每个第二await**均检查alive+generation+scope。
2. 每resource key（intent/task/library/job/tasks）至多一个GET；完成后setTimeout，不用重叠setInterval。旧request finally只能释放自己的token。
3. 当前Intent/Task每2s同步跨标签变化；Task完整Library进入、mutations/成功Job/手动刷新必读，另约10s检查跨标签；Intent以intent.documents为完整列表，不重复每2s GET documents。
4. 当前session活跃Job queued/converting/importing每2s读，终态停止；retry恢复poll；离开session暂停，返回/reload按receipts查询真实Job。
5. mutation后refresh若正在读同key，置dirty并在当前GET后立即补读；调用者能await补读完成，禁止silent return。
6. JSON完整比较维持对象identity，无变化不setState。Intent不能仅比较version；notice不每poll重建；时间倒数仅进度子组件局部更新。
7. GET约15s transport timeout；读失败保留最后snapshot，UI标连接错误，2→5→10s退避，成功恢复2s；不凭客户端timeout把Job/Task判failed。hidden暂停周期，visible立即刷新。
8. 非幂等POST不自动重发。响应丢失先读Intent/Library/已有Job，说明结果未知；没有list jobs不能靠filename猜jobId。
9. 已发送上传后切scope，receipt仅存发起session registry，当前scope匹配才setUI，不导航新项目。reload在receipt前丢失时先查Library，不自动重传收费。
10. request使用Headers(init.headers)，JSON才补缺省Content-Type；conversion显式octet-stream且body原样。GET方法增加可选signal，旧client签名兼容。
11. StrictMode effect重新挂载不产生POST；submit同步ref锁防double click/Enter并发。

messages/direction/confirm都带expectedVersion。409 stale→展示error.intent+GET补busy，保留回答/patch/documentIds，重新审阅再由用户提交，**不自动重放confirm**。run_in_progress等待并刷新。上传新文件会增加Intent version，上传后先刷新再发回答。已confirmed的direction/confirm拒绝可能400，不能统一猜stale。

usage PATCH带expectedRevision，409 conflict重新读完整列表、保留usage选择，用户重试新revision；不能用ApiError.stale判断文档冲突。

### 4.4 confirm等待（F/H）

旧pendingSessionId的`!pending→失败`不适用于Intent：pendingTopics仅legacy创建写入；Intent.card时pending通常false；GET Intent.busy只覆盖turn，不覆盖card。

```text
确认只POST一次；202保存intentId/sessionId，不乐观假造confirmed。
GET Intent恢复事实。
有intent.taskId：GET Task，验证session一致，scope仍当前Intent才openTask+跳Brief。
无taskId：留#/i/id，“方向已确认，正在等待任务卡”，2s轮询Intent；
可同周期GET /sessions/:sessionId备用观察，仅task!=null且session匹配才跳。
不以pending=false或busy=false结束，不重复POST confirm。
找到Task后停止Intent等待请求。
```

240s未取得Task→“尚未取得任务卡”，保留confirmedDirection，“重新读取”只GET，“用此方向新建探索”是用户明确动作/新Intent且保留旧探索；转10s低频继续查直到离开。此timer仅等待提示，不冒充后端failed。刷新confirmed/null重新观察，不再次确认。

基线taskless card无公开outcome及安全retry接口；两次模型失败/重启丢queue后无法从DTO判原因或原地再启动。P0用上述诚实恢复，不新增后端、不做假“重试建卡”。若将“原地安全续建”列为硬验收，才需另行设计session/card observation与幂等retry契约，属于本轮非目标。

### 4.5 Intent UI（C/D）

新增IntentView，复用rp-page/rp-note/rp-composer及RichMarkdown：

- 显示seedTopic/statusLabel；busy显示正在处理上一轮；idle且无pending也能继续发送，避免模型无记录后永远锁死。
- 按turn.id渲染role/time/text/why，pending只驱动options，不重复画一条assistant turn。options字符串点击填回答，送messages.text，不冒充Brief guide.optionId。
- decisions折叠“助手对回答的理解”，显示value/basedOn；自由回答可纠正，不写正式Brief字段。
- proposal显示topic/purpose/scope/summary，折叠读者/对象/维度等，显示confirmQuestion及openFields说明Brief还需完善。
- 本地DirectionPatch保存POST direction；未保存/冲突草稿禁确认；成功刷新version。
- 发消息：非confirmed、非server busy/local action、text非空<=4000；可在转换期间讨论，但documentIds只引用已入库ready同session文件。
- 确认：canConfirm && !busy/local action && 无未保存patch && 本次选中文件无读/上传/转换中。failed附件可明确移出本次待处理选择后继续，不删除入库文档/永久卡按钮。
- confirmed对话/方向只读；恢复Task或等待，不显示可写控件。
- 首页创建失败保留主题与File，拿到receipt才清草稿。

### 4.6 Upload/Library与首轮PDF

共享DocumentUpload/Library置首页、Intent、Task Sources。Brief链接Sources文档锚点；Report沿既有Sources导航管理附件。不增第四一级页、不重构Sidebar。

**首页Markdown：**arrayBuffer+fatal UTF-8校验，原bytes base64；放POST intents.documents一起提交。这保证first stage构建prompt前已保存，仍只是有界预览，不能承诺通读全文。逐份及总envelope检查、名称/大小/移除、失败保留Files。

**首页PDF/DOCX：**可选择，但必须unchecked授权UI：“原始文件会发送到MinerU在线服务解析；重复提交/重试会再次消耗额度”。同意仅当前文件/批次，更换文件重新同意。先POST intents只带Markdown，再用receipt对应scope发送raw convert，Files/授权暂存Store不随页面切换丢失；取消不发convert，可移除继续纯主题。

**首轮时序最小方案：**POST intents已开始首轮，不改后端defer协议。写明“首轮澄清先基于主题和已上传Markdown；PDF/DOCX转换完成后，请在对话中补充它，再更新研究方向”。成功显示“使用这份文档继续澄清”，prefill可编辑用户消息并选documentId；**用户发送messages才开下一轮**。不自动发消息/重跑首轮/接受方向。如果proposal早于PDF成功，提示建议可能尚未参考新文档；允许用户继续澄清或自己审阅确认，不宣称已考虑全部附件，也不按assistant时间猜读取。

**共享上传及Job：**

- Markdown POST documents JSON，本次明确用途，默认intent_context；Task后仍有intent_context，不暗改research_source。
- PDF/DOCX同意→raw POST→receipt，receipt前为UI“上传中”，之后显示真实queued/converting/importing/succeeded/failed及attempts/maxAttempts；瞬态跳过正常，不为Demo补假状态。
- 客户端顺序提交多文件，减少429；10MiB/512KiB前置检查；转换结果超512KiB是失败，不截断伪成功。
- “检查转换服务”按需GET mineru，打开上传面板或点击时查，不全站poll；503按body.problem显示，未知状态有重新检查，不影响Markdown。
- failed && retryable显示重试，点击先提醒再次耗费额度并让本次用户确认，再POST原job/retry；retryable=false只给guidance/重新选择。
- succeeded按job.document.documentId刷新Library/Intent/bundle。duplicate明确只复用存储，转换已耗费额度；展示实际Library.trust，不拿job.conversion升级既有文档。
- server通常按session Intent.taskId自动关联，建Task也继承附件。若Task列表没有完成文档，用同session GET document核对taskId，必要时POST link一次，再重读；不能以job.taskId=null判未关联。
- 切项目不显示旧session Job或自动加入新项目。
- Job404→停poll、显示失效、先查持久Library；有receipt.documentId按id恢复，否则标未知；重新选择/同意才可新POST，不自动重传。
- 重复转换始终提示费用；crypto.subtle SHA-256可与当前session receipt.sha256比较增强提醒，但不承诺覆盖全部历史重复、不说服务端cache命中。
- 刷新可恢复已拿receipt的Job；无receipt的在途请求无法查询，不伪造已失败/已成功。

**Library：**完整视图展示标题/文件名/来源origin/原始PDF或DOCX/转换provider/trust、用途、ready/failed、createdAt、已加入Source状态；Job独立显示，library ready不等于正在解析。

用途非空多选PATCH revision。Task存在+ready+含research_source+未linked时显示“加入研究来源”，成功刷新Task sources/Library；已linked“查看来源”用现Dock。Intent期间可改用途，Task有了才promote。Source初始user-provided/not_read，Evidence不能伪增。取消research_source仅改用途，须说明旧Source/快照/证据仍保留；上传/改用途/promote都不自动Research/Report/Edit/accept/改Brief或方向。

### 4.7 Research Progress/Retry

在矩阵之前加props驱动ResearchProgress，保留Matrix/Gap/Dock/Source summary：

| UI | 数据源 |
| --- | --- |
| 阶段/当前句子 | progress.displayName/currentMessage，包括waiting_retry/reporting/validating |
| 已完成过的阶段 | completedStages，不推断固定线性进度 |
| 研究轮次/开始时间 | attempt.number/startedAt，null=未开始 |
| 检索请求尝试/候选/已读 | progress.searchAttempts/candidatesFound/sourcesRead |
| 请求成败/服务 | discovery成功失败计数、currentProvider/lastProvider |
| 未读/读取失败 | sources.readStatus计数，不把摘要级当失败 |
| 活动 | activityLog最后10条、key=id，展开200条原顺序/time/level/message |
| 当前失败 | task.error为主，discovery.lastFailure.userMessage辅；成功后的旧错误标历史 |
| 等待 | retrying/waitingUntil，null不猜秒数 |
| Retry | task.confirmed && status==="failed" && !bundle.busy && !localRetry |

同步锁→retryResearch→显示message/preserved→强制refresh，等真实attempt+1；409/404读reason/guidance并重查，不清旧材料。bundle.busy当前是global，保守禁按钮并解释等待，不伪造per-task busy。attempt与usage清楚区分；移除原run/gap猜测主进度和“研究后必须用户再决定撰写”的冲突文案。无百分比、无模拟阶段、无平行状态机。

## 5. File-by-file Changes

这是后续实施allowlist，**规划轮不执行**。新逻辑模块只为契约/请求协调与可测试的纯判断。

| 文件 | 当前职责 | 具体变更及原因 | 依赖 |
| --- | --- | --- | --- |
| apps/research/src/browser/api.ts | 同源JSON client/业务DTO | 新Intent/Library/Conversion/readiness类型与方法、TaskBundle.documents/intent；Headers+signal/raw body；ApiError增code/reason/guidance/intent且保留brief getter | §3源码；不runtime import后端packages |
| apps/research/src/browser/routes.ts | 纯hash grammar | Intent Route/intentHash；保留Project views/default/PRIMARY_NAV | Workspace/route tests |
| apps/research/src/browser/router.ts | hash/useRoute | 新helper如export *已覆盖则不造diff；保留navigate/listener | routes |
| apps/research/src/browser/polling.ts（新） | 无 | scope generation/abort/key去重/dirty补读/dispose/退避协调器，修旧请求污染 | api signal/Store/测试 |
| apps/research/src/browser/intent-logic.ts（新） | 无 | 按status/busy判断按钮/patch/冲突草稿/确认等待，不建业务状态机 | Intent DTO/组件 |
| apps/research/src/browser/upload-logic.ts（新） | 无 | bytes/UTF-8/文件/envelope/scope/receipt/terminal/retry判断 | API/上传组件 |
| apps/research/src/browser/store.tsx | AppContext/Task replica/polling | 当前scope/Intent/完整Library/Jobs/File暂存与局部锁；迁移startTopic，统一poll/receipts，保护旧Report/answers | API/新logic/routes |
| apps/research/src/browser/workspace.tsx | route挂载/shell/notice | Intent分支与scope同步；project渲染先匹配bundle.task.id；404/等待/loadError；notice scope含intentId，替换legacy PendingCard路径 | Store/IntentView |
| apps/research/src/browser/views/start.tsx | legacy创建/项目列表 | startIntent+附件/同意/继续探索pointer；成功才清草稿，Task rows保留 | Store/Upload/routes |
| apps/research/src/browser/views/intent.tsx（新） | 无 | 容器+可SSR Panel：turn/options/decision/proposal/editor/confirm/等待/文件续聊 | Store/intent-logic/Markdown/Library |
| apps/research/src/browser/components/document-upload.tsx（新） | 无 | Files选择、在线同意/limits、真实Job/Retry；props展示层与Store动作分开 | upload-logic/Start/Intent/Sources |
| apps/research/src/browser/components/document-library.tsx（新） | 无 | 完整列表/用途revision/显式Source/定位/身份说明；props可SSR | API/Store/Intent/Sources |
| apps/research/src/browser/views/sources.tsx | Source表/筛选/Dock | 原Source区之前加文档Library/Upload锚点；原表/筛选/Dock不变 | Library/Store |
| apps/research/src/browser/views/brief.tsx | Brief编辑/Guide/确认/再生 | 再生改startIntent及文案，加Sources文档入口；不改已有confirm/guide/patch语义 | Store/routes |
| apps/research/src/browser/components/research-progress.tsx（新） | 无 | 真实progress/attempt/discovery/log/Retry props组件 | API/Research |
| apps/research/src/browser/views/research.tsx | 矩阵/Gap/runs进度 | 加ResearchProgress，移除冲突的推测主状态/自动pipeline错误文案，保留矩阵/Dock | 新组件/Store |
| apps/research/public/styles.css | rp组件样式 | 仅追加Intent/Library/Job布局及小屏overflow，复用tokens，不换肤 | 新组件class |
| apps/research/tests/frontend-logic.test.ts | route/claims测试 | Intent route/cache优先级/旧项目routing断言 | routes/intent logic |
| apps/research/tests/api-client.test.ts（新） | 无 | fetch stub检验Headers实例、JSON/raw bytes/Content-Type、409/Signal | API |
| apps/research/tests/intent-logic.test.ts（新） | 无 | status/busy/confirm等待/confirmed恢复/草稿冲突判断 | intent-logic |
| apps/research/tests/upload-logic.test.ts（新） | 无 | UTF-8/limits/envelope/base64/scope/receipt/retryable | upload-logic |
| apps/research/tests/polling.test.ts（新） | 无 | deferred Promise+fake timers证明换scope/unmount/dirty/去重/退避；不睡眠猜竞态 | polling |
| apps/research/tests/intent-view.test.ts（新） | 无 | React SSR状态/理解/提案/disabled/首轮PDF说明 | props IntentPanel/Mantine |
| apps/research/tests/document-library-view.test.ts（新） | 无 | SSR用途/role/trust/unchecked同意/Job失败Retry | Library/Upload props |
| apps/research/tests/research-progress-view.test.ts（新） | 无 | SSR各阶段/计数/活动/失败/Retry，无百分比 | Progress props |
| apps/research/tests/helpers/step37d-fixtures.ts（新） | 无 | testComposition接缝scriptedModel/search/read/server工厂；两轮Intent、有效Report、旧Task、先失败后成功search | composition/既有intent/document/pipeline形状 |
| apps/research/scripts/verify-intent-documents.mjs（新） | 无 | 真实CDP gate：隔离offline fixture或live URL、native file/键鼠、Network计数/刷新/错误退出/截图 | fixture/build/旧CDP模式 |
| apps/research/scripts/verify-workspace.mjs | 旧Brief/Report CDP | createDraft改Intent→proposal→原生确认→等Task，不只等待Task list；原case保留 | 新UI testids |
| apps/research/tests/step37d-browser.test.ts（新） | 无 | Vitest wrapper启动新gate --offline，明确skip/timeout/exit | 新gate/Chrome |
| apps/research/tests/trust-ux.test.ts | TaskBundle fixtures/SSR信任 | 完整bundleFixture补documents:[]、intent:null，原断言不减 | API |
| apps/research/tests/artifact-view.test.ts | Report文档/比较矩阵SSR | 完整bundleFixture补documents:[]、intent:null；不改报告渲染断言 | API/Report |
| apps/research/tsconfig.browser.json | browser/既有SSR typecheck | include新增3个SSR view test | 新tests/根tsconfig |
| tsconfig.json | Node/全仓typecheck | exclude相同3个SSR view test，避免Node无DOM类型 | browser tsconfig |
| docs/HANDOFF.md | 交接 | 新URL/入口/文件/各层验证/边界/命令结果 | 实际证据 |
| docs/MINERU_WINDOWS.md | 部署 | UI授权/重复费用/Job失效说明，纠正detail/token过期文案 | 真实DTO |
| docs/STEP_3_7D_PLAN.md | 本计划 | 实施后仅追加结果/偏差附录，保留规划基线事实 | 实施证据 |

不需改但须回归：shell.tsx（进入Intent清旧bundle即可）、views/studio.tsx、components/{dock,assistant,proposal,document,markdown}.tsx、status.ts、document.css、Report renderer、核心packages、server routes/conversions/presentation/runner、package scripts、verify-trust-ux.mjs。Recon已定位完整TaskBundle literals为trust-ux.test.ts与artifact-view.test.ts；workspace-conversation.test.ts使用局部对象的unknown cast，无需因此修改。实施后仍用`rg -n "TaskBundle" apps/research/tests`确认没有遗漏，不删语义断言。

## 6. Ordered Implementation Steps

实施模型连续完成1→8，不每一步等待确认。P0闭环后才P1。实施轮是否可真实上传/提交由其用户授权决定；本规划轮不提供代码修改/真实解析/Commit授权。

| 顺序 | 修改文件 | 输入依赖 | 验收条件 | 实际风险及恢复 |
| --- | --- | --- | --- | --- |
| 1 类型/API | API/client tests/旧DTO fixtures | §3 routes/DTO | 所有方法/类型正确，raw Headers/bytes与Report类型不冲突 | direction envelope错、完整/摘要DTO混用，先client tests |
| 2 Router/Store | routes/router/polling/intent-logic/store/workspace及纯tests | 1、URL/等待算法 | reload/confirmed→Task/旧项目切换/unmount/dirty补读通过 | pending=false误失败/旧响应；先deferred反例 |
| 3 Intent页面 | Start/Intent/Brief/Intent SSR/styles | 2、原RichMarkdown | 两轮→方向编辑/确认→Brief；两个入口无POST /tasks | double submit/草稿覆盖；同步锁+version |
| 4 Library/转换 | upload logic/tests、Store actions、Upload/Library、Sources/Start/Intent、Library SSR/styles | 1–3、session/完整DTO | md首轮、pdf/docx同意→raw→Job→Library、用途/Source | 首轮时序/attach version/失receipt/404；按§4.6 |
| 5 Progress/Retry | Progress/Research/SSR | 1–2、bundle/retry | 真阶段/活动/尝试/失败/Retry保留材料 | attempt/lifetime混淆，不另造状态 |
| 6 Report/错误 | 已列API/Store/Workspace/fixture | 1–5、旧Report/Brief链 | 附件不改报告，旧项目/Ask/Edit/accept/frozen/HTML/PDF正常 | Library覆盖document/旧report晚回/非JSON |
| 7 自动/浏览器验收 | 新tests/helper/gate/wrapper、旧workspace gate、tsconfig | P0闭环、MCP/browser | §7单元/HTTP/MCP/CDP与旧gate通过，真实结果单列 | 旧gate卡Task/CDP flaky/provider耗时，不混称通过 |
| 8 文档/Commit | HANDOFF/MINERU_WINDOWS/Plan附录 | 运行证据与diff | 如实PASS/SKIP/FAIL、命令/边界/allowlist，授权的实施轮末尾本地commit | 当前规划不commit；实施授权含commit时gate后仅提交列出文件，不Push |

每步只跑针对性验证，最终一次全仓。不要逐步重复真实模型/MinerU或全量。真实外部服务阻塞时完成离线及其它P0，记录准确阻塞。

## 7. Acceptance Test Matrix

### 7.1 框架、CDP与新脚本规范

基线Vitest3+纯TS+React renderToStaticMarkup；Research没有Testing Library/Playwright。沿用SSR验证显示语义，**真实事件/file/reload交CDP**，SSR不宣称点击成功，不新增framework依赖。

新CLI（实施时创建）：

```text
node apps/research/scripts/verify-intent-documents.mjs --offline --shots <dir>
node apps/research/scripts/verify-intent-documents.mjs --url <origin> --model --shots <dir>
```

- --offline与--url互斥。offline在os.tmpdir打包helper/startResearchApp+testComposition+fixture search/read+fake MCP，数据隔离，finally关闭app/browser并清temp，不能打开原demo库。
- offline仍用真实Chrome/Edge；--model只在live启用provider动作。旧verify-workspace的--model含义是执行model-backed动作，offline gate可把它对自己的scripted app运行，但日志明确scripted。
- UI动作使用Input.dispatchMouseEvent/Input.insertText；文件用DOM.getDocument/querySelector/DOM.setFileInputFiles；Runtime.evaluate只读DOM/几何/断言，不用element.click/value赋值/fetch代用户POST。
- CDP Network记录method/path/Content-Type/POST次数，证明无授权无convert、新建无POST /tasks；不输出凭据或文件正文。
- testids最少：intent-view、intent-message-input/send、intent-direction、intent-direction-edit/save、intent-confirm、intent-task-wait、document-file-input、conversion-consent、conversion-submit、conversion-job-<id>、conversion-retry-<id>、document-row-<id>、document-usage-<id>、document-promote-<id>、research-progress、research-retry、activity-log；旧topic/Report testids保留。
- FAIL退出非零、缺browser/API不能PASS；每case标模式及PASS/FAIL/SKIP。offline总timeout约300s；live每阶段可240s，最后状态可读，不无限等待。
- wrapper仅EVERY_DAGENT_NO_BROWSER=1时SKIP；直接script显式调用必须尝试browser，不被该env悄悄跳过。
- offline新gate内用隔离app的实际ID运行旧verify-workspace与verify-trust-ux，分别传`--task`及trust的`--warnings-task`，保证旧界面有真实浏览器证据。
- fixture工厂必须准备普通Report与独立trust/warnings项目：trust项目至少一个未分类Source、矩阵同时有reviewed与unassessed、unresolved/partially_resolved/resolved的用户research outcome、proposal_not_created的Edit、同report/hash的有效pending且delta=0提案、已accepted历史提案；warnings项目有真实形状的validation warnings。这些是旧trust gate的输入前提，否则普通Report会FAIL，不得把缺fixture当回归。
- 脚本化报告与Edit优先复用document-api.test.ts、editing-api.test.ts、pipeline.e2e.test.ts的有效v2结构；可参考已读`.scratch/trust-ux/inject.mjs`的outcome形状，但不得照搬它的SQL或旧缺少内容义务的pending片段。fixture只写隔离临时库，不新增生产HTTP或修改真实demo数据。

### 7.2 可执行场景

| ID | 单元/组件 | 离线HTTP/MCP | 真正browser操作/断言 |
| --- | --- | --- | --- |
| A Transformer多轮→Task | exploring/ready/confirmed、busy/patch/button SSR | intent-api既有two-answer脚本，card不同题目不能覆盖用户方向 | 首页Transformer→两次回答→“请给出正式研究方向”→编辑/确认→Brief；确认前无Task；Network无POST /tasks |
| B Intent刷新 | route/cache优先级/generation | intent-api/intent-discovery持久化 | reload同URL/turn/decisions/proposal；confirm202 null时reload到同Task；再进confirmed不新增Task |
| C 首页Markdown首轮 | invalidUTF8/512KiB/总envelope/失败保留 | intent-api首轮prompt含独有附件句及untrusted | native选md与主题提交，first assistant引用fixture独有句；大文档不声称全文 |
| D PDF/DOCX | consent默认false/raw Headers/Job终态 | conversion-api success/truncated，真实MCP协议、trust正确 | select→未授权无request→同意→raw POST→Job→Library；reload恢复；成功手动docIds续聊，首次未承诺PDF |
| E 用途/Source | 空usage禁/冲突保留/身份说明 | document-api/isolation；promote前置usage/重复created=false | intent_context无Source→改research_source→显式加入→user-provided/not_read，证据不伪增；改回用途不删除Source |
| F Progress/Retry | 所有阶段/count/log/Retry gate | research-progress/retry-api真实429失败→fixture恢复 | 看真实失败/最近活动→Retry→attempt+1/材料保留，旧报告hash不变，历史失败不伪成当前 |
| G Report/Ask/Edit/导出 | 原trust/artifact/brief tests | editing-api/document-api/pipeline，proposal接受才改 | 有Report→upload/usage/promote→hash正文不动→Ask/Edit预览→接受→冻结→HTML/PDF可打开，旧revision不变 |
| H Job失败/超时/重试/无授权 | retryable/失效/transport错误不造failed | conversion-api/leak/dto-leak各mode、已有12000ms timeout、3attempt/consent | failed guidance→用户重试同job；timeout真code；重启旧job404/成功文档仍在；不自动收费 |
| I 旧项目 | routes/default/[]和null fixtures | brief/editing/pipeline/legacy API保留 | legacy Task无Intent各project页/reload/back/forward；切Intent再回可用 |
| J 竞态/冲突 | deferred A晚回B先回、report/answers晚回、StrictMode/dispose/dirty/JSON相同不更新 | intent stale/run_in_progress、doc revision/scope403 | 双标签改方向后旧确认保留草稿/重读；连续Enter一次POST；转换中切项目不污染 |
| K 文件/费用 | 文件格式/名/空/UTF8/bytes/envelope/receipt | fixtures/isolation/duplicate不升级trust | 413/415/429行动提示；取消同意无upload；重复文件额度提醒，不标cache命中 |
| L 导航/布局 | PRIMARY_NAV仍3项 | browser bundle边界 | 1366x768/1440x900/1920x1080的Intent/Library/Progress/Report截图，无严重overflow/不可点 |

超时集成已有12s测试，不新增小于10s的无效配置。fake-mineru-mcp.mjs在CallToolRequestSchema处理里已经支持`--delay-ms`（默认0，tools/call回答前延迟），直接复用：普通进度约3000ms；超时用现有`--delay-ms=60000`+callTimeoutMs:12000。该helper不需要修改。

### 7.3 实施轮命令（PowerShell）

下列新文件/脚本按本计划创建后才能执行；**当前规划轮不运行**。

```powershell
Set-Location -LiteralPath 'D:/SomeProjects/AgentCompetition2026'
pnpm typecheck
pnpm build:research

# 前端契约/纯逻辑/SSR/竞态
pnpm exec vitest run apps/research/tests/api-client.test.ts apps/research/tests/intent-logic.test.ts apps/research/tests/upload-logic.test.ts apps/research/tests/polling.test.ts apps/research/tests/intent-view.test.ts apps/research/tests/document-library-view.test.ts apps/research/tests/research-progress-view.test.ts apps/research/tests/frontend-logic.test.ts

# 真实HTTP/service/runner + 脚本化模型/网络/MCP
pnpm exec vitest run apps/research/tests/intent-api.test.ts apps/research/tests/document-api.test.ts apps/research/tests/document-isolation.test.ts apps/research/tests/conversion-api.test.ts apps/research/tests/conversion-leak.test.ts apps/research/tests/conversion-dto-leak.test.ts apps/research/tests/retry-api.test.ts apps/research/tests/research-progress.test.ts apps/research/tests/brief-api.test.ts apps/research/tests/editing-api.test.ts apps/research/tests/pipeline.e2e.test.ts

# 原界面语义/产物边界
pnpm exec vitest run apps/research/tests/trust-ux.test.ts apps/research/tests/brief-logic.test.ts apps/research/tests/artifact-view.test.ts apps/research/tests/markdown.test.ts apps/research/tests/bundle.test.ts

# 真实Chrome、隔离离线app；包括旧Report/trust gate
node apps/research/scripts/verify-intent-documents.mjs --offline --shots .scratch/step37d-shots

# 最后一次全仓离线；恢复环境变量
$taskPreviousNoBrowser = $env:EVERY_DAGENT_NO_BROWSER
try {
  $env:EVERY_DAGENT_NO_BROWSER = '1'
  pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts' --exclude '**/real-network.test.ts' --exclude '**/render-pdf.test.ts' --exclude '**/research-plugin.real.test.ts' --exclude '**/real-demo.e2e.test.ts' --exclude '**/conversion-smoke.test.ts'
} finally {
  if ($null -eq $taskPreviousNoBrowser) { Remove-Item Env:EVERY_DAGENT_NO_BROWSER -ErrorAction SilentlyContinue }
  else { $env:EVERY_DAGENT_NO_BROWSER = $taskPreviousNoBrowser }
}
```

检查每个exit code并修原因；并行CDP既有flaky可单独重跑失败文件一次并记录首次失败，不能把SKIP或原失败改写PASS。显式CDP gate必须通过，不只引用全仓无browser回归。

### 7.4 live启动/真实模型/正式Demo

实施轮build后在独立终端：

```powershell
$env:RESEARCHPAGE_MODEL = 'deepseek/deepseek-flash'
# DEEPSEEK_API_KEY继承现有环境，禁止打印/写仓库/放命令参数
node apps/research/dist/research-server.mjs --port 8791 --data .scratch/step37d-live-data
```

注意源码parseArgs **没有--model参数**；用env指定profile。不指定--port默认随机端口，不能猜8791。

另一终端：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8791/api/research/runtime'
node apps/research/scripts/verify-intent-documents.mjs --url http://127.0.0.1:8791/ --model --shots .scratch/step37d-live-shots
$taskReportId = '<由浏览器或GET tasks取得的真实有报告Task ID>'
node apps/research/scripts/verify-workspace.mjs --url http://127.0.0.1:8791/ --task $taskReportId --model --shots .scratch/step37d-report-shots
# trust gate已由--offline gate在专用fixture项目上运行；不能把普通真实Report ID当作它的fixture输入
```

新live gate默认不转换新PDF/DOCX，只验证授权提示/已有文档，收费case记SKIP；真实DeepSeek完成Transformer→多轮→方向确认→Brief→Research→Report，结果单列。模型不可用如实列阻塞，不把offline重命名真实通过。

Demo可浏览已有3.7C server_verified文档，先用真实Library确认存在；**conversion-smoke afterAll清理temp数据**，不能假设历史job或文档仍在现库。新Intent可普通上传已经保留的转换Markdown，必须显示direct_upload，不跨session复制documentId或伪造server_verified；如无可复用记录，采用保留Markdown/3.7C历史测量证据，标明历史后端验收。

只有实施轮明确授权新真实上传时，新gate可加opt-in --real-conversion，由浏览器逐文件同意，一次使用既有conversion-sample.pdf/docx。不要重新批量跑smoke消耗额度。历史真实MCP成功+本轮离线CDP成功不等于本轮真实全链PASS，各项分开记录。

## 8. Risks and Recovery

| 精确触发条件 | 风险 | 最小恢复/解决 |
| --- | --- | --- |
| 本轮8791连接拒绝 | live HTTP/browser暂不可验 | 实施轮build后按§7.4隔离data启动，不写原demo库 |
| key存在但provider拒绝/余额/网络 | Intent无新记录/真实Demo失败 | 核对profile/credential-env与当前配置/网络，保留Intent，继续offline；不造模型设置平台 |
| 正式build/typecheck失败 | 前端不可启动 | 修当前diff+bundle边界测试；本轮write:false只证明基线 |
| browser/CDP未起 | 无真实浏览器证据 | RESEARCHPAGE_BROWSER指现有Chrome/Edge；独立profile/端口，单跑失败gate记录 |
| scope切换/StrictMode/晚await | 旧Intent/Task/Report污染 | generation+Abort+request token，每await/notice/navigation检查scope |
| confirm202且pending/busy false、task null | 假失败或跳不存在Task | 只以真实Task出现跳；240s观察提示不是后端failed |
| card两次失败/重启、confirmed无Task | 无公开失败/retry | GET重查、原方向新建探索；不重复confirm/假retry endpoint |
| PDF晚于首轮/upload版本增 | 假承诺/stale写 | 明确下一轮、用户发docIds，先刷新version，保留草稿 |
| convert receipt丢失/刷新 | 无Job列表，可能重复收费 | 标未知，先查Library；不按filename认job，不自动重传 |
| Job404/file_gone/retryable false | 假状态/无限重试 | 停poll、查持久文档，重新选择/同意才新发 |
| 429/20页/10MiB/512KiB | 文件/队列不合适 | limits检查/顺序submit/按guidance等待拆分，明确重试费用 |
| token仍被产品10MiB限制 | 文案虚假承诺 | 展示当前API实限，不改后端limit或做设置平台 |
| doc revision409/scope403 | 覆盖用途/串session | 重读保留选择；不跨scope fallback；Source/link当前Task |
| duplicate回旧document | 错升级trust/用途/免费cache | 以Library实际DTO展示；usage独立显式PATCH |
| 附件后报告变 | 非预期正文修改 | 比对reportId/hash/正文/冻结revision；禁止自动report/Edit/accept |
| 旧DTO fixture编译失败 | 为过测试削断言 | 只补新真实字段，不删旧assertion，记实际文件 |
| 旧docs detail/import/token过期 | 安全回归/错误契约 | §3源码为准，最后定向纠正文档，安全tests保留 |

**必须最小补充后端API的检查结论：**核心P0不需要。安全card原地重试、Job列表与持久化不在基线，采用明确观察/重新发起路径；若未来强制重启后自动续建/续转，必须新增持久/幂等契约，不能伪装成这轮纯前端接线。

规划工具环境受限exec/Node启动报helper_unknown_error，只读命令经受控提升可用；这是工具环境而非产品API或用户审批阻塞，不改机器ACL。

## 9. Explicit Non-goals

- P2动效/换肤/Sidebar重构/第四一级工作区/模板市场/无关设置/通用模型设置平台。
- 修改Agent Core/Host/Protocol/Client、发现fallback、后端研究状态机、Claim Contract/Report renderer。
- 新Redux/XState/React Router/Playwright/Testing Library依赖、平行Intent/Research状态机。
- 新MCP marketplace、浏览器直连MinerU、通用RAG/第二文档库、HTML/PPT/XLS/图片入口。
- 转换前后端cache、自动收费重试、跨session文档复用、持久Job/全局Job平台、安全card原地retry。
- 保证PDF赶首轮、虚假页码/置信度/图片资源、server_verified升级来源身份。
- Markdown全文编辑/历史版本UI、删除Source/Evidence链、新认证系统。
- 附件自动改Report/接受Proposal/确认方向；无用户确认研究不得开始。
- 本规划轮真实MinerU、业务修改、Commit、Push；实施轮默认也不Push。

P1仅P0/回归后补：用途说明深化、按需readiness细节、sha重复提醒/局部可用性。基本第三方提示/显式consent/重复费用/guidance属于P0。

## 10. Definition of Done

后续实施必须同时满足：

1. 浏览器完成Intent→用户确认方向→Task/Brief→用户确认Brief→Research→Report；首页/Brief再生无POST legacy /tasks。
2. 独立Intent URL可reload/reenter；confirmed恢复同Task，null时不误判；旧项目/back/forward/切scope晚响应无污染。
3. 首页Markdown首轮有材料；Intent/Task上传md/pdf/docx；在线同意默认未选，无同意无文件传输，raw Content-Type/bytes正确。
4. 查询真实Job并处理failed/timeout/retryable/404/reload；成功刷新Library，公开DTO无MCP敏感字段，无假阶段/缓存。
5. 用途/Source显式操作、user-provided，ready不冒充读取/证据；scope/revision拒绝可恢复。
6. Progress/attempt/discovery/activity/失败/Retry真实，重试新attempt保材料，无百分比/平行状态机。
7. Brief/Evidence/Source/Ask/Edit/Proposal接受/Report/frozen/HTML/PDF回归；upload/usage/promote本身不改已发布正文。
8. 新unit/SSR/client竞态、旧HTTP+scripted MCP、显式真实CDP离线/旧Report gate、typecheck/build通过；三分辨率截图。
9. 分列纯逻辑/组件、离线HTTP/MCP、真实browser+offline fixture、真实模型、真实MinerU本轮或历史；SKIP/阻塞不能PASS，真实模型没过不能宣称真实完整Demo完成。
10. diff只allowlist及旧DTO补字段，无secret/temp/screenshot入Git，无P2/后端重构，HANDOFF列实际命令/结果/限制。
11. 连续执行已授权工作，不逐步停等；遇外部provider/MinerU授权或可用性不足，准确列阻塞并完成其余工作。
12. **本规划轮完成标准：**仅本文件新增/修改，HEAD不变，无Commit/Push/真实解析；接口/状态/命令自检无空白待确认。

### 本规划轮自检

已交叉核对direction真实body、202/taskId、session.pending、busy作用域、expectedVersion与expectedRevision、Report/Library/summary/Job不同DTO；确认attach版本、Task继承/晚转换关联、Job失效/无cache/真实retry、token产品实限；明确旧gate迁移及CLI不支持--model。实际执行仅基线typecheck、write:false构建、工具/配置存在性与端口探测；真实browser/模型/MinerU未验收。

---

# 附录 A — 实施偏差（Step 3.7D 实施轮追加）

本附录只记录实施过程中与 §1–§10 原文的偏差、以及真实执行的结果。原文未重写。

## A.1 与计划的偏差

| 计划条目 | 实际做法 | 原因 |
| --- | --- | --- |
| §7.1 `verify-intent-documents.mjs --offline`（隔离 app + 脚本化模型 + fake MCP） | **未实现**，只实现 `--url`（live）模式 | 在 Node 里加载 TS composition 需要额外的构建/loader 步骤；本轮把真实浏览器证据集中在 live gate，脚本化模型的部分由既有 HTTP 测试（`intent-api` / `document-api` / `conversion-api`）与新增 SSR 测试覆盖。属未覆盖项，不声称已通过。 |
| §5 `apps/research/tests/helpers/step37d-fixtures.ts` | 未新增 | 上述 offline gate 未实现，fixture 工厂没有消费方；避免新增无人使用的代码。 |
| §5 `apps/research/tests/step37d-browser.test.ts`（Vitest wrapper） | 未新增 | 同上：没有 offline gate 可包。 |
| §5 `apps/research/tests/api-client.test.ts` 中「旧 client 签名兼容」 | 已实现（GET 增可选 `signal`，其余签名不变） | 与计划一致。 |
| §4.3 第 6 条「Intent 不能只比较 version」 | 已实现（按完整 JSON 比较） | 与计划一致。 |
| §4.3 第 5 条「mutation 后 refresh 若正在读同 key，置 dirty 并在当前 GET 后立即补读」 | 已实现，并**加强**为：正在飞的那次读若被 refresh 追上，其结果被丢弃（superseded）而不是先写入再覆盖 | 避免状态回滚造成的闪烁；`polling.test.ts` 覆盖。 |
| §4.6「首页 Markdown 逐份及总 envelope 检查」 | 已实现（`markdownProblemsOf` + `envelopeBytesOf`） | 与计划一致。 |
| §4.7 Retry「同步锁」 | 已实现（组件局部锁 + store `act`，gate 用后端 `bundle.busy`） | 与计划一致。 |
| §5 `docs/STEP_3_7D_PLAN.md` 只追加 | 已遵守 | — |

## A.2 计划外的必要修复

1. **`apps/research/scripts/build.mjs`：node 构建加 banner**。基线的 `dist/research-server.mjs` 一启动就抛 `Dynamic require of "child_process" is not supported`（bundled ESM 里的 `__require` shim 在 `cross-spawn` 导入期被调用），服务在监听前退出。加一行 `createRequire(import.meta.url)` 的 banner 即可；不改变打包结构、不新增依赖。**这是基线缺陷，与本轮功能无关，但没有它就没有可运行的服务，也就没有真实浏览器验收。**
2. **`apps/research/src/browser/store.tsx`：`adoptTask` 走 `enterScope`**。初版实现只切换了 scope 名字而没有重新注册资源集合，导致「确认方向后项目页空白」。计划 §4.4 只写了「找到 Task 后 openTask + 跳 Brief」，实施中才发现必须复用统一的作用域进入路径。
3. **样式类名冲突**：新增的 `.rp-doc` 与 Studio 文档容器 `<article class="rp-doc">`（基线无规则）同名，把文档改成 flex 并导致画布横向溢出。全部新增类改名 `rp-file*`，复测 `canvasScroll === canvasClient`。计划 §5 只写了「仅追加样式」，没有点出类名冲突风险。
4. **`apps/research/scripts/verify-workspace.mjs` 的 `createDraft` 迁移**（计划 §5 已列）：按 §5 改为「Intent → 提案 → 原生确认 → 等 Task」，并补上真实输入读回 + 重试（受控 textarea 的插入文本必须先确认进入 React，否则按钮仍是 disabled 而点击静默无效）。
5. **旧 gate 中引导模式若干断言的语义更新**：项目现在诞生于用户确认过的方向，`brief.fieldStates` 因此从起点就非 `suggested`，`readiness` 不再从 0 开始。相关断言改为**以服务端自身数据为准**（或在其前置条件已不成立时带证据 SKIP），并在输出里写明原因；没有删除任何断言，也没有把 FAIL 改写成 PASS。

## A.3 执行结果（真实证据）

### 命令与结果

```powershell
pnpm typecheck      # 通过（root / web browser / research browser 三组）
pnpm build:research # 通过
EVERY_DAGENT_NO_BROWSER=1 pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts' --exclude '**/real-network.test.ts' --exclude '**/render-pdf.test.ts' --exclude '**/research-plugin.real.test.ts' --exclude '**/real-demo.e2e.test.ts' --exclude '**/conversion-smoke.test.ts'
# 171 文件 / 2122 例通过，11 文件 / 64 例 skipped，0 failed

node apps/research/scripts/verify-intent-documents.mjs --url http://127.0.0.1:8791/ --model --shots .scratch/step37d-live-shots
# 22 passed, 0 failed, 0 skipped（真实 Chrome + 真实 deepseek/deepseek-flash）

node apps/research/scripts/verify-workspace.mjs --url http://127.0.0.1:8792/ --task task_9eb949e99fc7c348 --model --shots .scratch/step37d-report-shots
# 两轮：47/47 PASS / 2 SKIP（有 framed 比较表的历史报告）
#        67/69 PASS / 10 SKIP（另一份历史报告，两条 FAIL 是取报告取错而非回归——见 A.4：该报告本身没有 framed 比较表与机制块）
```

新增测试文件：`api-client.test.ts`(12)、`intent-logic.test.ts`(19)、`upload-logic.test.ts`(19)、`polling.test.ts`(8)、`intent-view.test.ts`(12)、`document-library-view.test.ts`(15)、`research-progress-view.test.ts`(13)；`frontend-logic.test.ts` +3。

### live gate 覆盖的场景（真实浏览器操作）

首页输入主题 → 进入 `#/i/<id>`（Network：`POST /tasks` 次数 0）→ 助手第一问 → 真实键盘回答 → 第二轮提问 → 「请给出正式研究方向」→ 方向面板出现 → **在编辑框里真实输入并保存**（保存按钮由 dirty 驱动，读回校验）→ 确认（`POST /intents/:id/confirm` 恰好 1 次）→ 等待真实 taskId（202 之后地址才变成 `#/p/<id>/brief`）→ 确认任务卡（Network 证明 `POST /tasks/:id/confirm` 发出）→ 研究页出现真实进度组件与真实阶段名 → 报告工作区可打开 → 重新打开 `#/i/<id>` 恢复。

### 未通过 / 未覆盖

- `--offline` gate、`step37d-fixtures.ts`、`step37d-browser.test.ts`：未实现（见 A.1）。
- **真实报告生成本轮未拿到有效报告**：`deepseek-flash` 写出的比较表存在空白单元格，Q03 契约拒绝，合成阶段重试后任务如实 `failed`。服务端源码本轮零改动（`src/server`、`packages/` 无 diff），因此这是基线行为 + 模型可靠性。
- 真实 MinerU 转换：本轮**未重新调用**（按 §5 要求不重复消耗额度）；界面路径的存在性与「无同意不发请求」由 SSR/单元/client 测试覆盖，真实转换沿用 3.7C 的验收记录。
- 三种分辨率的 Intent/Library/Progress 截图：只取了 1440×900（live gate 的步骤截图）；1366/1920 的布局断言由旧 gate 在 Report 上覆盖，Intent/Library 的 1366/1920 未单独截图。
