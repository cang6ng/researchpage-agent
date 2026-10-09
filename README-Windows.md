# 研页 · ResearchPage —— Windows 启动说明

双击仓库根目录的 **`启动 ResearchPage.cmd`** 即可。它会检查环境、按需安装依赖与构建、
读取模型配置、启动本地服务，等服务真正就绪后自动打开默认浏览器。

服务只监听本机（`http://127.0.0.1:8791/`），不会对外开放。

---

## 1. 首次环境准备（只做一次）

| 依赖 | 要求 | 安装方式 |
| --- | --- | --- |
| Node.js | 24 或更高（项目记录的测试基线是 24.17.0） | <https://nodejs.org/>，或 `winget install --id OpenJS.NodeJS.LTS -e` |
| pnpm | 11.8.0（`package.json` 里声明） | `npm install -g pnpm@11.8.0`，或 `corepack enable` |
| uv / uvx | 只有用「转换 PDF / DOCX」时才需要 | 见 [MINERU_WINDOWS.md](./docs/MINERU_WINDOWS.md) |

装好后**重新打开一个窗口**再双击启动（新装的环境变量需要新窗口才生效）。

依赖与构建产物不需要手动准备：缺少时启动脚本会自己执行 `pnpm install` 和
`pnpm build:research`（首次会联网下载，需要几分钟）。

## 2. 模型配置

服务需要一个模型的凭据，两种方式任选一种：

**方式 A：项目根目录的 `.env`（推荐）**

把仓库里的 `.env.example` 复制为 `.env`，填入：

```
DEEPSEEK_API_KEY=你的密钥
```

**方式 B：用户环境变量**

```powershell
setx DEEPSEEK_API_KEY "你的密钥"
```

设置后需要重新打开窗口。两种方式都用环境变量把凭据交给本机服务：
启动脚本**不打印、不写入日志、不上传**它的值；`.env` 也已被 `.gitignore` 忽略。
环境变量优先于 `.env`。

可选的配置项见 `.env.example`，常用的两个：

- `RESEARCHPAGE_MODEL`：模型 profile，默认 `deepseek/deepseek-flash`；
- `RESEARCHPAGE_PORT`：服务端口，默认 `8791`（被占用时改成别的端口，例如 `8792`）。

## 3. 双击启动

双击 **`启动 ResearchPage.cmd`**。窗口里会依次显示：

```
[OK] Node.js：v24.17.0     [OK] pnpm：11.8.0     [OK] 项目依赖：已安装
[OK] 构建产物：apps\research\dist     [OK] 模型：deepseek/deepseek-flash
[OK] 凭据：DEEPSEEK_API_KEY 已设置（值不显示）     [OK] 端口：8791 空闲
[OK] 数据目录：…\researchpage-data     [OK] 服务已就绪：http://127.0.0.1:8791/
```

服务就绪后浏览器会自动打开。这个窗口之后一直显示服务的日志。

- 在工作目录之外启动也没有问题：脚本以**自身所在目录**为项目根目录。
- 重复双击不会启动第二个实例：若服务已经在同一数据目录上运行，脚本只打开浏览器。
- 端口被别的程序占用时，脚本会说明是谁占用、怎么换端口，**不会结束任何其它进程**。
- 出错时窗口不会闪退：中文原因和解决方法会留在窗口里，按任意键才关闭。

## 4. 关闭方式

- **关闭这个控制台窗口**（最简单）；
- 或在窗口里按 **Ctrl+C**：服务会停止，启动脚本随后打印「服务已停止（退出码 …）」。

两种方式都不会损坏数据：记录保存在 SQLite 里（崩溃安全），再次启动会接着用同一个
数据目录。

## 5. 数据在哪里

服务的数据固定放在 `<仓库根目录>\researchpage-data\`：

- `store\research.db`、`store\host.db`：项目、任务、报告等记录；
- `reports\*.pdf`、`reports\*.html`：导出的报告。

启动脚本只会读写这个目录，**不会删除或覆盖**它；换机器时整个目录拷走即可。
（`researchpage-data\` 与 `.env` 都在 `.gitignore` 里，不会进入版本库。）

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示找不到 Node.js / pnpm | 按提示安装后**重新打开窗口**再启动 |
| 提示没有找到模型凭据 | 按第 2 节配置 `.env` 或环境变量 |
| 提示端口被占用 | 在 `.env` 里加 `RESEARCHPAGE_PORT=8792`（不要结束不认识的进程） |
| 启动很慢（第一次） | 首次要下载依赖并构建，之后再启动只需几秒 |
| 改了代码想重新构建 | 删除 `apps\research\dist` 目录后再启动一次（脚本会自动构建），或手动执行 `pnpm build:research` |
| 想确认服务是否已在运行 | 浏览器打开 <http://127.0.0.1:8791/>；或在 PowerShell 里执行 `netstat -ano \| findstr :8791` |
