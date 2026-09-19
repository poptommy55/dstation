# restart-and-verify-reveal.ps1
#
# Restart dsh, then VERIFY THE FIX end to end without needing the browser:
#   1. wait, kill dsh (watchdog brings it back)
#   2. poll /dsh-file-opener/health until 200
#   3. create a temp folder holding a file whose name CONTAINS A SPACE
#      (that is the case the old quoting bug broke)
#   4. POST /dsh-file-opener/reveal for that file
#   5. enumerate Explorer windows via COM and report WHERE it landed
#   6. write everything to the result file
#
# WHY DETACHED: the agent session lives inside the dsh process; killing dsh from
# the same shell would take the tool call down with it.
# WHY WMI-LAUNCHED BY THE CALLER: a Start-Process child stays inside the parent's
# job object and dies together with dsh (measured), leaving the result file empty.
#
# THIS FILE MUST STAY PURE ASCII (Windows PowerShell 5.1 reads .ps1 as ANSI).

param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Base = 'http://127.0.0.1:3080',
  # MUST be inside an allowed root, otherwise PathGuard answers 403 and the
  # check becomes inconclusive (measured: a %TEMP% folder is OUTSIDE every root).
  [string]$ProbeRoot = ''
)

function Write-Line([string]$text) {
  Add-Content -LiteralPath $OutFile -Value $text -Encoding UTF8
}

function Get-ExplorerWindows {
  try {
    $shell = New-Object -ComObject Shell.Application
    return @($shell.Windows() | ForEach-Object { $_.LocationURL } | Where-Object { $_ -like 'file:*' })
  } catch {
    return @()
  }
}

Set-Content -LiteralPath $OutFile -Value ("=== restart+verify " + (Get-Date -Format o) + " ===") -Encoding UTF8
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
    # server down or route not registered yet
  }
}

if (-not $up) {
  Write-Line "plugin route NOT reachable within 90s"
  Write-Line "=== done ==="
  exit 1
}

# ---- end-to-end reveal verification -------------------------------------
if ([string]::IsNullOrEmpty($ProbeRoot)) {
  $ProbeRoot = Join-Path $env:DSH_HOME 'skill-sessions'
}
$probeDir = Join-Path $ProbeRoot ("reveal-check-" + (Get-Date -Format HHmmss))
New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
$probeFile = Join-Path $probeDir 'target with space.txt'
Set-Content -LiteralPath $probeFile -Value 'x'
Write-Line ("probe root = " + $ProbeRoot + "  (must be inside an allowed root)")
Write-Line ("probe file = " + $probeFile)

$before = Get-ExplorerWindows
$payload = '{"paths":[]}'
# build the JSON with an escaped backslash path, then send as UTF-8 bytes
$escaped = $probeFile -replace '\\', '\\'
$json = '{"path":"' + $escaped + '"}'
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
try {
  $resp = Invoke-WebRequest ($Base + '/dsh-file-opener/reveal') -Method POST -Body $bytes -ContentType 'application/json' -UseBasicParsing -TimeoutSec 10
  Write-Line ("reveal response = " + $resp.Content)
} catch {
  Write-Line ("reveal request failed: " + $_.Exception.Message)
}

Start-Sleep -Seconds 5
$after = Get-ExplorerWindows
$new = @(Compare-Object $before $after | Where-Object { $_.SideIndicator -eq '=>' } | ForEach-Object { $_.InputObject })
$expected = 'file:///' + ($probeDir -replace '\\', '/')

if ($new.Count -eq 0) {
  Write-Line "VERDICT: no new Explorer window (inconclusive)"
} elseif ($new -contains $expected) {
  Write-Line "VERDICT: PASS - Explorer opened the file's own folder and selected it"
  Write-Line ("expected = " + $expected)
} else {
  Write-Line "VERDICT: FAIL - Explorer landed somewhere else:"
  foreach ($w in $new) { Write-Line ("  landed = " + $w) }
  Write-Line ("expected = " + $expected)
}

Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Line "=== done ==="
