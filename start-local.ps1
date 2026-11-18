param([string]$DataDir = (Join-Path $PSScriptRoot 'frontend\data'), [switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$frontend = Join-Path $root 'frontend'
$python = Join-Path $root 'backend\.venv\Scripts\python.exe'
$node = (Get-Command node).Source
$next = Join-Path $frontend 'node_modules\next\dist\bin\next'
if (!(Test-Path -LiteralPath $next)) { throw 'Install the existing frontend dependencies first.' }
if (!(Test-Path -LiteralPath $python)) { throw 'The existing backend/.venv is required.' }
# Normal development uses the main build, never a QA build or live email mode.
Remove-Item Env:STOCK_QA_DIST_DIR -ErrorAction SilentlyContinue
Remove-Item Env:CATALOG_QA_DIST_DIR -ErrorAction SilentlyContinue
$env:TRADE_DATA_DIR = [IO.Path]::GetFullPath($DataDir)
$env:AGENTS_API_URL = 'http://127.0.0.1:8000'
$env:STOCK_EMAIL_MODE = 'mock'
$env:STOCK_INBOUND_AUTHORIZED = 'false'
$env:STOCK_LIVE_SEND_AUTHORIZATION = ''
if (!(Test-Path -LiteralPath (Join-Path $env:TRADE_DATA_DIR 'trade.db'))) { throw 'Initialize the existing frontend database first. This launcher will not create or replace a database.' }
$normalizedDatabase = (Join-Path $env:TRADE_DATA_DIR 'trade.db').Replace('\', '/').ToLowerInvariant()
$sha = [Security.Cryptography.SHA256]::Create()
try { $expectedFingerprint = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedDatabase))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
function Test-Port([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        try { return ($task.Wait(500) -and $client.Connected) } catch [AggregateException] { return $false }
    } finally { $client.Dispose() }
}
function Test-Backend {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8000/health' -TimeoutSec 3
        if ($health.service -ne 'cardboard-package' -or $health.database_fingerprint -ne $expectedFingerprint) { return $false }
        foreach ($capability in @('discovery-scheduler','supplier-catalog','supplier-stock')) {
            if ($health.capabilities -notcontains $capability) { return $false }
        }
        foreach ($route in @('catalog','stock')) {
            try { Invoke-WebRequest "http://127.0.0.1:8000/api/v1/$route/summary" -UseBasicParsing -TimeoutSec 3 | Out-Null; return $false }
            catch { if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { return $false } }
        }
        return $true
    } catch { return $false }
}
if (Test-Port 3000) { throw 'Port 3000 is already in use. Stop the existing frontend through its normal controls before refreshing its build. The backend can remain running.' }
if ((Test-Port 8000) -and !(Test-Backend)) { throw 'Port 8000 serves an outdated or different backend/database. Stop that server through its normal controls. No process or database was replaced.' }
Push-Location $frontend
try {
    & $node (Join-Path $frontend 'scripts\console-build.mjs') --check
    if ($Rebuild -or $LASTEXITCODE -ne 0) {
        Write-Output 'Building the current main frontend (QA output is not used)...'
        & $node (Join-Path $frontend 'scripts\console-build.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed. No stale frontend will be launched.' }
    }
} finally { Pop-Location }
$logs = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
if (!(Test-Port 8000)) {
    $backend = Start-Process -FilePath $python -ArgumentList @((Join-Path $root 'backend\run.py')) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'backend-8000.out.log') -RedirectStandardError (Join-Path $logs 'backend-8000.err.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Backend) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (!$ready) { throw "Backend did not start with the required agent APIs. Inspect $logs\backend-8000.err.log (process $($backend.Id))." }
} else { Write-Output 'Reusing the healthy shared backend on port 8000; its scheduler is not restarted.' }
$web = Start-Process -FilePath $node -ArgumentList @($next, 'start', '--hostname', '127.0.0.1', '--port', '3000') -WorkingDirectory $frontend -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'frontend-3000.out.log') -RedirectStandardError (Join-Path $logs 'frontend-3000.err.log')
Write-Output "Admin: http://localhost:3000/console/admin/agents (process $($web.Id))"
Write-Output "Shared database: $env:TRADE_DATA_DIR\trade.db"
