# Developer CI only: installs and removes a build on a disposable Windows runner.
# Never offer this script as an end-user installation or repair step.
$ErrorActionPreference = 'Stop'
$diagnosticRoot = $null
foreach ($basePath in @($env:RUNNER_TEMP, [System.IO.Path]::GetTempPath()) | Where-Object { $_ } | Select-Object -Unique) {
    try {
        $candidate = Join-Path $basePath 'crosschat-windows-install-smoke'
        New-Item -ItemType Directory -Path $candidate -Force -ErrorAction Stop | Out-Null
        $diagnosticRoot = $candidate
        break
    } catch {
        Write-Warning "Installer diagnostics directory unavailable at '$basePath'; trying fallback."
    }
}
if (-not $diagnosticRoot) { Write-Warning 'Installer diagnostics are unavailable; continuing the smoke test without captured output.' }
if ($diagnosticRoot -and $env:GITHUB_OUTPUT) {
    try { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "diagnostics_directory=$diagnosticRoot" -ErrorAction Stop }
    catch { Write-Warning 'Could not publish the installer diagnostics directory to the workflow.' }
}
$setupAttempts = [System.Collections.Generic.List[object]]::new()
$scriptStartedAt = (Get-Date).ToUniversalTime()
$script:lastSetupStartedAt = $null
$installer = Get-ChildItem dist -Filter 'CrossChat-Hub-*-win-x64.exe' | Select-Object -First 1
if (-not $installer) { throw 'NSIS executable missing' }
$appPath = Join-Path $env:LOCALAPPDATA 'Programs\CrossChat Hub\CrossChat Hub.exe'
if (Test-Path -LiteralPath $appPath) { throw 'This test requires a clean disposable Windows runner' }

function Save-SetupAttempts {
    if (-not $diagnosticRoot) { return }
    $setupAttempts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $diagnosticRoot 'setup-attempts.json') -Encoding utf8
}

function Invoke-Setup {
    $attemptNumber = $setupAttempts.Count + 1
    $stdoutPath = if ($diagnosticRoot) { Join-Path $diagnosticRoot "setup-$attemptNumber.stdout.txt" } else { $null }
    $stderrPath = if ($diagnosticRoot) { Join-Path $diagnosticRoot "setup-$attemptNumber.stderr.txt" } else { $null }
    $startedAt = (Get-Date).ToUniversalTime()
    $script:lastSetupStartedAt = $startedAt
    $installerHash = $null
    try { $installerHash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { Write-Warning 'Could not hash the NSIS installer for diagnostics.' }
    $attempt = [ordered]@{
        path = $installer.FullName
        sha256 = $installerHash
        startedAtUtc = $startedAt.ToString('o')
        endedAtUtc = $null
        exitCode = $null
        launchError = $null
        stdoutPath = $stdoutPath
        stderrPath = $stderrPath
    }
    $setupAttempts.Add($attempt)
    try {
        $startParameters = @{
            FilePath = $installer.FullName
            ArgumentList = '/S'
            PassThru = $true
            Wait = $true
        }
        if ($diagnosticRoot) {
            $startParameters.RedirectStandardOutput = $stdoutPath
            $startParameters.RedirectStandardError = $stderrPath
        }
        $setup = Start-Process @startParameters
        $attempt.exitCode = $setup.ExitCode
    } catch {
        $attempt.launchError = $_.Exception.Message
        throw
    } finally {
        $attempt.endedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        try { Save-SetupAttempts } catch { Write-Warning 'Could not save installer attempt metadata.' }
    }
    if ($setup.ExitCode -ne 0) { throw "Silent installation failed with code $($setup.ExitCode)" }
    if (-not (Test-Path -LiteralPath $appPath)) { throw "Installed EXE not found: $appPath" }
}

function Save-FailureDiagnostics {
    if (-not $diagnosticRoot) { Write-Warning 'No diagnostics directory is available.'; return }
    $failedAt = (Get-Date).ToUniversalTime()
    $eventStart = if ($script:lastSetupStartedAt) { $script:lastSetupStartedAt.AddSeconds(-2) } else { $scriptStartedAt }
    $events = @()
    $knownPaths = @($installer.FullName, $appPath) | Where-Object { $_ }
    $knownNames = @($knownPaths | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    $allowedEventFields = @(
        'FaultingApplicationName', 'FaultingApplicationPath', 'ApplicationName', 'ApplicationPath',
        'AppName', 'AppPath', 'FaultingModuleName', 'FaultingModulePath', 'ExceptionCode',
        'FaultingOffset', 'ProcessId', 'ReportId'
    )
    $eventBytesTotal = 0
    try {
        $events = @(Get-WinEvent -FilterHashtable @{
            LogName = 'Application'
            Id = @(1000, 1001)
            StartTime = $eventStart
            EndTime = $failedAt.AddSeconds(2)
        } -ErrorAction Stop | Select-Object -Last 50 | ForEach-Object {
            $event = $_
            $eventData = @{}
            try {
                [xml]$xml = $event.ToXml()
                foreach ($item in $xml.Event.EventData.Data) {
                    $field = [string]$item.Name
                    if ($field -and $field -in $allowedEventFields -and $eventData.Count -lt 12) {
                        $value = [string]$item.InnerText
                        if ($value.Length -gt 256) { $value = $value.Substring(0, 256) }
                        $eventData[$field] = $value
                    }
                }
            } catch { }
            $processIdentityFields = @('FaultingApplicationName', 'FaultingApplicationPath', 'ApplicationName', 'ApplicationPath', 'AppName', 'AppPath')
            $identityValues = @($processIdentityFields | ForEach-Object { $eventData[$_] } | Where-Object { $_ })
            $matchesKnownProcess = $false
            foreach ($identity in $identityValues) {
                if ($identity -in $knownPaths -or ([System.IO.Path]::GetFileName($identity) -in $knownNames)) {
                    $matchesKnownProcess = $true
                    break
                }
            }
            if (-not $matchesKnownProcess -or $eventBytesTotal -ge 8192) { return }
            $providerName = [string]$event.ProviderName
            if ($providerName.Length -gt 128) { $providerName = $providerName.Substring(0, 128) }
            $record = [ordered]@{
                timeUtc = $event.TimeCreated.ToUniversalTime().ToString('o')
                provider = $providerName
                id = [int]$event.Id
                eventData = $eventData
            }
            $recordText = $record | ConvertTo-Json -Compress -Depth 4
            $recordBytes = [System.Text.Encoding]::UTF8.GetByteCount($recordText)
            if ($eventBytesTotal + $recordBytes -gt 8192) { return }
            $eventBytesTotal += $recordBytes
            [pscustomobject]@{
                timeUtc = $record.timeUtc
                provider = $record.provider
                id = $record.id
                eventData = $record.eventData
            }
        })
    } catch {
        $events = @()
    }

    $diagnostics = [ordered]@{
        failedAtUtc = $failedAt.ToString('o')
        setupAttempts = @($setupAttempts)
        applicationEvents = $events
    }
    $diagnostics | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $diagnosticRoot 'failure-diagnostics.json') -Encoding utf8
    Write-Output "Failure diagnostics saved to $diagnosticRoot"
}

function Save-FailureDiagnosticsBestEffort {
    try { Save-FailureDiagnostics } catch { Write-Warning 'Could not save installer failure diagnostics.' }
}
function Start-TestWindow {
    # This is the foreground application under test, not a background helper.
    $process = Start-Process -FilePath $appPath -PassThru
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) { throw "Desktop exited before window creation: $($process.ExitCode)" }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { return $process }
    }
    Stop-Process -Id $process.Id -Force
    throw 'Application did not create a desktop window'
}
function Close-TestWindow($process) {
    if (-not $process.CloseMainWindow()) { throw 'Window close request failed' }
    if (-not $process.WaitForExit(12000)) { throw 'Application remained running after window close' }
    if ($process.ExitCode -ne 0) { throw "Application exit code: $($process.ExitCode)" }
}

$running = $null
try {
    Invoke-Setup
    $running = Start-TestWindow
    Close-TestWindow $running
    Write-Output 'PASS: clean NSIS installation, visible window and normal close'

    # Reinstall the same version while it is open. This exercises the installer
    # close path but does not substitute for an upgrade from an older release.
    $running = Start-TestWindow
    Invoke-Setup
    if (-not $running.WaitForExit(12000)) { throw 'Installer left the previous process running' }
    if ($running.ExitCode -ne 0) { throw 'Installer did not close the previous process normally' }
    $running = Start-TestWindow
    Close-TestWindow $running
    Write-Output 'PASS: same-version reinstall while running and relaunch'

    $uninstaller = Get-ChildItem (Split-Path $appPath) -Filter 'Uninstall*.exe' | Select-Object -First 1
    if (-not $uninstaller) { throw 'NSIS uninstaller missing' }
    $running = Start-TestWindow
    $removal = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait
    if ($removal.ExitCode -ne 0) { throw "Uninstall failed: $($removal.ExitCode)" }
    if (-not $running.WaitForExit(12000)) { throw 'Uninstaller left the app running' }
    if ($running.ExitCode -ne 0) { throw 'Uninstaller did not close the app normally' }
    for ($attempt = 0; $attempt -lt 40 -and (Test-Path -LiteralPath $appPath); $attempt++) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $appPath) { throw 'Installed executable remains after uninstall' }
    $remaining = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $appPath }
    if ($remaining) { throw 'Installed app process remains after uninstall' }
    Write-Output 'PASS: uninstall while running; executable and processes removed'
} catch {
    Save-FailureDiagnosticsBestEffort
    throw
} finally {
    if ($running -and -not $running.HasExited) { Stop-Process -Id $running.Id -Force }
}
