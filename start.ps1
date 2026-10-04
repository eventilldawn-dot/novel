# start.ps1 — 双击启动（start.bat 会调用它）
param([switch]$NoBrowser)

$ErrorActionPreference = "SilentlyContinue"
$root = $PSScriptRoot
Set-Location $root
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }

Write-Host ""
Write-Host "  Novel · 文字剧情" -ForegroundColor DarkYellow
Write-Host ""

# ---- 1. 找 node（PATH → Codex 自带运行时 → 官方安装目录）----
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = Get-ChildItem "$env:USERPROFILE\.cache\codex-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $node) {
  $node = @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe") |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $node) {
  Write-Host "  找不到 Node.js。" -ForegroundColor Red
  Write-Host "  去 https://nodejs.org 下载安装（一路下一步即可），然后重新双击本图标。" -ForegroundColor DarkGray
  Write-Host ""
  Read-Host "  按回车退出"
  exit 1
}

# ---- 2. 已经在跑就直接打开网页 ----
$running = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "  服务已经在运行了（端口 $port）。" -ForegroundColor Green
  Write-Host "  手机/平板地址：" -ForegroundColor DarkGray
  Write-Host "    https://laptop-am1foeoo.tailaf5498.ts.net/?token=ed673e0e403e73676b0c038b" -ForegroundColor White
  if (-not $NoBrowser) { Start-Process "http://localhost:$port" }
  Start-Sleep -Seconds 2
  exit 0
}

# ---- 3. 启动，并开着这个窗口（关掉窗口 = 停止服务）----
if (-not $NoBrowser) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 3; Start-Process 'http://localhost:$port'"
}

Write-Host "  正在启动 ... 这个窗口不要关，关掉就等于停止服务。" -ForegroundColor DarkGray
Write-Host "  手机/平板地址：" -ForegroundColor DarkGray
Write-Host "    https://laptop-am1foeoo.tailaf5498.ts.net/?token=ed673e0e403e73676b0c038b" -ForegroundColor White
Write-Host ""

& $node "server.js"

Write-Host ""
Write-Host "  服务已停止。" -ForegroundColor DarkGray
Read-Host "  按回车关闭窗口"
