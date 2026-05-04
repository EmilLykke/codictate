param(
  [ValidateSet('stable', 'canary')]
  [string]$Channel = $(if ($env:CODICTATE_CHANNEL) { $env:CODICTATE_CHANNEL } else { 'stable' }),
  [string]$Version = $env:CODICTATE_VERSION
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppName = if ($Channel -eq 'stable') { 'Codictate' } else { "Codictate-$Channel" }
# Same layout as Electrobun Updater.applyUpdate on Windows (LOCALAPPDATA\identifier\channel\app).
$InstallRelDir = if ($Channel -eq 'canary') {
  'app.codictate.canary/canary/app'
} else {
  'app.codictate/stable/app'
}
$OutputDir = Join-Path $ProjectRoot 'artifacts'
$InnoScript = Join-Path $ProjectRoot 'installer\windows\Codictate.iss'
$IconFile = Join-Path $ProjectRoot 'src\assets\images\MacDocIcon.ico'
$TarballPath = Join-Path $OutputDir "$Channel-win-x64-$AppName.tar.zst"
$StagingRoot = Join-Path $ProjectRoot "build\inno-$Channel-staging"
$SourceDir = Join-Path $StagingRoot $AppName

if (-not $Version) {
  $ConfigPath = Join-Path $ProjectRoot 'electrobun.config.ts'
  $Config = Get-Content -Raw -Path $ConfigPath
  if ($Config -notmatch 'version:\s*"([^"]+)"') {
    throw "Could not read app version from $ConfigPath"
  }
  $Version = $Matches[1]
}

if (-not (Test-Path -Path $TarballPath -PathType Leaf)) {
  throw "Windows app tarball not found: $TarballPath. Run the Windows Electrobun build first."
}

if (-not (Test-Path -Path $IconFile -PathType Leaf)) {
  throw "Windows installer icon not found: $IconFile"
}

if (Test-Path -Path $StagingRoot) {
  Remove-Item -Path $StagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $StagingRoot | Out-Null

tar -xf $TarballPath -C $StagingRoot
if ($LASTEXITCODE -ne 0) {
  throw "Failed to extract Windows app tarball: $TarballPath"
}

if (-not (Test-Path -Path $SourceDir -PathType Container)) {
  throw "Extracted Windows app bundle not found: $SourceDir"
}

$SourceExeName = if (Test-Path -Path (Join-Path $SourceDir 'bin\launcher.exe') -PathType Leaf) {
  'launcher.exe'
} elseif (Test-Path -Path (Join-Path $SourceDir 'bin\launcher') -PathType Leaf) {
  'launcher'
} else {
  $null
}

if (-not $SourceExeName) {
  throw "Windows launcher not found in $(Join-Path $SourceDir 'bin'). Expected launcher.exe or launcher."
}

if (-not (Test-Path -Path $OutputDir -PathType Container)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$Iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if ($Iscc) {
  $IsccPath = $Iscc.Source
} else {
  $Candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  $Candidate = $Candidates | Where-Object { Test-Path -Path $_ -PathType Leaf } | Select-Object -First 1
  if (-not $Candidate) {
    throw 'ISCC.exe not found. Install Inno Setup 6 and ensure ISCC.exe is on PATH.'
  }
  $IsccPath = $Candidate
}

$env:CODICTATE_INNO_APP_NAME = $AppName
$env:CODICTATE_INNO_APP_VERSION = $Version
$env:CODICTATE_INNO_CHANNEL = $Channel
$env:CODICTATE_INNO_INSTALL_RELDIR = $InstallRelDir
$env:CODICTATE_INNO_SOURCE_DIR = $SourceDir
$env:CODICTATE_INNO_OUTPUT_DIR = $OutputDir
$env:CODICTATE_INNO_ICON_FILE = $IconFile
$env:CODICTATE_INNO_SOURCE_EXE_NAME = $SourceExeName

Write-Host "Building Inno installer for $AppName $Version from $SourceDir"
Set-Location $ProjectRoot
& $IsccPath $InnoScript
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE"
}
