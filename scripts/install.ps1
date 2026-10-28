# PerplexiCode (Kilo Edition) installer for Windows: Antigravity IDE, VS Code, Cursor, Windsurf.
#
#   irm https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/scripts/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/scripts/install.ps1))) -Ide code
#
# Parameters:
#   -Ide      antigravity | code | cursor | windsurf | all   (default: antigravity)
#   -Version  vX.Y.Z or latest                               (default: latest)
#   -Vsix     path to a local VSIX instead of downloading
param(
  [ValidateSet('antigravity', 'code', 'cursor', 'windsurf', 'all')]
  [string]$Ide = 'antigravity',
  [string]$Version = 'latest',
  [string]$Vsix = ''
)

$ErrorActionPreference = 'Stop'
$Repo = 'MRX7999/PerplexiCode-Kilo'
$Asset = 'perplexicode-kilo.vsix'
$ExtensionId = 'perplexicode.perplexicode'

function Write-Info([string]$Message) { Write-Host "[perplexicode] $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "[perplexicode] $Message" -ForegroundColor Yellow }

$Editors = [ordered]@{
  antigravity = @{
    Name = 'Antigravity IDE'
    Commands = @('antigravity-ide.cmd', 'antigravity.cmd')
    Paths = @(
      "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd",
      "$env:LOCALAPPDATA\Programs\Antigravity\bin\antigravity.cmd",
      "$env:ProgramFiles\Antigravity IDE\bin\antigravity-ide.cmd"
    )
  }
  code = @{
    Name = 'VS Code'
    Commands = @('code.cmd')
    Paths = @(
      "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
      "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
    )
  }
  cursor = @{
    Name = 'Cursor'
    Commands = @('cursor.cmd')
    Paths = @("$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd")
  }
  windsurf = @{
    Name = 'Windsurf'
    Commands = @('windsurf.cmd')
    Paths = @("$env:LOCALAPPDATA\Programs\Windsurf\bin\windsurf.cmd")
  }
}

function Find-EditorCli($Editor) {
  foreach ($command in $Editor.Commands) {
    $found = Get-Command $command -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
  }
  foreach ($path in $Editor.Paths) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  return $null
}

$Targets = if ($Ide -eq 'all') { @($Editors.Keys) } else { @($Ide) }
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("perplexicode-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $WorkDir | Out-Null

try {
  if ($Vsix) {
    if (-not (Test-Path $Vsix)) { throw "VSIX not found: $Vsix" }
    $File = (Resolve-Path $Vsix).Path
  } else {
    if ($Version -eq 'latest') {
      $Url = "https://github.com/$Repo/releases/latest/download/$Asset"
    } else {
      if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
      $Url = "https://github.com/$Repo/releases/download/$Version/$Asset"
    }
    $File = Join-Path $WorkDir $Asset
    Write-Info "Downloading $Url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
  }

  $header = [System.IO.File]::ReadAllBytes($File)[0..1]
  if ($header[0] -ne 0x50 -or $header[1] -ne 0x4B) { throw "Not a VSIX archive: $File" }

  $installed = 0
  foreach ($target in $Targets) {
    $editor = $Editors[$target]
    $cli = Find-EditorCli $editor
    if (-not $cli) {
      if ($Ide -ne 'all') {
        throw "$($editor.Name) CLI not found. Use Extensions view > ... > Install from VSIX... with $File"
      }
      continue
    }
    Write-Info "Installing into $($editor.Name) ($cli)"
    # Antigravity prints a harmless "antigravityAnalytics ... NOT registered" line; trust the exit code.
    $output = & $cli --install-extension $File --force 2>&1
    if ($LASTEXITCODE -ne 0) {
      $output | Select-Object -Last 15 | ForEach-Object { Write-Warn $_ }
      Write-Warn "$($editor.Name): install failed"
      continue
    }
    $listed = & $cli --list-extensions --show-versions 2>$null | Where-Object { $_ -like "$ExtensionId@*" }
    if ($listed) { Write-Info "$($editor.Name): $listed" } else { Write-Info "$($editor.Name): installed" }
    $installed++
  }

  if ($installed -eq 0) { throw 'Nothing was installed.' }
  Write-Info 'Done. Reload the editor window: Ctrl+Shift+P > Developer: Reload Window.'
  Write-Info 'Accounts from PerplexiCode 1.x are kept (same extension ID and storage).'
}
finally {
  Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}
