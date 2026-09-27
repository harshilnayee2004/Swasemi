# start-all.ps1 - One-click local development launcher for Swasemi
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) { $ProjectRoot = (Get-Item .).FullName }
Set-Location $ProjectRoot

$BackendDir  = Join-Path $ProjectRoot "backend"
$FrontendDir = Join-Path $ProjectRoot "frontend"
$VenvPython  = Join-Path $BackendDir "venv\Scripts\python.exe"
$VenvActivate = Join-Path $BackendDir "venv\Scripts\Activate.ps1"
$BackendPort = 8000
$HealthUrl   = "http://127.0.0.1:$BackendPort/health"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "        Swasemi Fleet Platform - One-Click Launcher       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# ── 0. Kill any stale Swasemi processes ──────────────────────────────
Write-Host "`n[0/4] Cleaning up any stale Swasemi processes..." -ForegroundColor Yellow

# Kill old simulator
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*simulator.py*" -and $_.CommandLine -like "*Swasemi*"
} | ForEach-Object {
    Write-Host "  Stopping old simulator (PID $($_.ProcessId))" -ForegroundColor DarkGray
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# Kill any uvicorn running FROM the Swasemi venv specifically
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*uvicorn*" -and $_.CommandLine -like "*Swasemi*"
} | ForEach-Object {
    Write-Host "  Stopping old backend (PID $($_.ProcessId))" -ForegroundColor DarkGray
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1
Write-Host "[OK] Cleanup done." -ForegroundColor Green

# ── 1. Start Docker (PostgreSQL + Redis) ─────────────────────────────
Write-Host "`n[1/4] Starting Docker services (PostgreSQL & Redis)..." -ForegroundColor Yellow
try {
    & docker compose up -d postgres redis
    if ($LASTEXITCODE -ne 0) { throw "docker compose exited with code $LASTEXITCODE" }
} catch {
    Write-Host "`n[ERROR] Docker failed to start." -ForegroundColor Red
    Write-Host "Please open Docker Desktop and wait until it says 'Engine running', then try again.`n" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] PostgreSQL :5433 and Redis :6379 are running." -ForegroundColor Green

# ── 2. Start FastAPI Backend ──────────────────────────────────────────
Write-Host "`n[2/4] Launching FastAPI Backend on port $BackendPort..." -ForegroundColor Yellow

$BackendCmd = @"
`$Host.UI.RawUI.WindowTitle = 'Swasemi - Backend (FastAPI :$BackendPort)';
Set-Location '$BackendDir';
& '$VenvActivate';
python -m uvicorn main:app --host 127.0.0.1 --port $BackendPort
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $BackendCmd

# Poll health endpoint
$TimeoutSeconds = 30
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$BackendReady = $false

Write-Host "  Waiting for backend to be ready..." -ForegroundColor DarkCyan
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200 -and ($r.Content | ConvertFrom-Json).status -eq "ok") {
            $BackendReady = $true
            break
        }
    } catch { }
    Write-Host "  ... ($([int]$sw.Elapsed.TotalSeconds)s / ${TimeoutSeconds}s)" -ForegroundColor DarkGray
}

if (-not $BackendReady) {
    Write-Host "`n[ERROR] Backend did not respond within $TimeoutSeconds seconds." -ForegroundColor Red
    Write-Host "Check the Backend window for errors. Common causes:" -ForegroundColor Yellow
    Write-Host "  - Another app is already using port $BackendPort (e.g. cctv_backend Docker container)" -ForegroundColor Yellow
    Write-Host "  - Run: docker stop cctv_backend   and try again." -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Backend is live at $HealthUrl" -ForegroundColor Green

# ── 3. Start React Frontend ───────────────────────────────────────────
Write-Host "`n[3/4] Launching Frontend (Vite :5173)..." -ForegroundColor Yellow

$FrontendCmd = @"
`$Host.UI.RawUI.WindowTitle = 'Swasemi - Frontend (Vite :5173)';
Set-Location '$FrontendDir';
npm run dev
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $FrontendCmd
Write-Host "[OK] Frontend launched at http://localhost:5173/" -ForegroundColor Green

# ── 4. Start Simulator ────────────────────────────────────────────────
Write-Host "`n[4/4] Launching Telemetry Simulator..." -ForegroundColor Yellow

$SimCmd = @"
`$Host.UI.RawUI.WindowTitle = 'Swasemi - Simulator (All Orgs)';
Set-Location '$BackendDir';
& '$VenvActivate';
`$env:SIMULATOR_EMAIL='admin@example.com';
`$env:SIMULATOR_PASSWORD='adminpass';
`$env:SIMULATOR_API_URL='http://127.0.0.1:$BackendPort';
Write-Host 'Starting simulator as Super Admin (sees ALL orgs)...' -ForegroundColor Cyan;
python simulator.py;
Write-Host '`n[Simulator stopped] Press any key to close this window.' -ForegroundColor Yellow;
`$null = `$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
"@

Start-Process powershell -ArgumentList "-NoExit", "-Command", $SimCmd
Write-Host "[OK] Simulator launched (publishes when a trip is active)." -ForegroundColor Green

# ── Summary ───────────────────────────────────────────────────────────
Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "          All services are running!                      " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard    ->  http://localhost:5173/" -ForegroundColor Cyan
Write-Host "  API Docs     ->  http://127.0.0.1:$BackendPort/docs" -ForegroundColor Cyan
Write-Host "  Health       ->  $HealthUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Demo Logins:" -ForegroundColor White
Write-Host "    Org A User   :  usera@example.com    / usera-pass" -ForegroundColor Gray
Write-Host "    Org B User   :  userb@example.com    / userb-pass" -ForegroundColor Gray
Write-Host "    Super Admin  :  admin@example.com    / adminpass" -ForegroundColor Gray
Write-Host ""
Write-Host "  Each service has its own window. Press Ctrl+C there to stop it." -ForegroundColor DarkYellow
Write-Host ""
