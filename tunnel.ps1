# tunnel.ps1 — 一键把本机服务发布到公网（Cloudflare 免费隧道，免注册免域名）
# 用法：双击 tunnel.bat，或在 PowerShell 里执行 .\tunnel.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$port = if ($env:PORT) { $env:PORT } else { 8787 }
$token = ""
if (Test-Path "config.json") {
  try { $token = (Get-Content "config.json" -Raw | ConvertFrom-Json).syncToken } catch { }
}

Write-Host ""
Write-Host "  Novel · 公网隧道" -ForegroundColor DarkYellow
Write-Host ""

# 1) 本机服务
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "  [1/2] 本机服务已在运行（端口 $port）" -ForegroundColor DarkGray
} else {
  Write-Host "  [1/2] 启动本机服务 ..." -ForegroundColor DarkGray
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

# 2) cloudflared
$cf = @(
  (Join-Path $PSScriptRoot "cloudflared.exe"),
  (Join-Path $PSScriptRoot "..\..\work\tools\cloudflared.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $cf) {
  Write-Host ""
  Write-Host "  没找到 cloudflared.exe。" -ForegroundColor Red
  Write-Host "  下载它（约 53MB）放到这个目录再运行本脚本：" -ForegroundColor DarkGray
  Write-Host "  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -ForegroundColor DarkGray
  Write-Host ""
  Read-Host "  按回车退出"
  exit 1
}

$dataDir = Join-Path $PSScriptRoot "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir "tunnel.log"
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "  [2/2] 建立隧道 ..." -ForegroundColor DarkGray
$proc = Start-Process -FilePath $cf `
  -ArgumentList "tunnel", "--url", "http://localhost:$port", "--no-autoupdate", "--logfile", $log `
  -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 800
  if (Test-Path $log) {
    $content = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($content -match "(https://[a-z0-9-]+\.trycloudflare\.com)") { $url = $Matches[1]; break }
  }
}

Write-Host ""
if (-not $url) {
  Write-Host "  隧道没建起来，日志在 data\tunnel.log" -ForegroundColor Red
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  Read-Host "  按回车退出"
  exit 1
}

Write-Host "  公网地址（手机/平板用这个，加到主屏幕即可）：" -ForegroundColor Green
Write-Host ""
Write-Host "    $url/?token=$token" -ForegroundColor White
Write-Host ""
Write-Host "  局域网地址（在家用这个更快）：" -ForegroundColor DarkGray
foreach ($addr in (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" })) {
  Write-Host "    http://$($addr.IPAddress):$port" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  · 这个公网地址每次重启隧道都会变，以本窗口打印的为准。" -ForegroundColor DarkGray
Write-Host "  · 带 ?token= 的链接才有访问权限，别发给别人。" -ForegroundColor DarkGray
Write-Host "  · 按 Ctrl+C 结束隧道。" -ForegroundColor DarkGray
Write-Host ""

try {
  Wait-Process -Id $proc.Id
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "  隧道已关闭。"
}
