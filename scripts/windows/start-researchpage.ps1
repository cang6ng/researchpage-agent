#Requires -Version 5.1
<#
  研页 · ResearchPage —— Windows 一键启动（由仓库根目录的「启动 ResearchPage.cmd」调用）

  它只做“把它启动起来”这件事，不修改产品代码、不覆盖数据：

    · 以仓库根目录为基准（.cmd 用 %~dp0 传入），与当前工作目录无关；
    · 检查 Node.js（要求 24 或更高；项目记录的测试基线是 Node 24.x）与 pnpm；
    · 缺依赖就执行 pnpm install，缺构建产物就执行 pnpm build:research；
    · 按项目既有约定取模型与凭据：环境变量优先，其次仓库根目录的 .env；
      凭据只经环境变量交给本机服务，脚本从不打印、写入或上传它的值；
    · 用固定数据目录 <仓库根>\researchpage-data 与固定端口（默认 8791，可由
      RESEARCHPAGE_PORT 覆盖）启动服务；数据目录只读写，不删除、不覆盖；
    · 端口被占用时如实报告，绝不结束任何别的进程；若本仓库的服务已经在同一
      数据目录上运行，则不重复启动，只打开浏览器；
    · 等 HTTP 真正就绪后再打开默认浏览器；服务运行期间日志留在本窗口；
    · 失败时打印中文原因与解决方法并以非 0 退出（.cmd 会 pause，窗口不闪退）。

  退出码：
    0   服务已在运行（未重复启动，已打开浏览器）
    1   失败（原因与解决方法已打印）
    3   服务本次启动过，随后停止
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

# 中文输出：把控制台切到 UTF-8。本文件以 UTF-8 带 BOM 保存，
# Windows PowerShell 5.1 才会按 UTF-8 解析其中的中文。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

# 输出直接走控制台（[Console]::WriteLine）而不是 PowerShell 主机的 Write-Host：
# 主机在窄缓冲宽度下会自己按列折行、并把续行缩进，长句里的变量名会被折断；
# 走控制台则只在窗口边缘自然换行，重定向到文件时保持一行一条。
function Write-Plain {
  param([string]$Text = '', [string]$Color = '')
  if ($Color -ne '') {
    try {
      switch ($Color) {
        'Green' { [Console]::ForegroundColor = [ConsoleColor]::Green }
        'Yellow' { [Console]::ForegroundColor = [ConsoleColor]::Yellow }
        'Red' { [Console]::ForegroundColor = [ConsoleColor]::Red }
        'Cyan' { [Console]::ForegroundColor = [ConsoleColor]::Cyan }
        default { [Console]::ForegroundColor = [ConsoleColor]::Gray }
      }
    } catch { }
  }
  try {
    [Console]::WriteLine($Text)
  } catch {
    Write-Host $Text
  }
  if ($Color -ne '') {
    try { [Console]::ForegroundColor = [ConsoleColor]::Gray } catch { }
  }
}

function Write-Head {
  param([string]$Text)
  Write-Plain $Text 'Cyan'
}

function Write-Line {
  param([string]$Text)
  Write-Plain ("  " + $Text)
}

function Write-Ok {
  param([string]$Text)
  Write-Plain ("  [OK]   " + $Text) 'Green'
}

function Write-Note {
  param([string]$Text)
  Write-Plain ("  [注意] " + $Text) 'Yellow'
}

function Stop-WithProblem {
  param([string]$Problem, [string[]]$Guidance = @())
  Write-Plain ""
  Write-Plain ("  [失败] " + $Problem) 'Red'
  if ($Guidance.Count -gt 0) {
    Write-Plain "  解决方法：" 'Red'
    foreach ($line in $Guidance) { Write-Plain ("    " + $line) }
  }
  Write-Plain ""
  exit 1
}

# ── 探测用的几个小函数（只读，不动任何东西）────────────────────────────────

# 某端口上是否有进程在监听；返回监听进程的 PID，没有则返回 0。
function Get-ListenerProcessId {
  param([int]$Port)
  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $connection) { return [int]$connection.OwningProcess }
  } catch { }
  return 0
}

# 某个进程的命令行；取不到时返回空字符串。
function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $ProcessId) -ErrorAction Stop
    if ($null -ne $process) { return [string]$process.CommandLine }
  } catch { }
  return ''
}

# 某个进程启动的 ResearchPage 服务用的端口与数据目录（只报告这两个事实，不回显整条命令行）。
function Get-ServerFacts {
  param([string]$CommandLine)
  $facts = [pscustomobject]@{ Port = ''; Data = ''; IsServer = $false }
  if ($CommandLine -eq '' -or $CommandLine -notmatch 'research-server') { return $facts }
  $facts.IsServer = $true
  $portMatch = [regex]::Match($CommandLine, '--port\s+(\d+)')
  if ($portMatch.Success) { $facts.Port = $portMatch.Groups[1].Value }
  $dataMatch = [regex]::Match($CommandLine, '--data\s+("[^"]+"|\S+)')
  if ($dataMatch.Success) { $facts.Data = $dataMatch.Groups[1].Value.Trim('"') }
  return $facts
}

# 端口上是否真的服务着 ResearchPage 页面（HTTP 200 且页面里有 ResearchPage 标记）。
function Test-ResearchPageHttp {
  param([int]$Port, [int]$TimeoutSec = 5)
  try {
    $uri = "http://127.0.0.1:{0}/" -f $Port
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $TimeoutSec
    if ($response.StatusCode -ne 200) { return $false }
    return ([string]$response.Content).Contains('ResearchPage')
  } catch {
    return $false
  }
}

# 数据目录里的 SQLite 是否被别的进程占着独占锁；被占则返回那个文件名。
function Test-DataDirLocked {
  param([string]$DataDir)
  foreach ($relative in @('store\host.db', 'store\research.db')) {
    $file = Join-Path $DataDir $relative
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    try {
      $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $stream.Close()
    } catch {
      return $relative
    }
  }
  return $null
}

# 找出其它正在运行的 ResearchPage 服务进程（只用来诊断，绝不结束它们）。
function Get-OtherServerProcesses {
  param([int]$ExcludeProcessId)
  $found = [System.Collections.Generic.List[string]]::new()
  try {
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
  } catch {
    return $found
  }
  foreach ($process in $processes) {
    if ([int]$process.ProcessId -eq $ExcludeProcessId) { continue }
    $facts = Get-ServerFacts -CommandLine ([string]$process.CommandLine)
    if (-not $facts.IsServer) { continue }
    $line = "PID " + $process.ProcessId
    if ($facts.Port -ne '') { $line = $line + "（端口 " + $facts.Port + "）" }
    if ($facts.Data -ne '') { $line = $line + "：数据目录 " + $facts.Data }
    $found.Add($line)
  }
  return $found
}

# 读取仓库根目录的 .env（可选）：环境变量优先，.env 只补空缺。
# 只返回被读取的变量名，值不打印、不记录。
function Import-DotEnv {
  param([string]$Path)
  $loaded = [System.Collections.Generic.List[string]]::new()
  $skipped = [System.Collections.Generic.List[string]]::new()
  $first = $true
  foreach ($raw in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    $line = [string]$raw
    if ($first) {
      $line = $line.TrimStart([char]0xFEFF)
      $first = $false
    }
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { continue }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
    if ($value.Length -ge 2) {
      $firstChar = $value.Substring(0, 1)
      $lastChar = $value.Substring($value.Length - 1, 1)
      if (($firstChar -eq '"' -and $lastChar -eq '"') -or ($firstChar -eq "'" -and $lastChar -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    if (Test-Path -Path ("Env:" + $name)) {
      $skipped.Add($name)
    } else {
      Set-Item -Path ("Env:" + $name) -Value $value
      $loaded.Add($name)
    }
  }
  return [pscustomobject]@{ Loaded = $loaded; Skipped = $skipped }
}

# ── 开头的自我介绍 ──────────────────────────────────────────────────────────

Write-Plain ""
Write-Head "  研页 · ResearchPage —— Windows 一键启动"
Write-Plain ""

try {
  $ProjectRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
} catch {
  Stop-WithProblem ("找不到启动脚本所在的项目目录：" + $Root) @(
    "请确认「启动 ResearchPage.cmd」就在仓库根目录里，且没有被移动。")
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json') -PathType Leaf)) {
  Stop-WithProblem ("这个目录里没有 package.json，不是 ResearchPage 项目根目录：" + $ProjectRoot) @(
    "请把「启动 ResearchPage.cmd」放回仓库根目录（与 package.json 同一层）再双击。")
}

Set-Location -LiteralPath $ProjectRoot

Write-Line ("项目目录：" + $ProjectRoot)
Write-Line "本脚本只读项目文件，不会修改产品代码，也不会删除或覆盖数据目录。"
Write-Plain ""

# ── [1] Node.js ─────────────────────────────────────────────────────────────

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) {
  Stop-WithProblem "没有找到 Node.js。" @(
    "本项目要求 Node.js 24 或更高（记录在案的测试基线是 24.17.0）。",
    "安装方式（任选一种）：",
    "  1) 打开 https://nodejs.org/ 下载并安装 Node.js 24 LTS",
    "  2) 或在 PowerShell 里执行：",
    "       winget install --id OpenJS.NodeJS.LTS -e",
    "装好后重新打开本窗口，再双击「启动 ResearchPage.cmd」。")
}

$nodeVersion = ''
try { $nodeVersion = (([string](& node -v 2>$null))).Trim() } catch { }
if ($LASTEXITCODE -ne 0 -or $nodeVersion -eq '') {
  Stop-WithProblem "Node.js 存在，但运行 node -v 失败。" @(
    "请确认 Node.js 安装完整（重新安装一次 Node.js 24 即可），然后重试。")
}
$nodeMajor = 0
$nodeMajorMatch = [regex]::Match($nodeVersion, '^v?(\d+)')
if ($nodeMajorMatch.Success) { $nodeMajor = [int]$nodeMajorMatch.Groups[1].Value }
if ($nodeMajor -lt 24) {
  Stop-WithProblem ("Node.js 版本太低：当前是 " + $nodeVersion + "，本项目要求 24 或更高。") @(
    "安装 Node.js 24 LTS：https://nodejs.org/",
    "或执行：winget install --id OpenJS.NodeJS.LTS -e",
    "装好后重新打开本窗口再双击启动。")
}
Write-Ok ("Node.js：" + $nodeVersion + "（" + $nodeCommand.Source + "）")

# ── [2] pnpm ────────────────────────────────────────────────────────────────

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $pnpmCommand) {
  Stop-WithProblem "没有找到 pnpm。" @(
    "本项目用 pnpm 管理依赖（package.json 里声明的是 pnpm@11.8.0）。",
    "安装方式（任选一种，装好后重新打开本窗口）：",
    "  1) 在 PowerShell 里执行：npm install -g pnpm@11.8.0",
    "  2) 或执行：corepack enable",
    "     （Node 自带的 Corepack 会按项目声明的版本准备 pnpm）")
}
$pnpmVersion = ''
try { $pnpmVersion = (([string](& pnpm -v 2>$null))).Trim() } catch { }
if ($LASTEXITCODE -ne 0 -or $pnpmVersion -eq '') {
  Stop-WithProblem "pnpm 存在，但运行 pnpm -v 失败。" @(
    "请重新安装：npm install -g pnpm@11.8.0，然后重试。")
}
Write-Ok ("pnpm：" + $pnpmVersion)

# ── [3] 依赖 ────────────────────────────────────────────────────────────────

$dependenciesMissing =
  (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules') -PathType Container)) -or
  (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\.pnpm') -PathType Container)) -or
  (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\research\node_modules') -PathType Container))

if ($dependenciesMissing) {
  Write-Line "项目依赖不完整，正在执行 pnpm install（首次会联网下载，可能需要几分钟）……"
  & pnpm install
  if ($LASTEXITCODE -ne 0) {
    Stop-WithProblem ("依赖安装失败（pnpm install 退出码 " + $LASTEXITCODE + "）。") @(
      "常见原因：网络不通、需要代理、磁盘空间不足。",
      "可以在仓库根目录手动执行 pnpm install 看清完整报错，处理后重试。")
  }
  Write-Ok "项目依赖：已安装"
} else {
  Write-Ok "项目依赖：已安装"
}

# ── [4] 构建产物 ────────────────────────────────────────────────────────────

$distDir = Join-Path $ProjectRoot 'apps\research\dist'
$serverBundle = Join-Path $distDir 'research-server.mjs'
$pageFile = Join-Path $distDir 'public\index.html'

if ((-not (Test-Path -LiteralPath $serverBundle -PathType Leaf)) -or (-not (Test-Path -LiteralPath $pageFile -PathType Leaf))) {
  Write-Line "缺少构建产物，正在执行 pnpm build:research ……"
  & pnpm build:research
  if ($LASTEXITCODE -ne 0) {
    Stop-WithProblem ("构建失败（pnpm build:research 退出码 " + $LASTEXITCODE + "）。") @(
      "可以在仓库根目录手动执行 pnpm build:research 看清完整报错，处理后重试。")
  }
  if (-not (Test-Path -LiteralPath $serverBundle -PathType Leaf)) {
    Stop-WithProblem "构建结束，但没有生成 apps\research\dist\research-server.mjs。" @(
      "请手动执行 pnpm build:research 查看报错后重试。")
  }
  Write-Ok "构建产物：已重新构建（apps\research\dist）"
} else {
  $builtAt = (Get-Item -LiteralPath $serverBundle).LastWriteTime
  Write-Ok ("构建产物：apps\research\dist（构建于 " + $builtAt.ToString('yyyy-MM-dd HH:mm') + "）")
  Write-Line "     需要按最新代码重新构建时，请删除 apps\research\dist 后再启动一次。"
}

# ── [5] 项目配置（.env，可选）───────────────────────────────────────────────

$envFile = Join-Path $ProjectRoot '.env'
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
  $dotEnv = Import-DotEnv -Path $envFile
  if ($dotEnv.Loaded.Count -gt 0) {
    Write-Ok ("已读取 .env：" + ($dotEnv.Loaded -join '、') + "（值不显示）")
  } else {
    Write-Ok "已读取 .env（没有需要补充的变量）"
  }
  if ($dotEnv.Skipped.Count -gt 0) {
    Write-Line ("     已在环境变量里的同名项以环境变量为准：" + ($dotEnv.Skipped -join '、'))
  }
} else {
  Write-Note "没有 .env 文件（可选）：模型凭据也可以直接放在环境变量里。"
}

# ── [6] 模型与凭据 ──────────────────────────────────────────────────────────

$modelProfile = ''
if ($env:RESEARCHPAGE_MODEL) { $modelProfile = ([string]$env:RESEARCHPAGE_MODEL).Trim() }
if ($modelProfile -eq '') { $modelProfile = 'deepseek/deepseek-flash' }
if ($modelProfile -notmatch '^[^/\s]+/[^/\s]+$') {
  Stop-WithProblem ("RESEARCHPAGE_MODEL 的写法不对：需要 provider/model，当前是“" + $modelProfile + "”。") @(
    "例如：deepseek/deepseek-flash（默认值）。",
    "改在 .env 或环境变量里，然后重新双击启动。")
}
$provider = $modelProfile.Split('/')[0]

$credentialEnv = ''
if ($env:RESEARCHPAGE_CREDENTIAL_ENV) { $credentialEnv = ([string]$env:RESEARCHPAGE_CREDENTIAL_ENV).Trim() }
if ($credentialEnv -eq '') { $credentialEnv = $provider.ToUpper() + '_API_KEY' }

$credential = [Environment]::GetEnvironmentVariable($credentialEnv)
if ([string]::IsNullOrEmpty([string]$credential)) {
  Stop-WithProblem ("没有找到模型凭据：环境变量 " + $credentialEnv + " 没有设置，.env 里也没有。") @(
    "任选一种方式提供，然后重新双击启动：",
    "  1) 在仓库根目录新建 .env 文件（可复制 .env.example），写入一行：",
    ("       " + $credentialEnv + "=你的密钥"),
    "     .env 已被 .gitignore 忽略，不会进入版本库。",
    "  2) 或设置用户环境变量（重新打开窗口后生效）：",
    ("       setx " + $credentialEnv + " `"你的密钥`""),
    "凭据只在启动时经环境变量交给本机服务，",
    "脚本不会打印、写入日志或上传它的值。")
}
Write-Ok ("模型：" + $modelProfile)
Write-Ok ("凭据：" + $credentialEnv + " 已设置（值不显示）")

# ── [7] 端口 ────────────────────────────────────────────────────────────────

if ($Port -le 0) {
  $portText = ''
  if ($env:RESEARCHPAGE_PORT) { $portText = ([string]$env:RESEARCHPAGE_PORT).Trim() }
  if ($portText -eq '') {
    $Port = 8791
  } else {
    $parsedPort = 0
    if (-not [int]::TryParse($portText, [ref]$parsedPort)) {
      Stop-WithProblem ("RESEARCHPAGE_PORT 不是整数：“" + $portText + "”。") @(
        "请改成 1024–65535 之间的端口号，例如 8791。")
    }
    $Port = $parsedPort
  }
}
if ($Port -lt 1024 -or $Port -gt 65535) {
  Stop-WithProblem ("端口号不在可用范围：" + $Port) @("请使用 1024–65535 之间的端口号，例如 8791。")
}

$dataDir = Join-Path $ProjectRoot 'researchpage-data'
$pageUrl = "http://127.0.0.1:{0}/" -f $Port

$listenerProcessId = Get-ListenerProcessId -Port $Port
if ($listenerProcessId -ne 0) {
  $servesResearchPage = Test-ResearchPageHttp -Port $Port
  $listenerFacts = Get-ServerFacts -CommandLine (Get-ProcessCommandLine -ProcessId $listenerProcessId)

  $sameDataDir = $false
  if ($listenerFacts.Data -ne '') {
    $rawData = $listenerFacts.Data
    if ([System.IO.Path]::IsPathRooted($rawData)) {
      $listenerDataDir = $rawData
    } else {
      $listenerDataDir = Join-Path $ProjectRoot $rawData
    }
    $sameDataDir = ($listenerDataDir.TrimEnd('\') -ieq $dataDir.TrimEnd('\'))
  }

  if ($servesResearchPage -and $sameDataDir) {
    Write-Ok ("端口 " + $Port + " 上，本项目的服务已经在运行（PID " + $listenerProcessId + "，数据目录就是 " + $dataDir + "）。")
    Write-Line "不重复启动，直接打开浏览器。"
    try {
      Start-Process $pageUrl | Out-Null
      Write-Ok ("已打开：" + $pageUrl)
    } catch {
      Write-Note ("打开浏览器失败，请手动打开：" + $pageUrl)
    }
    Write-Plain ""
    exit 0
  }

  if ($servesResearchPage) {
    $detail = if ($listenerFacts.Data -ne '') { "，它的数据目录是：" + $listenerFacts.Data } else { "（脚本无法确认它的数据目录）" }
    Stop-WithProblem ("端口 " + $Port + " 上已经有另一个 ResearchPage 服务在运行（PID " + $listenerProcessId + "）" + $detail) @(
      "它不是本脚本启动的；脚本不会结束它，也不会再启动第二个。",
      "任选一种方式，用本仓库的数据目录启动：",
      "  1) 先关闭那个服务：关闭它的控制台窗口，",
      ("     或结束 PID " + $listenerProcessId + " 的 node.exe，再双击启动；"),
      "  2) 换端口：在仓库根目录 .env 里写一行",
      "       RESEARCHPAGE_PORT=8792",
      "     再双击启动。",
      "只想继续用那个正在运行的服务，就直接打开：",
      $pageUrl)
  }

  Stop-WithProblem ("端口 " + $Port + " 被别的程序占用（PID " + $listenerProcessId + "），这里启动会失败。") @(
    "脚本不会结束那个进程。任选一种方式：",
    "  1) 换端口：在仓库根目录 .env 里写一行 RESEARCHPAGE_PORT=8792，再双击启动。",
    "  2) 先确认那个进程是谁，再自己关闭它：",
    ("       在 PowerShell 里执行：netstat -ano | findstr :" + $Port),
    "       最后一列就是 PID，可在任务管理器里核对。")
}
Write-Ok ("端口：" + $Port + " 空闲")

# ── [8] 数据目录 ────────────────────────────────────────────────────────────

if (Test-Path -LiteralPath $dataDir -PathType Container) {
  Write-Ok ("数据目录：" + $dataDir)
  Write-Line "     已存在，服务会沿用其中的数据（本脚本不删除、不覆盖）。"
} else {
  Write-Ok ("数据目录：" + $dataDir)
  Write-Line "     首次启动时会自动创建。"
}

# ── [9] 启动服务 ────────────────────────────────────────────────────────────

Write-Plain ""
Write-Line "正在启动服务 ……"
Write-Line ("     端口：" + $Port)
Write-Line ("     数据目录：" + $dataDir)
Write-Line "     日志显示在本窗口；关闭本窗口或按 Ctrl+C 即停止服务。"
Write-Plain ""

$nodeExe = [string]$nodeCommand.Source
$argumentLine = '"{0}" --data "{1}" --port {2}' -f $serverBundle, $dataDir, $Port

try { $Host.UI.RawUI.WindowTitle = '研页 · ResearchPage（关闭此窗口即停止服务）' } catch { }

# 子进程用 .NET 的 ProcessStartInfo 起，而不是 Start-Process -PassThru：
# UseShellExecute=false 让服务继承本窗口的控制台（日志直接显示在这里），
# 而且这个路径下的 ExitCode 是可靠的——本机 PowerShell 5.1 从 Start-Process
# 拿到的对象，读 ExitCode 只会得到空值。
$serverProcess = $null
try {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  if ($nodeExe.ToLower().EndsWith('.exe')) {
    $startInfo.FileName = $nodeExe
    $startInfo.Arguments = $argumentLine
  } else {
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = ('/c "{0}" {1}' -f $nodeExe, $argumentLine)
  }
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $serverProcess = [System.Diagnostics.Process]::Start($startInfo)
} catch {
  Stop-WithProblem ("服务进程未能启动：" + $_.Exception.Message) @(
    "请把上面的报错完整保留下来，它说明系统在启动进程这一步就被拒绝了。")
}
if ($null -eq $serverProcess) {
  Stop-WithProblem "服务进程未能启动。" @("系统没有返回进程句柄，请重试一次。")
}

$startedAt = Get-Date
$ready = $false
$deadline = $startedAt.AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if ($serverProcess.HasExited) { break }
  if (Test-ResearchPageHttp -Port $Port -TimeoutSec 2) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 350
}

if (-not $ready -and -not $serverProcess.HasExited) {
  Write-Plain ""
  Write-Note "服务在 60 秒内还没有就绪。"
  Write-Line "它可能仍在初始化（数据目录较大时会更慢），也可能卡住了。"
  Write-Line "上面的日志是服务自己打印的，请看最后几行。"
  Write-Line ("如果稍后浏览器能打开 " + $pageUrl + "，说明它其实已经就绪。")
  Write-Line "关闭本窗口会同时结束这个服务。"
  Write-Plain ""
  exit 1
}

if (-not $ready) {
  $exitCode = $serverProcess.ExitCode
  $diagnosis = [System.Collections.Generic.List[string]]::new()
  $diagnosis.Add("服务进程在就绪之前退出（退出码 " + $exitCode + "）。")
  $diagnosis.Add("它自己打印的报错就在上面的输出里，请一并保留。")

  if ($exitCode -eq 0) {
    $diagnosis.Add("退出码 0 又没有输出，通常说明服务没有真正跑起来：")
    $diagnosis.Add("项目目录本身可能是 junction / 符号链接（node 把入口解析成真实路径，")
    $diagnosis.Add("与命令里的拼写不一致时就静默结束）。把项目放到真实目录再试。")
  }

  $lockedFile = Test-DataDirLocked -DataDir $dataDir
  if ($null -ne $lockedFile) {
    $diagnosis.Add("数据目录正被另一个进程占用（" + $lockedFile + " 无法独占打开）。")
    $diagnosis.Add("最常见的原因是还有一个 ResearchPage 服务在运行。")
  }

  $others = Get-OtherServerProcesses -ExcludeProcessId $serverProcess.Id
  foreach ($other in $others) {
    $diagnosis.Add("检测到另一个 ResearchPage 服务进程：" + $other)
    $diagnosis.Add("不需要时请关闭它，然后重试。")
  }

  $nowListening = Get-ListenerProcessId -Port $Port
  if ($nowListening -ne 0) {
    $diagnosis.Add("端口 " + $Port + " 现在被 PID " + $nowListening + " 占用：")
    $diagnosis.Add("可能是启动的一瞬间被抢占；换端口（RESEARCHPAGE_PORT）后重试。")
  }

  $diagnosis.Add("如果上面的报错与模型或凭据有关，请检查 .env 里的 " + $credentialEnv)
  $diagnosis.Add("是不是有效密钥，RESEARCHPAGE_MODEL 是不是支持的模型名。")

  Stop-WithProblem "服务未能启动。" $diagnosis
}

$elapsedSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Plain ""
Write-Ok ("服务已就绪（用时 " + $elapsedSeconds + " 秒）：" + $pageUrl)
Write-Line "正在打开默认浏览器……"
try {
  Start-Process $pageUrl | Out-Null
  Write-Ok ("已打开：" + $pageUrl)
} catch {
  Write-Note ("打开浏览器失败，请手动打开：" + $pageUrl)
}
Write-Plain ""
Write-Line "服务运行中：日志继续显示在本窗口；关闭本窗口或按 Ctrl+C 即停止服务。"
Write-Plain ""

$serverProcess.WaitForExit()
$finalCode = $serverProcess.ExitCode
Write-Plain ""
if ($finalCode -eq 0) {
  Write-Ok "服务已停止（正常退出）。"
} else {
  Write-Note ("服务已停止（退出码 " + $finalCode + "）。")
  Write-Line "如果它不是你自己停的，请看上面的日志。"
}
Write-Line "本窗口可以关闭了。"
Write-Plain ""
exit 3
