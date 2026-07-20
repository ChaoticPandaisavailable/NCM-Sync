$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$defaultExecutable = Join-Path $releaseRoot 'win-unpacked\NCM Sync.exe'
$executable = if ($env:NCMSYNC_PACKAGED_EXE) { [IO.Path]::GetFullPath($env:NCMSYNC_PACKAGED_EXE) } else { $defaultExecutable }
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Packaged executable not found: $executable" }
if (-not $executable.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Packaged executable must be inside release/'
}

$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) "ncmsync-packaged-smoke-$([guid]::NewGuid().ToString('N'))"
$libraryRoot = Join-Path $smokeRoot 'library'
$userDataRoot = Join-Path $smokeRoot 'user-data'
New-Item -ItemType Directory -Force -Path $libraryRoot, $userDataRoot | Out-Null
$oldRoot = $env:CLOUDMUSIC_ROOT
$oldMock = $env:CLOUDMUSIC_MOCK
$process = $null
try {
  $env:CLOUDMUSIC_ROOT = $libraryRoot
  $env:CLOUDMUSIC_MOCK = '1'
  $process = Start-Process -FilePath $executable -ArgumentList @("--user-data-dir=$userDataRoot") -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  $process.Refresh()
  if ($process.HasExited) { throw "Packaged application exited unexpectedly with code $($process.ExitCode)" }
  Write-Output 'PackagedLaunch=True'
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  $env:CLOUDMUSIC_ROOT = $oldRoot
  $env:CLOUDMUSIC_MOCK = $oldMock
  $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedSmokeRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedSmokeRoot).StartsWith('ncmsync-packaged-smoke-')) {
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
