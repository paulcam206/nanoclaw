# start-nanoclaw.ps1 — Start NanoClaw on Windows
# To stop: Stop-Process -Id (Get-Content nanoclaw.pid)

$projectRoot = $PSScriptRoot
$nodePath = "node"
$pidFile = Join-Path $projectRoot "nanoclaw.pid"

Set-Location $projectRoot

# Stop existing instance if running
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Stopping existing NanoClaw (PID $oldPid)..."
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
}

Write-Host "Starting NanoClaw..."
$logDir = Join-Path $projectRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$process = Start-Process -FilePath $nodePath `
    -ArgumentList (Join-Path $projectRoot "dist\index.js") `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput (Join-Path $logDir "nanoclaw.log") `
    -RedirectStandardError (Join-Path $logDir "nanoclaw.error.log") `
    -PassThru -WindowStyle Hidden

$process.Id | Set-Content $pidFile
Write-Host "NanoClaw started (PID $($process.Id))"
Write-Host "Logs: Get-Content -Wait $logDir\nanoclaw.log"
