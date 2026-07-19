param(
  [string]$InstallerPath = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
if (-not $InstallerPath) {
  $version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
  $InstallerPath = Join-Path $releaseRoot "NCMSync-$version-Setup.exe"
}
$installer = [IO.Path]::GetFullPath($InstallerPath)
$installRoot = [IO.Path]::GetFullPath((Join-Path $releaseRoot 'install-smoke\NCMSync'))

if (-not $installer.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer must be located inside the project release directory.'
}
if (-not $installRoot.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer smoke-test path is outside the release directory.'
}
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }
if (Test-Path -LiteralPath $installRoot) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force
}

$install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -ne 0) { throw "Installer exit code: $($install.ExitCode)" }
$installedExe = Join-Path $installRoot 'NCM Sync.exe'
if (-not (Test-Path -LiteralPath $installedExe)) { throw 'Installed executable was not found.' }

try {
  $env:NCMSYNC_PACKAGED_EXE = $installedExe
  & npm.cmd run test:packaged
  if ($LASTEXITCODE -ne 0) { throw "Installed-app smoke-test exit code: $LASTEXITCODE" }
} finally {
  Remove-Item Env:NCMSYNC_PACKAGED_EXE -ErrorAction SilentlyContinue
  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'Uninstall*.exe' | Select-Object -First 1
  if ($uninstaller) {
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exit code: $($uninstall.ExitCode)" }
  }
}

Start-Sleep -Milliseconds 800
$remaining = if (Test-Path -LiteralPath $installRoot) { @(Get-ChildItem -LiteralPath $installRoot -Force -Recurse) } else { @() }
if ($remaining.Count) { throw "$($remaining.Count) files or directories remain after uninstall." }

Write-Output 'InstallerSmoke=True'
