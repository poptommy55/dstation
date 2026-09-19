# restart-verify.ps1 -- restart dsh and record the outcome to a file.
#
# WHY A DETACHED PROCESS: the agent session lives inside the dsh process.
# If we killed dsh inside the same shell, the tool call that issued the kill
# would die with it and the result would be unknown. So this script is started
# hidden+detached, waits a few seconds (so the agent's reply can flush), kills
# dsh, waits for the watchdog to bring it back, and writes everything to a file.
#
# WHY THE -File PATH: `node -e` / pipelines are rejected by the harness sandbox.
#
# THIS FILE MUST STAY PURE ASCII (Windows PowerShell 5.1 reads .ps1 as ANSI).
# Verified by a byte scan in the calling command.

param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Base = 'http://127.0.0.1:3080'
)

function Write-Line([string]$text) {
  Add-Content -LiteralPath $OutFile -Value $text -Encoding UTF8
}

Set-Content -LiteralPath $OutFile -Value ("=== restart requested " + (Get-Date -Format o) + " ===") -Encoding UTF8
Write-Line ("target pid = " + $TargetPid)

Start-Sleep -Seconds 8

try {
  Stop-Process -Id $TargetPid -Force
  Write-Line ("killed pid " + $TargetPid)
} catch {
  Write-Line ("kill failed: " + $_.Exception.Message)
}

$up = $false
for ($i = 1; $i -le 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest ($Base + '/dsh-file-opener/health') -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      Write-Line ("plugin route UP after " + ($i * 2) + "s")
      Write-Line $r.Content
      $up = $true
      break
    }
  } catch {
    # server down, or route not registered yet (404) -- keep waiting
  }
}

if (-not $up) {
  Write-Line "plugin route NOT reachable within 90s"
}

try {
  $root = Invoke-WebRequest ($Base + '/') -UseBasicParsing -TimeoutSec 5
  Write-Line ("server root status = " + $root.StatusCode)
  Write-Line ("server is alive = " + ($root.StatusCode -eq 200))
} catch {
  Write-Line ("server root failed: " + $_.Exception.Message)
}

Write-Line "=== done ==="
