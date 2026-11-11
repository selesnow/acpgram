# AcpGram installer for Windows (Windows PowerShell 5.1+ and PowerShell 7).
#
#   irm https://raw.githubusercontent.com/selesnow/acpgram/main/install.ps1 | iex
#
# Installs (or updates) the latest release into %LOCALAPPDATA%\acpgram, adds the `acpgram` command to the user PATH,
# installs a private Node.js 24 if the system one is missing or older (official build from nodejs.org, checksum verified),
# then runs the setup wizard. Settings (.env) and data (data\) are kept on update.
#
# Environment: ACPGRAM_HOME        install dir (default %LOCALAPPDATA%\acpgram)
#              ACPGRAM_VERSION     release tag, e.g. v1.10.0 (default: latest)
#              ACPGRAM_RELEASE_URL where to download the release from (mirror or local test; default GitHub Releases)
#              ACPGRAM_NO_SETUP=1  do not run the setup wizard
#              ACPGRAM_YES=1       answer "yes" to questions (non-interactive)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is much faster without the progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'selesnow/acpgram'
  $NodeMajor = 24
  $AppHome = if ($env:ACPGRAM_HOME) { $env:ACPGRAM_HOME } else { Join-Path $env:LOCALAPPDATA 'acpgram' }

  function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
  function Fail($text) { throw "AcpGram installer: $text" }
  function AskYes($question) {
    if ($env:ACPGRAM_YES -eq '1') { return $true }
    if (-not [Environment]::UserInteractive) { return $false }
    $a = Read-Host "$question [Y/n]"
    return -not ($a -match '^(n|no)$')
  }
  function NodeMajorOf($exe) {
    # no quotes inside the expression: Windows PowerShell 5.1 strips them from native command arguments
    try { return [int](& $exe -p 'parseInt(process.versions.node)' 2>$null) } catch { return 0 }
  }
  function Download($url, $file) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }
  function Sha256($file) { (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower() }
  function ExpectedHash($sumsFile, $name) {
    foreach ($line in Get-Content $sumsFile) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $name) { return $parts[0].ToLower() }
    }
    Fail "no checksum for $name"
  }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("acpgram-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # ---------- Node.js ----------
    $node = $null
    $sys = Get-Command node -ErrorAction SilentlyContinue
    $private = Join-Path $AppHome 'node\node.exe'
    if ($sys -and (NodeMajorOf $sys.Source) -ge $NodeMajor) { $node = $sys.Source }
    elseif ((Test-Path $private) -and (NodeMajorOf $private) -ge $NodeMajor) { $node = $private }
    if (-not $node) {
      $found = if ($sys) { " (found $(& $sys.Source -v))" } else { '' }
      Step "Node.js $NodeMajor+ is required$found"
      if (-not (AskYes "Install a private Node.js $NodeMajor for AcpGram into $AppHome\node?")) { Fail "install Node.js $NodeMajor+ and run the installer again" }
      $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
      Download "$base/SHASUMS256.txt" "$tmp\SHASUMS256.txt"
      $match = Select-String -Path "$tmp\SHASUMS256.txt" -Pattern "node-v[0-9.]+-win-$arch\.zip" | Select-Object -First 1
      if (-not $match) { Fail "no Node.js $NodeMajor build for win-$arch" }
      $zipName = $match.Matches[0].Value
      Write-Host "Downloading $zipName"
      Download "$base/$zipName" "$tmp\$zipName"
      if ((Sha256 "$tmp\$zipName") -ne (ExpectedHash "$tmp\SHASUMS256.txt" $zipName)) { Fail 'Node.js checksum mismatch' }
      # unpack next to the old one (same volume: Move-Item cannot move folders across volumes), then swap
      New-Item -ItemType Directory -Path $AppHome -Force | Out-Null
      $staging = Join-Path $AppHome '.node-new'
      if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
      Expand-Archive -Path "$tmp\$zipName" -DestinationPath $staging -Force
      $unpacked = (Get-ChildItem $staging -Directory | Select-Object -First 1).FullName
      $nodeDir = Join-Path $AppHome 'node'
      if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
      Move-Item -Path $unpacked -Destination $nodeDir
      Remove-Item -Recurse -Force $staging
      $node = $private
    }
    Write-Host "Node.js $(& $node -v): $node"

    # ---------- release ----------
    if ($env:ACPGRAM_VERSION) { $tag = $env:ACPGRAM_VERSION }
    else {
      $tag = (Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'acpgram-installer' }).tag_name
      if (-not $tag) { Fail "could not find the latest release of $Repo" }
    }
    Step "Installing AcpGram $tag into $AppHome"
    $archive = "acpgram-$tag.zip"
    $url = if ($env:ACPGRAM_RELEASE_URL) { $env:ACPGRAM_RELEASE_URL } else { "https://github.com/$Repo/releases/download/$tag" }
    Download "$url/$archive" "$tmp\$archive"
    Download "$url/SHA256SUMS" "$tmp\SHA256SUMS"
    if ((Sha256 "$tmp\$archive") -ne (ExpectedHash "$tmp\SHA256SUMS" $archive)) { Fail 'release checksum mismatch' }
    Expand-Archive -Path "$tmp\$archive" -DestinationPath "$tmp\release" -Force
    $src = Join-Path $tmp 'release\acpgram'
    if (-not (Test-Path "$src\src\main.mjs")) { Fail 'unexpected archive layout' }

    $update = Test-Path (Join-Path $AppHome 'src\main.mjs')
    New-Item -ItemType Directory -Path $AppHome -Force | Out-Null
    # code is replaced, settings (.env), data (data\) and the private Node.js are kept
    foreach ($d in 'src', 'test') { $p = Join-Path $AppHome $d; if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
    Get-ChildItem -Path $src -Force | ForEach-Object { Copy-Item -Path $_.FullName -Destination $AppHome -Recurse -Force }

    # ---------- the acpgram command ----------
    $bin = Join-Path $AppHome 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    # Paths relative to the .cmd itself (%~dp0 = ...\acpgram\bin\): the file stays pure ASCII whatever the install path
    # (non-ASCII folder names would break in the console code page) and the same on every update.
    # ACPGRAM_HOME is passed so that `acpgram update` updates this very installation.
    $nodeRef = if ($node -eq $private) { '"%~dp0..\node\node.exe"' } else { 'node' }
    # `acpgram update` runs the installer right from this batch file, not from node.exe: security software
    # (Defender ASR rules, antivirus) may forbid node.exe to start PowerShell (EPERM). The update branch is a single
    # parenthesized block ending with `exit /b`: cmd.exe parses it whole before running, so the installer may
    # rewrite this very file meanwhile.
    $lines = @(
      '@echo off',
      'rem AcpGram command (created by install.ps1)',
      'setlocal',
      'if not defined ACPGRAM_HOME set "ACPGRAM_HOME=%~dp0.."',
      'if /i "%~1"=="update" (',
      '  echo Updating AcpGram to the latest release...',
      '  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/selesnow/acpgram/main/install.ps1 | iex"',
      '  exit /b',
      ')',
      "$nodeRef --disable-warning=ExperimentalWarning `"%~dp0..\src\cli.mjs`" %*"
    )
    $cmd = ($lines -join "`r`n") + "`r`n"
    $cmdFile = Join-Path $bin 'acpgram.cmd'
    # rewrite only when changed: `acpgram update` runs from this very file, and cmd.exe reads a batch file as it goes
    if (-not (Test-Path $cmdFile) -or [IO.File]::ReadAllText($cmdFile) -ne $cmd) {
      [IO.File]::WriteAllText($cmdFile, $cmd, (New-Object Text.ASCIIEncoding))
    }
    # user PATH through the registry: keeps REG_EXPAND_SZ and references like %USERPROFILE% intact
    $envKey = Get-Item -Path 'HKCU:\Environment'
    $rawPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($rawPath -split ';' | Where-Object { $_ })
    $already = $entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $bin.TrimEnd('\') }
    if (-not $already) {
      Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value ((@($entries) + $bin) -join ';') -Type ExpandString
      # let Explorer and new terminals see the change (setting any user variable broadcasts WM_SETTINGCHANGE)
      [Environment]::SetEnvironmentVariable('ACPGRAM_PATH_UPDATED', '1', 'User')
      [Environment]::SetEnvironmentVariable('ACPGRAM_PATH_UPDATED', $null, 'User')
      Write-Host "Added $bin to the user PATH (open a new terminal to use 'acpgram')"
    }
    $env:Path = "$bin;$env:Path"
    Write-Host "Command: $bin\acpgram.cmd"

    # ---------- setup / restart ----------
    if ($update) {
      Step "Updated to $tag"
      $nssm = Get-Command nssm -ErrorAction SilentlyContinue
      $svc = ''
      # PowerShell 5.1 with ErrorActionPreference=Stop throws on native stderr, hence try/catch
      if ($nssm) { try { $svc = ((& $nssm.Source status acpgram 2>&1) | Out-String) -replace "`0", '' } catch { $svc = '' } }
      if ($svc -match 'SERVICE_') {
        Write-Host "Restart the service to apply the update (terminal as administrator): acpgram service restart"
      }
    }
    if (-not (Test-Path (Join-Path $AppHome '.env')) -and $env:ACPGRAM_NO_SETUP -ne '1') {
      if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
        Write-Host "Tip: to run the bot as a Windows service you need nssm: winget install --id NSSM.NSSM -e"
      }
      Step 'Setup'
      & $node --disable-warning=ExperimentalWarning (Join-Path $AppHome 'src\setup.mjs')
      if ($LASTEXITCODE -ne 0) { Write-Host "Setup did not finish: run 'acpgram setup' later" }
    }

    Step 'Done'
    Write-Host "  acpgram          start the bot"
    Write-Host "  acpgram setup    settings wizard"
    Write-Host "  acpgram service install | status | uninstall   (service install: terminal as administrator)"
    Write-Host "  acpgram update   update to the latest release"
  }
  finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
