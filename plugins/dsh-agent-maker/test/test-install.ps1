# =============================================================================
#  Installer end-to-end test for the agent-preset bundle.
#
#  WARNING: THIS FILE MUST STAY PURE ASCII.
#     Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, so any Chinese
#     literal in here would be mis-decoded (and can even break parsing).
#     All Chinese comes from the bundle's own JSON, read explicitly as UTF-8.
#
#  Why a real subprocess: the .cmd a user double-clicks runs
#     powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#  Testing it any other way would test a path nobody uses.
#
#  Run:  powershell -ExecutionPolicy Bypass -File test/test-install.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$results = @()
$pass = 0

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; return }
  # Note: no $(if ...) here on purpose -- PowerShell 5.1 mishandles inline if
  # expressions in some contexts, and a broken assertion helper would silently
  # turn every failure into a pass.
  $msg = $name
  if ($detail) { $msg = $msg + '  <- ' + $detail }
  $script:results += $msg
}

function Read-Utf8($path) {
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

# ---------------------------------------------------------------- sandbox

$sandbox = Join-Path $env:TEMP ('agent-install-test-' + (Get-Random -Minimum 100000 -Maximum 999999))
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

try {
  # -------------------------------------------------------------- build a bundle
  $zip = Join-Path $sandbox 'bundle.zip'
  $expectPath = Join-Path $sandbox 'expect.json'

  & node (Join-Path $here 'make-bundle.mjs') $zip $expectPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'make-bundle.mjs failed' }
  $expect = (Read-Utf8 $expectPath) | ConvertFrom-Json

  $extract = Join-Path $sandbox 'pkg'
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

  # Find the single root folder by enumeration rather than by name: that keeps
  # this ASCII-only script free of Chinese literals, and it double-checks that
  # the archive really has exactly one top-level folder.
  $dirs = @(Get-ChildItem $extract -Directory)
  Check 'archive has exactly one root folder' ($dirs.Count -eq 1) ("found " + $dirs.Count)
  $pkgDir = $dirs[0].FullName
  Check 'root folder name matches the manifest' ($dirs[0].Name -eq $expect.rootName) `
    ("expected '" + $expect.rootName + "' got '" + $dirs[0].Name + "'")

  $cmds = @(Get-ChildItem $pkgDir -Filter '*.cmd')
  Check 'package has exactly one .cmd launcher' ($cmds.Count -eq 1) ("found " + $cmds.Count)
  $cmdPath = $null
  if ($cmds.Count -ge 1) { $cmdPath = $cmds[0].FullName }

  $ps1Path = Join-Path $pkgDir 'install.ps1'
  Check 'package has install.ps1' (Test-Path $ps1Path)

  # ---------------------------------------------------- encoding contracts
  $cmdBytes = [System.IO.File]::ReadAllBytes($cmdPath)
  $nonAscii = @($cmdBytes | Where-Object { $_ -gt 127 })
  Check 'launcher .cmd is pure ASCII (cmd.exe reads the OEM code page)' ($nonAscii.Count -eq 0) `
    ("" + $nonAscii.Count + " non-ASCII bytes")

  $cmdText = Read-Utf8 $cmdPath
  Check 'launcher .cmd actually calls install.ps1' ($cmdText -match 'install\.ps1')
  Check 'launcher .cmd pauses so the user can read the result' ($cmdText -match '(?i)pause')

  $ps1Bytes = [System.IO.File]::ReadAllBytes($ps1Path)
  Check 'install.ps1 carries a UTF-8 BOM' `
    ($ps1Bytes[0] -eq 0xEF -and $ps1Bytes[1] -eq 0xBB -and $ps1Bytes[2] -eq 0xBF) `
    ("first bytes: " + $ps1Bytes[0] + ',' + $ps1Bytes[1] + ',' + $ps1Bytes[2])

  Check 'MANIFEST.json exists' (Test-Path (Join-Path $pkgDir 'MANIFEST.json'))

  # ---------------------------------------------------- fake target "machine"
  $fakeHome = Join-Path $sandbox 'fakehome'
  New-Item -ItemType Directory -Path (Join-Path $fakeHome 'profiles') -Force | Out-Null
  $destRoot = Join-Path $fakeHome '.agent-presets'
  $dest = Join-Path $destRoot $expect.agentId

  # From here on we deliberately run child processes that are *expected* to fail
  # and therefore write to stderr. With ErrorActionPreference = 'Stop', a native
  # command writing to stderr becomes a terminating NativeCommandError and kills
  # the whole test run -- which is exactly what happened the first time.
  # Every step below has its own explicit assertion, so Continue is the right mode.
  $ErrorActionPreference = 'Continue'

  function Run-Install([string[]]$extra) {
    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ps1Path, '-DshHome', $fakeHome)
    if ($extra) { $childArgs += $extra }
    $out = (& powershell @childArgs 2>&1 | Out-String)
    return @{ code = $LASTEXITCODE; out = $out }
  }

  # ---------------------------------------------------- 1) clean install
  $r1 = Run-Install @()
  Check 'clean install exits 0' ($r1.code -eq 0) ("exit " + $r1.code + " | " + $r1.out)

  $destDirs = @()
  if (Test-Path $destRoot) { $destDirs = @(Get-ChildItem $destRoot -Directory) }
  Check 'exactly one agent landed in .agent-presets' ($destDirs.Count -eq 1) `
    ("found " + $destDirs.Count + " entries")
  Check 'agent directory is named after its id' ((Test-Path $dest) -eq $true) ("missing " + $dest)
  Check 'agent.cordis.yml was installed' (Test-Path (Join-Path $dest 'agent.cordis.yml'))
  Check 'preset.yml was installed' (Test-Path (Join-Path $dest 'preset.yml'))
  Check 'bundled skill was installed' (Test-Path (Join-Path $dest 'skills\helper\SKILL.md'))

  $shaBad = @()
  foreach ($k in $expect.files.PSObject.Properties.Name) {
    $target = Join-Path $dest ($k -replace '/', '\')
    if (-not (Test-Path $target)) { $shaBad += ('missing ' + $k); continue }
    $h = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    if ($h -ne ([string]$expect.files.$k).ToLower()) { $shaBad += ('hash ' + $k) }
  }
  Check 'every installed file matches the manifest sha256' ($shaBad.Count -eq 0) ($shaBad -join ', ')

  # ---------------------------------------------------- 2) install twice = no duplicates
  $r2 = Run-Install @()
  Check 'reinstall exits 0' ($r2.code -eq 0) ("exit " + $r2.code)

  $destDirs2 = @(Get-ChildItem $destRoot -Directory)
  Check 'reinstall does not duplicate the agent' ($destDirs2.Count -eq 1) ("found " + $destDirs2.Count)
  $backupRoot = Join-Path $fakeHome 'agent-preset-backups'
  Check 'overwritten agent was backed up' (Test-Path $backupRoot)
  $backups = @()
  if (Test-Path $backupRoot) { $backups = @(Get-ChildItem $backupRoot -Directory) }
  Check 'backup contains exactly one entry' ($backups.Count -eq 1) ("found " + $backups.Count)
  Check 'backup was NOT placed inside .agent-presets (it would show up as a duplicate agent)' `
    ($backups.Count -eq 0 -or -not ($backups[0].FullName.StartsWith($destRoot + '\')))

  # ---------------------------------------------------- 3) -KeepExisting really skips
  $marker = Join-Path $dest 'KEEP-THIS-MARKER.txt'
  Set-Content -LiteralPath $marker -Value 'keep me' -Encoding ASCII
  $r3 = Run-Install @('-KeepExisting')
  Check '-KeepExisting exits 0' ($r3.code -eq 0) ("exit " + $r3.code)
  Check '-KeepExisting left the existing agent untouched' (Test-Path $marker)
  Remove-Item -LiteralPath $marker -Force

  # ---------------------------------------------------- 4) corrupt file is refused
  $victim = Join-Path $pkgDir ('agent\' + $expect.agentId + '\preset.yml')
  $before = Read-Utf8 $victim
  [System.IO.File]::AppendAllText($victim, "`n# tampered`n", (New-Object System.Text.UTF8Encoding($false)))
  $shaBefore = (Get-FileHash -LiteralPath (Join-Path $dest 'preset.yml') -Algorithm SHA256).Hash

  $r4 = Run-Install @()
  Check 'tampered package is refused (non-zero exit)' ($r4.code -ne 0) ("exit " + $r4.code)
  $shaAfter = (Get-FileHash -LiteralPath (Join-Path $dest 'preset.yml') -Algorithm SHA256).Hash
  Check 'tampered package did not touch the installed agent' ($shaBefore -eq $shaAfter)

  # restore the tampered file
  [System.IO.File]::WriteAllText($victim, $before, (New-Object System.Text.UTF8Encoding($false)))
  $r4b = Run-Install @()
  Check 'restored package installs again (exit 0)' ($r4b.code -eq 0) ("exit " + $r4b.code)

  # ---------------------------------------------------- 5) negative control: strip the BOM
  $nobom = Join-Path $pkgDir 'install-nobom.ps1'
  $all = [System.IO.File]::ReadAllBytes($ps1Path)
  $body = $all[3..($all.Length - 1)]
  [System.IO.File]::WriteAllBytes($nobom, $body)
  $nb = (& powershell -NoProfile -ExecutionPolicy Bypass -File $nobom -DshHome $fakeHome 2>&1 | Out-String)
  $nbCode = $LASTEXITCODE
  # This is the negative control for the BOM assertion above: if PowerShell 5.1
  # tolerates a BOM-less UTF-8 script with Chinese in it, then that assertion is
  # not actually protecting anything and we want to know.
  Check 'negative control: BOM-less .ps1 fails on PowerShell 5.1' ($nbCode -ne 0) `
    ("exit " + $nbCode + " -- PS 5.1 tolerated it, so the BOM check proves less than assumed")
  Remove-Item -LiteralPath $nobom -Force

  # ---------------------------------------------------- 6) no DSH home found
  # Point every probe location inside the sandbox so this can never touch a real install.
  $safeToTest = -not (Test-Path 'C:\D-STATION\home') -and -not (Test-Path 'D:\D-STATION\home')
  if ($safeToTest) {
    $saved = @{
      DSH_HOME = $env:DSH_HOME; USERPROFILE = $env:USERPROFILE
      APPDATA = $env:APPDATA; LOCALAPPDATA = $env:LOCALAPPDATA
    }
    try {
      $env:DSH_HOME = Join-Path $sandbox 'nowhere'
      $env:USERPROFILE = Join-Path $sandbox 'nowhere'
      $env:APPDATA = Join-Path $sandbox 'nowhere'
      $env:LOCALAPPDATA = Join-Path $sandbox 'nowhere'
      $bogus = Join-Path $sandbox 'definitely-not-a-home'
      $nb2 = (& powershell -NoProfile -ExecutionPolicy Bypass -File $ps1Path -DshHome $bogus 2>&1 | Out-String)
      $nb2Code = $LASTEXITCODE
      Check 'unknown DSH home is reported as a failure (not a silent success)' ($nb2Code -ne 0) `
        ("exit " + $nb2Code)
      Check 'unknown DSH home message tells the user how to fix it' ($nb2 -match '-DshHome')
    } finally {
      $env:DSH_HOME = $saved.DSH_HOME
      $env:USERPROFILE = $saved.USERPROFILE
      $env:APPDATA = $saved.APPDATA
      $env:LOCALAPPDATA = $saved.LOCALAPPDATA
    }
  } else {
    Write-Host '  (skipped: a real C:\D-STATION\home or D:\D-STATION\home exists, refusing to probe it)'
  }

} finally {
  Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("  passed " + $pass + ", failed " + $results.Count)
if ($results.Count -gt 0) {
  Write-Host ''
  foreach ($f in $results) { Write-Host ('  FAIL  ' + $f) }
  exit 1
}
Write-Host '  all passed'
exit 0
