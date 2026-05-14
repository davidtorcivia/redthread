# End-to-end build for The Info Web.
# Parses the vault, generates JSON indices, builds the static site.
#
# Usage:
#   .\_web\build.ps1                           # use default vault path (this dir)
#   .\_web\build.ps1 -VaultPath "C:\path\to\vault"
#   $env:VAULT_PATH = "..."; .\_web\build.ps1

param(
    [string]$VaultPath = $env:VAULT_PATH,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = Split-Path -Parent $scriptDir

if (-not $VaultPath) {
    $VaultPath = $projectRoot
}
$VaultPath = (Resolve-Path $VaultPath).Path

Write-Host "[build] vault: $VaultPath"
Write-Host "[build] output: $scriptDir\web\dist"

# 1. Parse the vault
Write-Host "[build] (1/2) parsing vault..."
& py -3 "$scriptDir\build\parse_vault.py" --vault $VaultPath --out "$scriptDir\data"
if ($LASTEXITCODE -ne 0) { throw "parse failed" }

# Copy runtime-fetched data into Astro public/. previews.json drives the
# wikilink hover-preview popovers; adjacency.json is the shared dataset
# for /network/, /path/, and every entity page's NetworkGraph widget.
$publicDir = Join-Path $scriptDir 'web\public'
New-Item -ItemType Directory -Force -Path $publicDir | Out-Null
Copy-Item -Force (Join-Path $scriptDir 'data\previews.json') (Join-Path $publicDir 'previews.json')
Copy-Item -Force (Join-Path $scriptDir 'data\adjacency.json') (Join-Path $publicDir 'adjacency.json')

# Clean up any stale per-entity neighborhood JSONs from older builds.
$ngDst = Join-Path $publicDir 'api\neighborhood'
if (Test-Path $ngDst) { Remove-Item -Recurse -Force $ngDst }

# 2. Build Astro + Pagefind
Push-Location "$scriptDir\web"
try {
    if (-not $SkipInstall -and -not (Test-Path 'node_modules')) {
        Write-Host "[build] installing npm deps..."
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    Write-Host "[build] (2/2) building site..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm build failed" }
}
finally {
    Pop-Location
}

Write-Host "[build] done -> $scriptDir\web\dist"
