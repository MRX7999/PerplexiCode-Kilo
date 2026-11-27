# PerplexiCode (Kilo Edition) installer for Windows: Antigravity IDE, VS Code, Cursor, Windsurf.
#
#   irm https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/scripts/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/scripts/install.ps1))) -Ide code
#
# Parameters:
#   -Ide         antigravity | code | cursor | windsurf | all   (default: antigravity)
#   -Version     vX.Y.Z or latest                               (default: latest)
#   -Vsix        path to a local VSIX instead of downloading
#   -Sha256Sums  path to SHA256SUMS.txt when verifying a local VSIX
param(
  [ValidateSet('antigravity', 'code', 'cursor', 'windsurf', 'all')]
  [string]$Ide = 'antigravity',
  [string]$Version = 'latest',
  [string]$Vsix = '',
  [string]$Sha256Sums = ''
)

$ErrorActionPreference = 'Stop'
$Repo = 'MRX7999/PerplexiCode-Kilo'
$Asset = 'perplexicode-kilo.vsix'
$SumsAsset = 'SHA256SUMS.txt'
$ExtensionId = 'MRX7999.perplexicode-kilo'

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

function Assert-VsixSha256([string]$TargetFile, [string]$SumsPath, [string]$AssetName) {
  if (-not (Test-Path $SumsPath)) { throw "SHA256SUMS file not found: $SumsPath" }
  $Expected = $null
  foreach ($line in (Get-Content -Path $SumsPath)) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    $parts = $trimmed -split '\s+', 2
    if ($parts.Count -lt 2) { continue }
    $hashCandidate = $parts[0].ToLowerInvariant()
    $nameCandidate = ($parts[1] -replace '^[\*\.\/]+', '')
    if ($nameCandidate -eq $AssetName -and $hashCandidate -match '^[0-9a-f]{64}$') {
      $Expected = $hashCandidate
      break
    }
  }
  if (-not $Expected) { throw "Entry for $AssetName not found in $SumsPath" }
  $Actual = (Get-FileHash -Path $TargetFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    throw "SHA256 mismatch for ${AssetName}: expected $Expected, got $Actual"
  }
  Write-Info "SHA256 verified: $Actual"
}

try {
  if ($Vsix) {
    if (-not (Test-Path $Vsix)) { throw "VSIX not found: $Vsix" }
    $File = (Resolve-Path $Vsix).Path
    if ($Sha256Sums) {
      Assert-VsixSha256 -TargetFile $File -SumsPath $Sha256Sums -AssetName ([System.IO.Path]::GetFileName($File))
    }
  } else {
    if ($env:PERPLEXICODE_RELEASE_BASE_URL) {
      $BaseUrl = $env:PERPLEXICODE_RELEASE_BASE_URL.TrimEnd('/')
    } elseif ($Version -eq 'latest') {
      $BaseUrl = "https://github.com/$Repo/releases/latest/download"
    } else {
      if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
      $BaseUrl = "https://github.com/$Repo/releases/download/$Version"
    }
    $Url = "$BaseUrl/$Asset"
    $SumsUrl = "$BaseUrl/$SumsAsset"
    $File = Join-Path $WorkDir $Asset
    $SumsFile = Join-Path $WorkDir $SumsAsset
    Write-Info "Downloading $Url"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
    Invoke-WebRequest -Uri $SumsUrl -OutFile $SumsFile -UseBasicParsing
    Assert-VsixSha256 -TargetFile $File -SumsPath $SumsFile -AssetName $Asset
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
  Write-Info 'If the old PerplexiCode (perplexicode.perplexicode) is installed, PerplexiCode Kilo offers to import its accounts after the reload.'
}
finally {
  Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
}
