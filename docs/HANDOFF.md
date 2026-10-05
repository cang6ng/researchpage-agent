# ResearchPage — HANDOFF

## Baseline

- 比赛仓库：`D:/SomeProjects/AgentCompetition2026`（产品仓库称呼：`researchpage-agent`）。
- 起点 commit：`ebb3e7c28d84f825176b9842a0ec7f86c636ecb4`（`chore: bootstrap competition project from Every-DAgent Phase 4`）。
- Upstream sealed baseline：`c5f97ba63f719ec81030746f3eb67fe7c538e01f`；见 [UPSTREAM_BASELINE.md](./UPSTREAM_BASELINE.md)。未修改 upstream，未引入 Phase 5。
- 本轮实施依据：[COMPETITION_SPEC.md](./COMPETITION_SPEC.md)。

## Current Status（2026-10-05）

- **Feasibility 四项全部通过**（真实网络、真实模型，非 fixture）：A1 真实搜索（arXiv）、A2 真实读取 + Evidence、A3 HTML→PDF、A4 Plugin seam。
- **Vertical Product 已可真实演示**：Topic → Task Card → 确认 → 真实检索/读取 → Evidence Matrix → 缺口定向补查（≤2 轮）→ 结构化报告 → HTML 预览 → PDF 下载 → 刷新重开。
- 真实 Demo 两个主题均通过（真实模型 + 真实 arXiv + 真实 Chrome PDF）：
  - GraphRAG：4 篇 arXiv 全文、8 claims 报告、352 KB PDF。
  - LoRA/QLoRA/DoRA：5 篇 arXiv 全文、8 claims 报告、353 KB PDF（无 GraphRAG 专用分支）。
- 未 push；工作树干净后由本轮提交记录。

## 本轮新增（本轮工作产物）

- `packages/plugin-research/`：领域四对象（ReportTask/Source/Evidence/Report）、业务 SQLite、arXiv 检索、真实读取与 HTML 提取、Evidence 真值规则、覆盖推导、报告校验与引用编号、HTML 渲染、CDP PDF 导出、六个业务工具、Research Plugin。
- `apps/research/`：产品应用——组合入口（host + 研究插件 + 可信 tool policy + 业务 API）、stage runner、增量报告草稿、Research Workspace 页面、构建脚本、Workspace 浏览器验收脚本。
- `apps/web`：静态服务器新增一个可选 `onRequest` 路由钩子（应用 API 挂载点），未改变既有 carrier 语义。
- 测试：`packages/plugin-research/tests/*`（真值边界/读取路径/HTML 提取/真实网络）、`apps/research/tests/*`（离线端到端验收、bundle 边界、真实 Demo）。

## 关键实现决定（与 SPEC 的差异）

- **UI 库**：未引入 Fluent UI，使用手写 CSS（时间与依赖风险权衡）；产品语义不变。
- **路由挂载点**：业务 API 挂在 `apps/research` 的应用组合里，通过 `apps/web` 静态服务器的 `onRequest` 钩子；未把研究依赖注入通用 shell 包（保持其边界测试的依赖集合不变，只新增一个 `./shell` 导出与其断言）。
- **阶段化 Run**：底座 loop 上限为 12 步/ run 且不扩大，因此一次研究拆成 card / research / gap(≤2) / report 多个 run，由应用侧 runner 串行驱动并记录阶段；模型不决定预算。
- **报告写入**：单次输出预算（≈4096 tokens）装不下整份报告，`save_report` 支持 `part: start/write/finalize` 增量草稿并持久化在任务上；一次性提交仍可用。
- **浏览器协议客户端**：产品页面不直接连 Host，全部走应用 API（运行由服务端 runner 驱动），因此刷新/重开不依赖浏览器状态。SPEC 允许“UI 的 CRUD、确认与文件导出走应用 API”。

## 已知限制

- 补查轮次上限 2、搜索 ≤6、读取 ≤10、单任务 8 分钟窗口（SPEC 初值，未收紧也未扩大）。
- 读取仅覆盖 arXiv HTML 全文与其摘要页；PDF 正文不解析（如实记为 failed / abstract）。
- 报告 PDF 的分页与字体依赖本机 Chrome/Edge 与系统中文字体；已验证 Windows Chrome。
- `provider 偶发失败`：runner 对每个阶段做一次有界重试；仍失败则如实标 failed，材料保留可重试。
- 未做：报告版本、局部再生成、多结构/多主题模板、来源手动纳入、auth/collaboration。
- 浏览器 gate（`apps/research/scripts/verify-workspace.mjs`）需要本地 Chrome/Edge 与一个运行中的产品服务；IAB（ZCode 内置浏览器）的后端在本机不投递真实点击，故验收走 CDP。

## Next Action

1. `pnpm build:research && node apps/research/dist/research-server.mjs --data <dir> --port <port>`，浏览器打开输出的地址即可演示（需 `DEEPSEEK_API_KEY`）。
2. Phase C（SPEC §12）：冻结功能，做第二主题验收留档、人工证据抽查、视频与原始录屏、README/技术文档、示例报告、license 与 source zip。
3. 未完成事项按 SPEC cut order 处理，不再新增功能。
