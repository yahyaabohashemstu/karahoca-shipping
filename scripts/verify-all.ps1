<#
.SYNOPSIS
  Run every verification gate the project has, in dependency order.

.DESCRIPTION
  1. SQL suite        — kh.ingest_points and friends against a real hypertable
  2. API e2e          — the real built server against real Postgres + Redis
  3. Web build        — including the `standalone` output the Dockerfile needs
  4. Android debug    — KSP validates Room @Query and the Hilt graph
  5. Android release  — R8 + resource shrinking + signing (the build drivers get)

  Steps 4-5 are skipped unless JAVA_HOME and ANDROID_HOME are set, so the
  backend gates still run on a machine without an Android toolchain.

  Requires a running stack: ./scripts/dev-stack.ps1 -Start

.EXAMPLE
  ./scripts/verify-all.ps1
  ./scripts/verify-all.ps1 -SkipAndroid
#>
[CmdletBinding()]
param(
    [switch]$SkipAndroid,
    [string]$DatabaseUrl = $(if ($env:DATABASE_URL) { $env:DATABASE_URL } else { 'postgres://postgres@127.0.0.1:55432/karahoca' }),
    [string]$RedisUrl    = $(if ($env:REDIS_URL)    { $env:REDIS_URL }    else { 'redis://127.0.0.1:56379' })
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$env:DATABASE_URL = $DatabaseUrl
$env:REDIS_URL    = $RedisUrl

$results = [ordered]@{}

function Step([string]$name, [scriptblock]$body) {
    Write-Host ""
    Write-Host "=============================================================" -ForegroundColor DarkGray
    Write-Host " $name" -ForegroundColor Cyan
    Write-Host "=============================================================" -ForegroundColor DarkGray
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $body
    $code = $LASTEXITCODE
    $sw.Stop()
    $results[$name] = [pscustomobject]@{
        Ok      = ($code -eq 0)
        Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
}

Step 'SQL suite' {
    Push-Location (Join-Path $RepoRoot 'db')
    try { node tests\run.mjs } finally { Pop-Location }
}

Step 'API e2e' {
    Push-Location (Join-Path $RepoRoot 'apps\api')
    try { npm run test:e2e } finally { Pop-Location }
}

Step 'Web build' {
    Push-Location (Join-Path $RepoRoot 'apps\web')
    try { npm run build } finally { Pop-Location }
}

if (-not $SkipAndroid -and $env:JAVA_HOME -and $env:ANDROID_HOME) {
    Step 'Android debug + release' {
        Push-Location (Join-Path $RepoRoot 'android')
        try {
            & .\gradlew.bat assembleDebug assembleRelease --no-daemon --console=plain
        } finally { Pop-Location }
    }
} else {
    Write-Host "`n(skipping Android: JAVA_HOME/ANDROID_HOME not set)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=============================================================" -ForegroundColor DarkGray
Write-Host " SUMMARY" -ForegroundColor Cyan
Write-Host "=============================================================" -ForegroundColor DarkGray
$failed = 0
foreach ($k in $results.Keys) {
    $r = $results[$k]
    if ($r.Ok) {
        Write-Host ("  PASS  {0,-26} {1,6}s" -f $k, $r.Seconds) -ForegroundColor Green
    } else {
        $failed++
        Write-Host ("  FAIL  {0,-26} {1,6}s" -f $k, $r.Seconds) -ForegroundColor Red
    }
}
Write-Host ""
exit $failed
