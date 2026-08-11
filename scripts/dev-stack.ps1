<#
.SYNOPSIS
  Boot a local PostgreSQL 16 + TimescaleDB + PostGIS + Redis stack on Windows,
  with no Docker and no administrator rights.

.DESCRIPTION
  Docker Desktop needs admin and WSL2. This provisions the same component
  versions the production compose file pins, entirely inside a user-writable
  directory, so the full test suite can run on a developer laptop.

  Component versions are chosen to MATCH docker-compose.yml:
    PostgreSQL   16.x     (prod image: pg16.6)
    TimescaleDB  2.17.2   (prod image: ts2.17.2)   <- exact match
    PostGIS      3.6.x
    Redis        8.x      (prod image: redis:7.4 — close enough for tests)

  TimescaleDB Windows builds are version-sensitive: a build compiled against a
  newer PG16 minor fails to load with "The specified procedure could not be
  found" (ERROR_PROC_NOT_FOUND). 2.17.2 is known-good against the PG16.10
  binaries EDB publishes. If you bump either, re-verify CREATE EXTENSION.

.EXAMPLE
  ./scripts/dev-stack.ps1 -Install     # one-time download + provision (~500 MB)
  ./scripts/dev-stack.ps1 -Start
  ./scripts/dev-stack.ps1 -Migrate
  ./scripts/dev-stack.ps1 -Test
  ./scripts/dev-stack.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Start,
    [switch]$Stop,
    [switch]$Migrate,
    [switch]$Test,
    [switch]$Status,
    [string]$Root = "D:\karahoca\.toolchain",
    [int]$PgPort = 55432,
    [int]$RedisPort = 56379
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$PgDir      = Join-Path $Root 'pgsql'
$PgData     = Join-Path $Root 'pgdata'
$PgLog      = Join-Path $Root 'pg.log'
$Dl         = Join-Path $Root 'dl'

$TS_VERSION     = '2.17.2'
$POSTGIS_BUNDLE = 'postgis-bundle-pg16-3.6.2x64.zip'
$REDIS_VERSION  = '8.10.0'

$env:DATABASE_URL = "postgres://postgres@127.0.0.1:$PgPort/karahoca"
$env:REDIS_URL    = "redis://127.0.0.1:$RedisPort"

function Info($m) { Write-Host "[dev-stack] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[dev-stack] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[dev-stack] $m" -ForegroundColor Yellow }

function Get-RedisDir {
    Get-ChildItem (Join-Path $Root 'redis') -Directory -Recurse -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'redis-server.exe') } |
        Select-Object -First 1 -ExpandProperty FullName
}

# ---------------------------------------------------------------------------
function Invoke-Install {
    New-Item -ItemType Directory -Force -Path $Dl | Out-Null

    if (-not (Test-Path (Join-Path $PgDir 'bin\postgres.exe'))) {
        Info 'downloading PostgreSQL binaries (~300 MB)'
        Invoke-WebRequest 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1259687' `
            -OutFile "$Dl\pgsql.zip" -UseBasicParsing -TimeoutSec 1800
        Expand-Archive "$Dl\pgsql.zip" -DestinationPath $Root -Force
    }

    if (-not (Test-Path (Join-Path $PgDir 'share\extension\postgis.control'))) {
        Info 'downloading PostGIS bundle (~120 MB)'
        Invoke-WebRequest "https://download.osgeo.org/postgis/windows/pg16/$POSTGIS_BUNDLE" `
            -OutFile "$Dl\postgis.zip" -UseBasicParsing -TimeoutSec 1800
        New-Item -ItemType Directory -Force -Path "$Dl\x\postgis" | Out-Null
        Expand-Archive "$Dl\postgis.zip" -DestinationPath "$Dl\x\postgis" -Force
        $src = (Get-ChildItem "$Dl\x\postgis" -Directory | Select-Object -First 1).FullName
        foreach ($sub in 'bin', 'lib', 'share') {
            if (Test-Path (Join-Path $src $sub)) {
                robocopy (Join-Path $src $sub) (Join-Path $PgDir $sub) /E /NFL /NDL /NJH /NJS /NP | Out-Null
            }
        }
    }

    if (-not (Test-Path (Join-Path $PgDir 'share\extension\timescaledb.control'))) {
        Info "downloading TimescaleDB $TS_VERSION"
        Invoke-WebRequest "https://github.com/timescale/timescaledb/releases/download/$TS_VERSION/timescaledb-postgresql-16-windows-amd64.zip" `
            -OutFile "$Dl\timescaledb.zip" -UseBasicParsing -TimeoutSec 1800
        New-Item -ItemType Directory -Force -Path "$Dl\x\ts" | Out-Null
        Expand-Archive "$Dl\timescaledb.zip" -DestinationPath "$Dl\x\ts" -Force
        $src = Join-Path "$Dl\x\ts" 'timescaledb'
        Get-ChildItem $src -Filter '*.dll' | ForEach-Object { Copy-Item $_.FullName "$PgDir\lib\" -Force }
        Copy-Item "$src\*.sql"     "$PgDir\share\extension\" -Force
        Copy-Item "$src\*.control" "$PgDir\share\extension\" -Force
    }

    if (-not (Get-RedisDir)) {
        Info "downloading Redis $REDIS_VERSION"
        Invoke-WebRequest "https://github.com/redis-windows/redis-windows/releases/download/$REDIS_VERSION/Redis-$REDIS_VERSION-Windows-x64-msys2.zip" `
            -OutFile "$Dl\redis.zip" -UseBasicParsing -TimeoutSec 900
        Expand-Archive "$Dl\redis.zip" -DestinationPath (Join-Path $Root 'redis') -Force
    }

    if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
        Info 'initialising the cluster'
        & "$PgDir\bin\initdb.exe" -D $PgData -U postgres --auth-local=trust --auth-host=trust `
            --encoding=UTF8 --locale=C | Out-Null

        # timescaledb MUST be preloaded; max_locks_per_transaction has to be
        # raised because every hypertable chunk takes a lock.
        @"

# ---- KaraHoca local dev cluster ----
port = $PgPort
listen_addresses = '127.0.0.1'
shared_preload_libraries = 'timescaledb'
timescaledb.telemetry_level = off
max_locks_per_transaction = 256
shared_buffers = 512MB
work_mem = 16MB
maintenance_work_mem = 256MB
max_wal_size = 2GB
timezone = 'UTC'
"@ | Set-Content (Join-Path $PgData 'postgresql.auto.conf') -Encoding ascii
    }

    Ok 'install complete'
}

# ---------------------------------------------------------------------------
function Invoke-Start {
    if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) { throw 'Not installed. Run with -Install first.' }

    if (-not (Test-NetConnection 127.0.0.1 -Port $PgPort -WarningAction SilentlyContinue).TcpTestSucceeded) {
        Info 'starting PostgreSQL'
        # pg_ctl must not inherit this shell's stdout, or the console blocks on
        # the detached postmaster's handle for as long as the server lives.
        $p = Start-Process "$PgDir\bin\pg_ctl.exe" `
            -ArgumentList @('-D', "`"$PgData`"", '-l', "`"$PgLog`"", '-w', '-t', '40', 'start') `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput "$Root\ctl.out" -RedirectStandardError "$Root\ctl.err"
        $p.WaitForExit(60000) | Out-Null
    }

    $redisDir = Get-RedisDir
    if (-not (Test-NetConnection 127.0.0.1 -Port $RedisPort -WarningAction SilentlyContinue).TcpTestSucceeded) {
        Info 'starting Redis'
        # Flags, not a config file: the msys2 build resolves paths POSIX-style
        # and mangles a Windows absolute path into a relative one.
        Start-Process "$redisDir\redis-server.exe" `
            -ArgumentList '--port', "$RedisPort", '--bind', '127.0.0.1', '--appendonly', 'no',
                          '--maxmemory', '256mb', '--maxmemory-policy', 'allkeys-lru' `
            -WorkingDirectory $redisDir -WindowStyle Hidden `
            -RedirectStandardOutput "$Root\redis.log" -RedirectStandardError "$Root\redis.err"
        Start-Sleep -Seconds 2
    }

    $exists = & "$PgDir\bin\psql.exe" -h 127.0.0.1 -p $PgPort -U postgres -d postgres -t -A `
        -c "SELECT 1 FROM pg_database WHERE datname='karahoca'"
    if ($exists -ne '1') {
        Info 'creating database karahoca'
        & "$PgDir\bin\createdb.exe" -h 127.0.0.1 -p $PgPort -U postgres karahoca
    }

    Invoke-Status
}

function Invoke-Stop {
    Info 'stopping'
    Start-Process "$PgDir\bin\pg_ctl.exe" -ArgumentList @('-D', "`"$PgData`"", '-m', 'fast', '-w', 'stop') `
        -Wait -WindowStyle Hidden -RedirectStandardOutput "$Root\ctl.out" -RedirectStandardError "$Root\ctl.err"
    Get-Process redis-server -ErrorAction SilentlyContinue | Stop-Process -Force
    Ok 'stopped'
}

function Invoke-Status {
    $pg    = (Test-NetConnection 127.0.0.1 -Port $PgPort    -WarningAction SilentlyContinue).TcpTestSucceeded
    $redis = (Test-NetConnection 127.0.0.1 -Port $RedisPort -WarningAction SilentlyContinue).TcpTestSucceeded
    Write-Host ""
    Write-Host ("  PostgreSQL  {0}  {1}" -f ($(if ($pg) { 'UP  ' } else { 'DOWN' })), $env:DATABASE_URL)
    Write-Host ("  Redis       {0}  {1}" -f ($(if ($redis) { 'UP  ' } else { 'DOWN' })), $env:REDIS_URL)
    if ($pg) {
        $v = & "$PgDir\bin\psql.exe" -h 127.0.0.1 -p $PgPort -U postgres -d karahoca -t -A `
            -c "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension" 2>$null
        Write-Host "  extensions  $v"
    }
    Write-Host ""
}

function Invoke-Migrate {
    Push-Location (Join-Path $RepoRoot 'db')
    try {
        if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund --loglevel=error }
        node migrate.mjs --seed
    } finally { Pop-Location }
}

function Invoke-Test {
    Push-Location (Join-Path $RepoRoot 'db')
    try { node tests\run.mjs; $sql = $LASTEXITCODE } finally { Pop-Location }

    Push-Location (Join-Path $RepoRoot 'apps\api')
    try {
        if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund --loglevel=error }
        npm run test:e2e
        $e2e = $LASTEXITCODE
    } finally { Pop-Location }

    Write-Host ""
    if ($sql -eq 0 -and $e2e -eq 0) { Ok 'ALL TESTS PASSED' } else { Warn "sql=$sql e2e=$e2e" }
    exit ([int]($sql -ne 0) + [int]($e2e -ne 0))
}

# ---------------------------------------------------------------------------
if ($Install) { Invoke-Install }
if ($Start)   { Invoke-Start }
if ($Migrate) { Invoke-Migrate }
if ($Test)    { Invoke-Test }
if ($Stop)    { Invoke-Stop }
if ($Status -or -not ($Install -or $Start -or $Stop -or $Migrate -or $Test)) { Invoke-Status }
