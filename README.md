# 研页 · ResearchPage

> 从一个研究问题出发，形成可以阅读、追查依据、局部修订与交付的研究报告。

**参赛项目**：2026（第 3 届）全国大学生数智链应用大赛 · 人工智能 / 智能体 / 工具类智能体  
**项目仓库**：https://github.com/cang6ng/researchpage-agent  
**参赛代码版本**：[`ecdc45677d03301eddcdcc1aadb4fa7f3539e095`](https://github.com/cang6ng/researchpage-agent/tree/ecdc45677d03301eddcdcc1aadb4fa7f3539e095)  
**交付方式**：Windows 双击启动的本地 Web 应用（非 Tauri 安装包）

## 项目简介

ResearchPage 面向技术学习、组会预研和方案比较等研究场景。用户输入一个主题后，系统先通过对话澄清研究对象、读者、范围与问题，再把确认的方向转为可执行研究任务。Research Agent 检索、阅读并保存来源材料，将证据映射到比较对象与研究维度；系统按研究结构生成带引用、缺口说明、核验索引的报告，支持阅读、定向补查、提出局部修改、版本冻结与 PDF 导出。

核心设计不是“给 LLM 加一个排版模板”，而是让 **Research Brief → Evidence Matrix → Claim → Evidence → Source → Frozen Report** 构成能查验的研究过程。报告校验只能核验结构、可追溯性与所声明的限制，**不意味着自动证明论文结论正确、检索全面或不同论文的实验数字可直接排序**。

## 功能概览

- **对话式研究澄清**：从模糊主题探索出明确的研究问题；用户确认后才开始研究与撰写。
- **研究任务和证据矩阵**：固定研究对象及比较维度，分别记录依据、有限支持和缺口。
- **真实来源发现与阅读**：接入 arXiv 与 OpenAlex；区分“找到候选论文”和“实际读取正文”。
- **可选文档输入**：Markdown 直接导入；PDF/DOCX 由 MinerU MCP 在线转换，需用户对第三方上传显式同意。
- **结构化报告**：研究框架、概念模型、机制分析、条件化比较、综合判断、局限、参考来源和核验索引。
- **有界 Agent 操作**：Ask（问答）、Research（补查）、Edit（修改提案），涉及报告正文的改变有权限边界与用户接受动作。
- **可交付成果**：HTML 工作台预览、冻结的报告版本、PDF 导出；本地 SQLite 保存任务和来源证据。
- **失败与恢复**：明确部分模型失败类别；既有证据与草稿尽量保留，支持在符合状态前提下恢复报告生成。

## Windows：双击启动

### 1. 准备环境（首次）

- **Node.js 24.x**（项目实际测试基线为 24.17.0；尽管根 `package.json` 声明 `>=22.19.0`，为避免 `node:sqlite` 等环境差异，建议使用 24.x）
- **pnpm 11.8.0**
- **网络连接**：首次安装依赖，以及真实模型与资料检索时需要
- **有效的模型 API Key**：默认模型 `deepseek/deepseek-flash`
- **Chrome 或 Edge**：供网页查看和报告 PDF 导出使用（建议保持安装）
- **可选：uv/uvx**：只有使用 PDF/DOCX 转换时才需要，详见 [MinerU 配置](docs/MINERU_WINDOWS.md)

### 2. 填写配置

将仓库根目录 `.env.example` 复制为 `.env`，填写自己的凭据：

```dotenv
DEEPSEEK_API_KEY=your_own_api_key
# RESEARCHPAGE_MODEL=deepseek/deepseek-flash
# RESEARCHPAGE_PORT=8791
# MINERU_API_TOKEN=
```

`.env` 仅保存在本地，已由 `.gitignore` 忽略。不要把真实密钥放在公开仓库、截图或演示视频中。也可改用系统环境变量，系统环境变量优先。

### 3. 启动

在 Windows 资源管理器中**双击仓库根目录的 `启动 ResearchPage.cmd`**：

1. 检查 Node / pnpm / 配置；
2. 必要时自动安装依赖及构建 Web 服务；
3. 启动本地服务并等待 HTTP 就绪；
4. 自动在默认浏览器打开 `http://127.0.0.1:8791/`。

控制台窗口会显示服务日志。关闭控制台或按 `Ctrl+C` 停止服务。脚本不会主动结束占用端口的陌生进程。

> **重要**：不要仅用 `localhost` 链接充当比赛公网演示地址；该页面只供启动它的电脑访问。若评委在别的电脑复现，应下载源码并按上述步骤配置启动。

详细说明与故障排查见仓库的 [README-Windows.md](README-Windows.md)。

### 其他系统 / 开发调试

当前比赛交付重点是 Windows 双击脚本。开发者可在项目根目录手工运行：

```bash
pnpm install
pnpm build:research
pnpm --filter @every-dagent/research-app start
```

命令启动前需设置有效的模型凭据；服务默认数据目录按启动工作目录解析，详见 `apps/research/src/server/main.ts`。上述命令仅为技术复现路径，不代表 Linux/macOS 已经过一键脚本验收。

## 操作路线

1. 输入研究主题；可附带 Markdown、或在知情同意后提交 PDF/DOCX 转换。
2. 回答必要的研究澄清问题，检查并**确认** Brief / 研究任务。
3. 观察研究过程：候选来源、真实读取材料、证据矩阵和定向补查。
4. 进入报告工作台查看章节、对比表、引用和证据缺口。
5. 通过 Ask 了解已有研究；通过 Research 补查；通过 Edit 生成修改提案并决定是否接受。
6. 冻结报告版本、导出 PDF 并分享成果。

## 核心架构

```text
React 19 + Mantine Web 工作台
             │ 本地 HTTP API
Research App（Intent / Brief / Runner / API / Export）
             │
Every-DAgent Host + Agent Core（Session、Agent Loop、工具策略）
             │
Research Plugin（Task、Source、Evidence、Matrix、Report、Validation）
        ┌────┼──────────┬─────────────┐
      SQLite  arXiv/OpenAlex  MinerU MCP（可选）  HTML/PDF Renderer
             │
        Pi-AI Model Adapter → DeepSeek API（需自带凭据）
```

主要源码路径：`apps/research` 是应用服务器与 React 工作台，`packages/plugin-research` 负责研究领域工具与数据，`packages/agent-core` / `packages/host` / `packages/model-pi-ai` 是复用的通用 Agent 底座。

**代码来源说明**：比赛项目从 [Every-DAgent](https://github.com/cang6ng/dsh-life-assistant) 的既有封存基线二次开发；研究业务层、证据模型与 ResearchPage 工作台在独立参赛仓库中演进。详见 `docs/UPSTREAM_BASELINE.md`。

## 测试与已交付案例

以比赛最终 SHA `ecdc456` 为准，开发侧提供的发布验收记录：

| 验收 | 记录结果 | 证据性质 |
| --- | --- | --- |
| `pnpm typecheck` | PASS | 发布时实际运行（开发侧日志） |
| `pnpm build:research` | PASS | 发布时实际运行（开发侧日志） |
| 受影响套件 | **13 文件 / 144 tests PASS** | 发布时定向离线回归；包含脚本化模型端到端及 PDF 相关测试，不等于全部都是真实模型 |
| 授权安全终审 | RELEASE GATE PASS；F01–F08 ALL CLOSED | 独立审查记录；针对提交前的授权修复 |
| 真实研究成果 | 8 节、19 条 Claim、校验 `ok=true`、0 errors、5 warnings | 用户实际产物的数据库记录（开发侧报告）及下方 PDF |

**真实样例研究报告**：《企业文档问答场景下的 GraphRAG 方案选型：Microsoft GraphRAG、LightRAG、HippoRAG 的效果与成本比较》，共 13 页。它引用三篇实际读取的 arXiv 论文，明确指出不同论文的指标和成本口径无法直接合并排名，包含比较表、证据缺口与核验索引。完整样例 PDF 由参赛团队另附；它**不是**对三种 GraphRAG 算法进行独立基准测试的证据。

> 本页的测试数字来源于开发侧发布日志，未经 README 编写方在本地重新执行；正式全量离线套件未在最终提交轮再次重跑。详情见参赛《技术设计与测试报告》。

## 数据、隐私与局限

- `researchpage-data/` 保存 SQLite 业务数据和报告文件，默认不会进入 Git。**源代码 ZIP 不包含真实论文读取快照或本地研究历史**，评委需要自行新建任务，或单独查看提供的案例 PDF。
- PDF/DOCX 转换使用可选 **MinerU 在线服务**，用户需显式同意第三方上传；它不是纯离线 OCR。
- 真实研究需联网及可用模型凭据；在默认本地交付中不含公网托管与统一凭据配置界面。
- Evidence 链证明来源曾被读取并记录相关片段，不构成事实正确性、穷尽性或跨论文数字可比性的保证。
- 报告可以存在如“有限支持”“无法直接比较”的警示，系统不会为追求全绿而强制消除真实缺口。
- 本地 `v1.0.0-contest` 标签曾指向早于最终 SHA 的历史版本；**请以本文固定 SHA 为准**，不要误用该标签作为最终源码。

## 许可证与第三方组件

截至上述固定提交，**仓库根目录未包含 `LICENSE` 文件**。这意味着不可直接宣称整个 ResearchPage 已以 MIT/Apache 等特定许可证公开授权。参赛团队应自行确认最终代码授权方式，并核对所有依赖、上游底座及第三方服务的使用条款。

核心技术组件包括 React、Mantine、TypeScript、Node.js、pnpm、SQLite、pi-ai、Model Context Protocol SDK、MinerU MCP（可选）、arXiv/OpenAlex（检索来源）。具体依赖版本以仓库清单为准，许可详见各组件官方条款；技术报告中另列许可合规清单。论文引用遵循原始来源标注，不把其全文作为代码资源再分发。

## 团队与联系

参赛团队为两人；姓名、学校、指导教师及联系方式请按报名表实际信息填写。公开仓库不要上传电话号码、身份证件等不必要个人信息。
