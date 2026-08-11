<#
.SYNOPSIS
  Start the whole KaraHoca system locally: database, cache, API and dashboard.

.DESCRIPTION
  Wraps dev-stack.ps1 (Postgres + Redis) and then launches the API and the web
  dashboard, each in its own window so you can read the logs and stop them with
  Ctrl+C.

  Secrets are generated ONCE into .env.dev.local (git-ignored) and reused on
  every subsequent run. That matters: INGEST_KEY_SECRET envelope-encrypts each
  session's HMAC key, so regenerating it on every start would invalidate every
  live tracking session and force each driver to re-claim.

.EXAMPLE
  ./scripts/dev-run.ps1 -Reset     # wipe test clutter, reseed, create the admin
  ./scripts/dev-run.ps1            # just start everything
  ./scripts/dev-run.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Reset,
    [switch]$Stop,
    # Bind to all interfaces so a physical Android phone on the same Wi-Fi can
    # reach the API. Off by default: loopback-only is the safer default on a
    # laptop that travels between untrusted networks.
    [switch]$Lan,
    # Show the API and dashboard in their own console windows instead of
    # logging to .logs/. Nicer interactively; breaks output redirection.
    [switch]$Windows,
    [string]$AdminEmail    = 'admin@karahoca.local',
    [string]$AdminPassword = 'KaraHoca!Dev2026',
    [int]$ApiPort = 4000,
    [int]$WebPort = 3000,
    [string]$Root = 'D:\karahoca\.toolchain'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile  = Join-Path $RepoRoot '.env.dev.local'
$PgBin    = Join-Path $Root 'pgsql\bin'

function Info($m) { Write-Host "[dev-run] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[dev-run] $m" -ForegroundColor Green }

# ---------------------------------------------------------------------------
if ($Stop) {
    Info 'stopping API and dashboard'

    # Resolve by port owner rather than by command-line pattern. Node is invoked
    # with forward slashes in some launchers and backslashes in others, and
    # `next dev` forks a differently-named child — matching text missed both.
    # The node.exe guard keeps this from killing an unrelated port squatter.
    foreach ($port in @($ApiPort, $WebPort)) {
        Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            ForEach-Object {
                $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
                if ($p -and $p.ProcessName -in @('node', 'next-server')) {
                    Info "  killing $($p.ProcessName) (pid $($p.Id)) on port $port"
                    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                }
            }
    }

    # The -NoExit host windows the script spawned would otherwise linger.
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'ADMIN_EMAIL=|NEXT_PUBLIC_API_URL=' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    & (Join-Path $PSScriptRoot 'dev-stack.ps1') -Stop -Root $Root
    Ok 'stopped'
    return
}

# ---- 1. Secrets, generated once and persisted -----------------------------
if (-not (Test-Path $EnvFile)) {
    Info 'generating development secrets into .env.dev.local'
    # Instance API, not the static GetBytes(int): that static only exists on
    # .NET 5+, and this script has to run under Windows PowerShell 5.1 too.
    function NewSecret {
        $bytes = New-Object byte[] 48
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        [Convert]::ToBase64String($bytes)
    }
    @(
        "JWT_USER_SECRET=$(NewSecret)"
        "JWT_DRIVER_SECRET=$(NewSecret)"
        "INGEST_KEY_SECRET=$(NewSecret)"
    ) | Set-Content $EnvFile -Encoding ascii
}
Get-Content $EnvFile | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
}

# ---- 2. Database + cache ---------------------------------------------------
& (Join-Path $PSScriptRoot 'dev-stack.ps1') -Start -Root $Root | Out-Null

$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:55432/karahoca'
$env:REDIS_URL    = 'redis://127.0.0.1:56379'

if ($Reset) {
    Info 'dropping and recreating the database'
    & "$PgBin\dropdb.exe"   -h 127.0.0.1 -p 55432 -U postgres --if-exists --force karahoca
    & "$PgBin\createdb.exe" -h 127.0.0.1 -p 55432 -U postgres karahoca
    Push-Location (Join-Path $RepoRoot 'db')
    try { node migrate.mjs --seed } finally { Pop-Location }
}

# ---- 3. API ----------------------------------------------------------------
Push-Location (Join-Path $RepoRoot 'apps\api')
try {
    if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund --loglevel=error }
    if (-not (Test-Path 'dist\main.js')) { Info 'building the API'; npm run build }
} finally { Pop-Location }

# The admin is only created when kh.users is empty, so this is a no-op unless
# you passed -Reset (or this is a genuinely fresh database).
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp, Manual -ErrorAction SilentlyContinue |
          Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
          Select-Object -First 1 -ExpandProperty IPAddress)
$bindHost = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
$reachHost = if ($Lan -and $lanIp) { $lanIp } else { '127.0.0.1' }

$apiEnv = @{
    NODE_ENV            = 'development'
    PORT                = "$ApiPort"
    HOST                = $bindHost
    PUBLIC_API_URL      = "http://${reachHost}:$ApiPort"
    CORS_ORIGINS        = "http://localhost:$WebPort,http://127.0.0.1:$WebPort,http://${reachHost}:$WebPort"
    DATABASE_URL        = $env:DATABASE_URL
    REDIS_URL           = $env:REDIS_URL
    JWT_USER_SECRET     = $env:JWT_USER_SECRET
    JWT_DRIVER_SECRET   = $env:JWT_DRIVER_SECRET
    INGEST_KEY_SECRET   = $env:INGEST_KEY_SECRET
    INGEST_REQUIRE_HMAC = 'true'
    ADMIN_EMAIL         = $AdminEmail
    ADMIN_PASSWORD      = $AdminPassword
    # Debug builds carry applicationIdSuffix ".debug", so the QR landing page's
    # intent:// fallback must name that package or it will never open the app
    # you just installed for testing.
    DEEP_LINK_PACKAGE   = 'com.karahoca.tracker.debug'
}
$LogDir = Join-Path $RepoRoot '.logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

<#
  Spawn helper.

  Child processes must NOT inherit this script's stdout. On Windows a
  grandchild inherits a redirected handle even when it gets its own console,
  so `./dev-run.ps1 | tee log` or any CI wrapper would block forever waiting
  on a pipe the long-lived server keeps open. Redirecting each child to its own
  file breaks that chain and lets this script always return.

  -Windows gives visible consoles instead, for interactive use.
#>
function Start-Service-Process($name, $command) {
    if ($Windows) {
        Start-Process powershell -ArgumentList '-NoExit', '-Command', $command | Out-Null
    } else {
        Start-Process powershell `
            -ArgumentList '-NoProfile', '-Command', $command `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "$name.log") `
            -RedirectStandardError  (Join-Path $LogDir "$name.err") | Out-Null
    }
}

$apiCmd = ($apiEnv.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)'" }) -join '; '
$apiCmd += "; Set-Location '$(Join-Path $RepoRoot 'apps\api')'; node dist/main.js"

Info "starting the API on http://${reachHost}:$ApiPort"
Start-Service-Process 'api' $apiCmd

# ---- 4. Dashboard ----------------------------------------------------------
Push-Location (Join-Path $RepoRoot 'apps\web')
try { if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund --loglevel=error } }
finally { Pop-Location }

# `next dev`, not the production build: NEXT_PUBLIC_* is inlined at build time,
# so a prebuilt bundle would keep pointing at whatever API URL it was built
# with. Dev mode reads it at startup.
$webCmd = "`$env:NEXT_PUBLIC_API_URL='http://${reachHost}:$ApiPort/api/v1'; " +
          "`$env:NEXT_TELEMETRY_DISABLED='1'; " +
          "Set-Location '$(Join-Path $RepoRoot 'apps\web')'; npm run dev"

Info "starting the dashboard on http://localhost:$WebPort"
Start-Service-Process 'web' $webCmd

# ---- 5. Wait for health ----------------------------------------------------
Info 'waiting for the API to become healthy…'
$healthy = $false
foreach ($i in 1..60) {
    try {
        if ((Invoke-WebRequest "http://127.0.0.1:$ApiPort/api/v1/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) {
            $healthy = $true; break
        }
    } catch { Start-Sleep -Seconds 1 }
}

Write-Host ""
if ($healthy) {
    Ok 'API is up'
} else {
    Write-Host "[dev-run] API did not respond. Logs: $LogDir\api.log / api.err" -ForegroundColor Yellow
    Get-Content (Join-Path $LogDir 'api.err') -Tail 15 -ErrorAction SilentlyContinue
}
Write-Host ""
Write-Host "  Dashboard   http://localhost:$WebPort"
Write-Host "  API         http://127.0.0.1:$ApiPort/api/v1"
Write-Host "  Swagger     http://127.0.0.1:$ApiPort/api/v1/docs"
Write-Host ""
Write-Host "  Sign in     $AdminEmail"
Write-Host "              $AdminPassword"
Write-Host ""
if ($Lan -and $lanIp) {
    Write-Host "  Phone/LAN   http://${lanIp}:$ApiPort/api/v1" -ForegroundColor Yellow
    Write-Host "              build the APK against it with:"
    Write-Host "              cd android; ./gradlew assembleDebug -PkhApiBaseUrlDebug=http://${lanIp}:$ApiPort/api/v1/"
    Write-Host "              (allow port $ApiPort through Windows Firewall for Private networks)"
    Write-Host ""
} elseif (-not $Lan) {
    Write-Host "  Emulator    already reachable at http://10.0.2.2:$ApiPort/api/v1 (the debug default)"
    Write-Host "  Real phone  re-run with -Lan to bind all interfaces"
    Write-Host ""
}
if (-not $Windows) {
    Write-Host "  Logs        Get-Content .logs\api.log -Wait"
    Write-Host "              Get-Content .logs\web.log -Wait"
    Write-Host ""
}
Write-Host "  Stop with   ./scripts/dev-run.ps1 -Stop"
Write-Host ""
