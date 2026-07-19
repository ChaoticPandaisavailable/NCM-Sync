param(
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectState = Join-Path $projectRoot '.cloudmusic'
$devData = Join-Path $projectState 'electron-dev'
$locationConfig = Join-Path $devData 'user-data\library-location.json'
$backupRoot = Join-Path $projectState 'reset-backups'
$legacyDatabasePath = Join-Path $projectState 'cloudmusic.sqlite'

try {
  $savedLibrary = (Get-Content -Raw -LiteralPath $locationConfig | ConvertFrom-Json).libraryPath
} catch {
  $savedLibrary = $null
}

if ($savedLibrary) {
  $libraryPath = [IO.Path]::GetFullPath($savedLibrary)
} elseif (Test-Path -LiteralPath $legacyDatabasePath) {
  # 与开发版 resolveRoot() 保持一致：升级前创建的数据库仍位于项目目录时，
  # 应优先重置它，不能误去用户“音乐”目录查找一个不存在的数据库。
  $libraryPath = $projectRoot
} else {
  try {
    $musicFolder = [Environment]::ExpandEnvironmentVariables(
      (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name 'My Music').'My Music'
    )
  } catch {
    $musicFolder = $null
  }
  if (-not $musicFolder) { $musicFolder = Join-Path $env:USERPROFILE 'Music' }
  $libraryPath = [IO.Path]::GetFullPath((Join-Path $musicFolder 'music library'))
}

$databasePath = Join-Path $libraryPath '.cloudmusic\cloudmusic.sqlite'
$temporaryDatabasePath = "$databasePath.tmp"

if ($DryRun) {
  Write-Host '[DRY RUN] 不会修改任何文件。'
  Write-Host "项目目录：$projectRoot"
  Write-Host "当前音乐库：$libraryPath"
  Write-Host "将备份并移除：$databasePath"
  Write-Host "将移除临时库：$temporaryDatabasePath"
  Write-Host "将移除开发缓存：$devData"
  Write-Host "将保留：$(Join-Path $libraryPath 'songs') 以及所有现有音乐和歌单文件夹"
  exit 0
}

if (Get-NetTCPConnection -State Listen -LocalPort 5173,37891 -ErrorAction SilentlyContinue) {
  Write-Error '检测到开发服务仍在运行。请先在 npm run dev 的终端按 Ctrl+C，确认退出后再运行本脚本。'
  exit 2
}

if (-not $Yes) {
  Write-Host ''
  Write-Host '即将重置 NCM Sync 的开发环境应用状态：'
  Write-Host '  - SQLite 配置、Cookie、歌单映射和任务状态'
  Write-Host '  - Electron 开发缓存和登录会话'
  Write-Host ''
  Write-Host '不会删除 songs、现有 MP3 或歌单文件夹。'
  Write-Host '当前 SQLite 数据库会先备份到项目的 .cloudmusic\reset-backups。'
  $confirmation = Read-Host '请输入 RESET 确认'
  if ($confirmation -cne 'RESET') {
    Write-Host '已取消，未修改任何数据。'
    exit 0
  }
}

if (Test-Path -LiteralPath $databasePath) {
  $backupDirectory = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  $backupPath = Join-Path $backupDirectory 'cloudmusic.sqlite'
  Move-Item -LiteralPath $databasePath -Destination $backupPath
  Write-Host "数据库已备份到：$backupPath"
}

if (Test-Path -LiteralPath $temporaryDatabasePath) {
  Remove-Item -LiteralPath $temporaryDatabasePath -Force
}

$resolvedDevData = [IO.Path]::GetFullPath($devData)
if (-not $resolvedDevData.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝删除项目目录之外的开发缓存：$resolvedDevData"
}
if (Test-Path -LiteralPath $resolvedDevData) {
  Remove-Item -LiteralPath $resolvedDevData -Recurse -Force
}

Write-Host ''
Write-Host '初始化完成。现在运行：npm.cmd run dev'
Write-Host '应用将显示首次使用引导。'
