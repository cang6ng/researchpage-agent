# Windows 上使用 MinerU 转换（Step 3.7C）

ResearchPage 的 PDF / DOCX → Markdown 能力来自官方的 **mineru-open-mcp**（MCP 服务，
stdio）。它由 ResearchPage 的服务端按需启动，浏览器不会直接调用 MinerU。

> **这不是本地解析。** `mineru-open-mcp` 会把文档上传到 MinerU 的在线服务
> （mineru.net）解析，再把 Markdown 返回。前端必须让用户明确同意之后才能上传；
> 后端在缺少同意标记时直接拒绝，不会启动任何进程。

---

## 1. 准备 uv / uvx

MinerU MCP 用 `uvx` 运行，不需要单独装 Python（`uvx` 会自己准备 CPython 3.10 与依赖）。

```powershell
# 任选一种
winget install --id=astral-sh.uv -e
# 或
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

安装后确认（新开的终端里）：

```powershell
uv --version
uvx --version
where.exe uvx
```

首次运行 `mineru-open-mcp` 会下载一整套依赖（约 85 个包 + 一个 CPython），可能需要
一到几分钟；之后再启动就只花 1～3 秒。

## 2. 启动 MCP 服务（两种方式）

ResearchPage **自己会启动它**，平时不需要手动运行。下面是手动验证用的等价命令：

```powershell
# stdio（产品默认使用的方式）
uvx --from mineru-open-mcp==1.0.22 mineru-open-mcp

# 可选：官方也支持 Streamable HTTP（本轮产品未使用，仅用于手动排查）
uvx --from mineru-open-mcp==1.0.22 mineru-open-mcp --transport streamable-http --port 8001
```

产品里这些都可以用环境变量覆盖：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MINERU_MCP_COMMAND` | 空 | 整条启动命令，优先于 `uvx`；例如 `node C:\path\to\fake-mcp.mjs` 或 `uvx --from mineru-open-mcp==1.0.22 mineru-open-mcp` |
| `MINERU_MCP_PACKAGE` | `mineru-open-mcp==1.0.22` | `uvx --from` 后面的包规格（版本被钉住，因为工具参数与返回结构是按这一版写的） |
| `MINERU_API_TOKEN` | 空 | 可选；见第 3 节。只传给 MCP 子进程，不进响应 / 记录 / 日志 / Git |
| `MINERU_TIMEOUT_MS` | `360000` | 单次 `parse_documents` 调用的超时（毫秒） |
| `MINERU_MCP_PROXY` | 空 | 只有显式设置时代理才会被使用；见第 6 节 |

## 3. Flash 模式与可选 API Token

- **不设置 `MINERU_API_TOKEN` 时就是 Flash 模式**：免费、无需注册即可用。产品实测的
  实际限制是 **单文件 10 MB、20 页**（超过页数会连 Markdown 都不返回，服务端直接拒绝
  并说明「page count exceeds API limit (20 pages)」）。产品把这两个数字写进了
  `GET /api/research/mineru` 的响应与任务视图的 `limits`，并且**在上传前就按 10 MB
  拒绝**（413 `conversion_file_too_large`）。
- 转化能力（以官方工具描述为准）：PDF、DOCX、图片、PPTx、xls/xlsx。本轮产品只开放
  **PDF 与 DOCX** 两个入口，其它扩展名回 415。
- **OCR 由服务端自动决定**：产品不传 `enable_ocr`、也不传 `language`（服务端默认 `ch`）。
  带文字层的 PDF 走文字提取；**纯图像扫描件会走识别**——实测一份 0 文字层的 1 页扫描件
  通过真实 MCP 返回了 782 字可读 Markdown（约 31 s）。更强的语言控制、强制 OCR 或更复杂
  的扫描件本轮没有实测。
- **设置 `MINERU_API_TOKEN` 后**进入官方说的精确模式（更高上限、更多输出格式）。
  Token 只在服务端环境里，不写入任何记录或响应；`GET /api/research/mineru` 只会告诉你
  当前是 `"mode": "flash"` 还是 `"token"`。
- **超过 20 页的文件不会被「解析一部分」**：MinerU 拒绝整份文件，产品如实报告
  `flash_page_limit` 并给出「拆分文件或设置 Token」的建议——不会把没处理的页面说成已解析。

## 4. 验证连接与真实转换

服务端启动后：

```bash
# 1) 转换器是否真的可用（会真的启动一次 MCP 服务并 tools/list）
curl -s http://127.0.0.1:8791/api/research/mineru
# → {"ok":true,"mineru":{"transport":"stdio","package":"mineru-open-mcp==1.0.22",
#    "command":"...uvx...","mode":"flash","parseDocuments":true,"durationMs":1580},
#    "limits":{...,"online":true,...},"problem":null}
# `ok` 只有在真的起过转换器、听过它的 initialize 并列出工具之后才为 true。
# 这个响应**不回传 MCP 自报的服务名/版本与工具名**（那是第三方进程自己选的字符串，
# 进了浏览器就是一条数据出口）；想知道对方到底是谁，用上面第 1 节的手工命令看。

# 2) 真实转换（把 PDF 换成你自己的文件；consent 是用户同意标记）
curl -s -X POST \
  "http://127.0.0.1:8791/api/research/documents/convert?sessionId=<你的会话>&filename=paper.pdf&usage=research_source&consent=third_party_upload" \
  -H "content-type: application/octet-stream" --data-binary @paper.pdf
# → 202 {"ok":true,"job":{"jobId":"conv_...","status":"queued",...}}

# 3) 查询任务
curl -s "http://127.0.0.1:8791/api/research/documents/convert/<jobId>?sessionId=<你的会话>"
# → succeeded 时带 document.documentId 与 conversion.trust="server_verified"
# → failed 时带 failure.code / problem / guidance，且 retryable 标明能否重试
```

离线回归用脚本化 MCP 服务：`pnpm vitest run apps/research/tests/conversion-api.test.ts`。
真实验收（会真的上传到 mineru.net）：

```bash
RESEARCHPAGE_REAL_MINERU=1 pnpm vitest run apps/research/tests/conversion-smoke.test.ts
# 可选：再加一份你自己的 PDF，以及验证页数上限
RESEARCHPAGE_REAL_MINERU=1 RESEARCHPAGE_SMOKE_EXTRA_PDF=/path/paper.pdf \
  RESEARCHPAGE_SMOKE_PAGE_LIMIT=1 pnpm vitest run apps/research/tests/conversion-smoke.test.ts
```

## 5. 在线解析与数据外传

- 只要发起转换，**原始文件就会离开这台机器**：先到 `mineru.net` 的 API，再上传到它的
  OSS 存储，结果从 `cdn-mineru.openxlab.org.cn` 取回。
- 因此：接口要求 `consent: "third_party_upload"`；没有它产品直接拒绝（400
  `consent_required`），**不会**先上传再问；前端必须把这件事写给用户看。
- 不要把机密文件、个人信息或受合同限制的材料放进转换；产品不提供本地解析兜底。
- 转换记录会写明「由服务端调用 MinerU 转换」（`server_verified`），但这只说明**转换是
  服务端真实执行的**，不说明内容一定准确，也不意味着来源是官方或一手资料——用户上传的
  文档在研究系统里仍然是 `user-provided`。

## 6. 代理（本机实测过的坑）

Python 的 httpx 会连同 **Windows 注册表里的系统代理**一起使用，而 Node 不会。
实测（2026-10-08，本机系统代理为 `127.0.0.1:7897`）：

- 通过该代理，`mineru.net` 的 API 能通，但 **Markdown 下载会失败**：
  `httpx.ConnectError: EOF occurred in violation of protocol`；
- 同一时刻直连 `mineru.net` 与 `cdn-mineru.openxlab.org.cn` 都正常。

所以产品的默认行为是：**MCP 子进程禁用代理**（`NO_PROXY=*`，httpx 因此也会忽略注册表
代理）。如果你的网络必须走代理，显式指定：

```powershell
$env:MINERU_MCP_PROXY = "http://127.0.0.1:7897"
```

## 7. 常见失败与含义

产品会把失败原因翻译成可执行的句子（`GET …/convert/:jobId` 的 `failure.code`）：

| code | 含义 / 处理 |
| --- | --- |
| `mcp_not_installed` | 这台机器上没有 `uvx`（或 `MINERU_MCP_COMMAND` 指错了）。装 uv 后重试 |
| `mcp_handshake_failed` | MCP 子进程起不来（首次下载失败、被安全软件拦住、命令不对）；`failure.detail` 里带它的 stderr |
| `mcp_tools_missing` | 连上了，但没有 `parse_documents`（装成了别的包/版本） |
| `flash_page_limit` | 超过 Flash 的 20 页：拆分文件，或设置 `MINERU_API_TOKEN` |
| `flash_file_too_large` | 超过 10 MB：压缩/拆分，或设置 Token |
| `flash_unsupported_type` | Flash 不支持这种类型 |
| `flash_rate_limited` | 被限流：稍后重试 |
| `network_unavailable` | 没连上 MinerU（网络或代理）；见第 6 节 |
| `conversion_timeout` | 超时（默认 360 s）：换更小的文件或稍后重试 |
| `conversion_cancelled` | 服务端在转换过程中关闭；重新发起即可 |
| `markdown_empty` / `output_missing` / `output_outside_workdir` | 返回不可用或不完整（含结果文件不在受控目录内）：fail-safe，不会入库 |
| `document_too_large` | 转换结果超过文档库 512 KiB：**明确失败**，不截断、不伪装成功 |
| `conversion_failed` | MinerU 拒绝但没有可识别的原因：原文附在 `failure.detail`，不猜原因 |

---

## 8. 界面用法（Step 3.7D）

转换现在有一整条界面路径，不需要再用脚本调 API：

1. **加材料**（首页「带上已有材料」、澄清页「添加材料」、来源工作区「添加材料」）
   - 选文件：`.md / .markdown / .txt` 直接入库；`.pdf / .docx` 需要转换。
   - Markdown 在浏览器里先做**严格 UTF-8** 校验与 512 KiB 检查，不合格的文件会当场说明原因，不会被静默替换或上传。
   - PDF / DOCX 会出现一个**默认未勾选**的同意框：「原始文件会发送到 MinerU 的在线服务解析；重复提交或重试会再次消耗额度，并可能产生费用。同意仅针对本次选择的文件。」未勾选时「开始转换」不可用，不发任何请求。更换文件需要重新同意。
   - 首页选择的 PDF/DOCX 会在**主题提交、探索建立之后**才发出（转换要归属于一个 session）；取消不勾选就不会发。
2. **转换任务**：提交后按 jobId 轮询真实状态（排队中 / 解析中 / 入库中 / 转换完成 / 转换失败），并显示 `第 N/M 次尝试`、文件名、大小与格式。
   - 失败时显示服务端的 `problem` 与 `guidance`，以及错误代码；`retryable` 为 true 才出现「重试这次转换」，点击后会先看到一条费用提醒（「会再次把这份文件发送到 MinerU 在线解析，并再次消耗额度与产生费用」），确认后才真的重试。
   - 服务端重启后 job 不存在：界面显示「任务已失效」，并说明已经转换成功的文档仍在文档库里（job 只存在内存里，这是设计而非故障）。
   - 「检查转换服务」按钮按需探测（`GET /api/research/mineru`），503 时按服务端给出的 `problem` 显示，不影响 Markdown 上传。
3. **文档库**：转换成功后文档出现，标出 `转换入库`、原文格式、转换服务，以及**可信等级**——
   - `服务端已执行转换`（`server_verified`）：这次转换由服务端自己调用完成；
   - `调用方自报（未经服务端核验）`（`client_claimed`）：这条转换记录来自 HTTP 调用方，服务端没有执行也没有核验。
   - trust 只说明「转换确实发生过」，不代表内容正确，也不会把文档抬成 official / primary。
4. **用途与来源**：每份文档至少一个用途（`澄清方向时参考` / `研究来源`），改动走 `PATCH` 并带 revision；任务卡存在后，标为「研究来源」且尚未关联的文档会出现「加入研究来源」，成功后身份是 `用户提供`、读取状态是 `尚未读取`——它不会自动变成证据，也不会自动改报告。

界面不会出现转换器自己的输出：没有原始 stderr、没有本机路径、没有预签名 URL、没有对端自报的服务名与版本、没有历史上文档里提到的 `failure.detail`。
