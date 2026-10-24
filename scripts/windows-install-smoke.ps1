# Developer CI only: installs and removes a build on a disposable Windows runner.
# Never offer this script as an end-user installation or repair step.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-minidump-summary.ps1')
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

function Start-WerLocalDumpCapture([string]$DumpFolder) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $diagnosticRoot) {
        return [pscustomobject]@{ enabled = $false; reason = 'not-github-actions' }
    }
    $runnerTempFull = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
    $diagnosticFull = [System.IO.Path]::GetFullPath($diagnosticRoot)
    $dumpFolderFull = [System.IO.Path]::GetFullPath($DumpFolder)
    if (-not $diagnosticFull.StartsWith($runnerTempFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $dumpFolderFull.StartsWith($runnerTempFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $dumpFolderFull.StartsWith(($diagnosticFull.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ enabled = $false; reason = 'diagnostics-outside-runner-temp' }
    }

    $keyPath = 'SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\' + $installer.Name
    $parentPath = 'SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
    $key = $null
    $keyExisted = $false
    $parentKeyExisted = $false
    $saved = @{}
    try {
        $parentProbe = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($parentPath, $false)
        $parentKeyExisted = $null -ne $parentProbe
        if ($parentProbe) { $parentProbe.Dispose() }
        $existing = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($keyPath, $true)
        $keyExisted = $null -ne $existing
        if ($existing) { $existing.Dispose() }
        $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($keyPath)
        if (-not $key) { return [pscustomobject]@{ enabled = $false; reason = 'registry-unavailable' } }
        $saved = @{}
        foreach ($name in @('DumpFolder', 'DumpType', 'DumpCount')) {
            $present = $key.GetValueNames() -contains $name
            if ($present) {
                $saved[$name] = [pscustomobject]@{
                    present = $true
                    value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    kind = $key.GetValueKind($name)
                }
            } else { $saved[$name] = [pscustomobject]@{ present = $false; value = $null; kind = $null } }
        }
        $key.SetValue('DumpFolder', $DumpFolder, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $key.SetValue('DumpType', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        $key.SetValue('DumpCount', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        $key.Dispose()
        return [pscustomobject]@{
            enabled = $true
            reason = $null
            keyPath = $keyPath
            parentPath = $parentPath
            keyExisted = $keyExisted
            parentKeyExisted = $parentKeyExisted
            saved = $saved
        }
    } catch {
        if ($key) {
            try {
                foreach ($name in @('DumpFolder', 'DumpType', 'DumpCount')) {
                    if ($saved.ContainsKey($name)) {
                        $savedValue = $saved[$name]
                        if ($savedValue.present) { $key.SetValue($name, $savedValue.value, $savedValue.kind) }
                        else { $key.DeleteValue($name, $false) }
                    }
                }
                $key.Dispose()
                $key = $null
                if (-not $keyExisted) {
                    [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey($keyPath, $false)
                    if (-not $parentKeyExisted) {
                        $parent = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($parentPath, $true)
                        if ($parent) {
                            $empty = (@($parent.GetValueNames()).Count -eq 0 -and @($parent.GetSubKeyNames()).Count -eq 0)
                            $parent.Dispose()
                            if ($empty) { [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey($parentPath, $false) }
                        }
                    }
                }
            } catch { if ($key) { $key.Dispose() } }
        }
        return [pscustomobject]@{ enabled = $false; reason = 'registry-unavailable' }
    }
}

function Restore-WerLocalDumpCapture($Capture) {
    if (-not $Capture -or -not $Capture.enabled) { return }
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($Capture.keyPath, $true)
        if (-not $key) { return }
        foreach ($name in @('DumpFolder', 'DumpType', 'DumpCount')) {
            $savedValue = $Capture.saved[$name]
            if ($savedValue.present) { $key.SetValue($name, $savedValue.value, $savedValue.kind) }
            else { $key.DeleteValue($name, $false) }
        }
        $key.Dispose()
        $key = $null
        if (-not $Capture.keyExisted) {
            [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey($Capture.keyPath, $false)
            if (-not $Capture.parentKeyExisted) {
                $parent = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($Capture.parentPath, $true)
                if ($parent) {
                    $empty = (@($parent.GetValueNames()).Count -eq 0 -and @($parent.GetSubKeyNames()).Count -eq 0)
                    $parent.Dispose()
                    if ($empty) { [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey($Capture.parentPath, $false) }
                }
            }
        }
    } catch {
        Write-Warning 'Could not fully restore temporary WER LocalDumps settings.'
    } finally {
        if ($key) { $key.Dispose() }
    }
}

function Get-WerDumpSummaryBestEffort([string]$DumpFolder) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $dump = Get-ChildItem -LiteralPath $DumpFolder -Filter '*.dmp' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($dump) {
            $script:capturedWerDumpPath = $dump.FullName
            try { return Get-MinidumpCrashSummary -Path $dump.FullName }
            catch { return [pscustomobject]@{ status = 'unavailable' } }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return [pscustomobject]@{ status = 'unavailable' }
}

function Remove-WerDumpFolderBestEffort([string]$DumpFolder, [string]$AttemptRoot, [string]$DumpPath) {
    if (-not $DumpFolder -or -not $AttemptRoot) { return }
    try {
        $folderFull = [System.IO.Path]::GetFullPath($DumpFolder).TrimEnd('\')
        $rootFull = [System.IO.Path]::GetFullPath($AttemptRoot).TrimEnd('\') + '\'
        if (-not $folderFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return }
        if ($DumpPath) {
            $dumpFull = [System.IO.Path]::GetFullPath($DumpPath)
            if ([System.IO.Path]::GetDirectoryName($dumpFull).TrimEnd('\') -eq $folderFull -and
                [System.IO.Path]::GetExtension($dumpFull) -eq '.dmp') {
                Remove-Item -LiteralPath $dumpFull -Force -ErrorAction SilentlyContinue
            }
        }
        if (@(Get-ChildItem -LiteralPath $folderFull -Force -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item -LiteralPath $folderFull -Force -ErrorAction SilentlyContinue
        }
    } catch { }
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
        crashDump = [ordered]@{ status = 'not-captured' }
    }
    $setupAttempts.Add($attempt)
    # WER dumps stay in a runner-temp sibling, outside the diagnostics artifact tree.
    $werTempRoot = if ($diagnosticRoot -and $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_TEMP) {
        Join-Path $env:RUNNER_TEMP ('crosschat-wer-private-' + [guid]::NewGuid().ToString('N'))
    } else { $null }
    $werFolder = if ($werTempRoot) { Join-Path $werTempRoot "attempt-$attemptNumber" } else { $null }
    $werCapture = $null
    $werFolderReady = $false
    $werTempRootReady = $false
    $script:capturedWerDumpPath = $null
    try {
        if ($werFolder -and $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_TEMP) {
            try {
                New-Item -ItemType Directory -Path $werTempRoot -Force -ErrorAction Stop | Out-Null
                $werTempRootReady = $true
                New-Item -ItemType Directory -Path $werFolder -Force -ErrorAction Stop | Out-Null
                $werFolderReady = $true
                $werCapture = Start-WerLocalDumpCapture -DumpFolder $werFolder
                if ($werCapture.enabled) { $attempt.crashDump.status = 'armed' }
                else { $attempt.crashDump.status = 'unavailable'; $attempt.crashDump.reason = $werCapture.reason }
            } catch { $attempt.crashDump.status = 'unavailable'; $attempt.crashDump.reason = 'capture-setup-failed' }
        }
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
        if ($setup.ExitCode -ne 0 -and $werCapture -and $werCapture.enabled) {
            $summary = Get-WerDumpSummaryBestEffort -DumpFolder $werFolder
            $attempt.crashDump = $summary
        }
    } catch {
        $attempt.launchError = $_.Exception.Message
        throw
    } finally {
        $attempt.endedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        try { Restore-WerLocalDumpCapture -Capture $werCapture } catch { Write-Warning 'Could not restore temporary WER LocalDumps settings.' }
        if ($werFolderReady) {
            try { Remove-WerDumpFolderBestEffort -DumpFolder $werFolder -AttemptRoot $werTempRoot -DumpPath $script:capturedWerDumpPath } catch { }
        }
        if ($werTempRootReady) {
            try {
                $privateRootFull = [System.IO.Path]::GetFullPath($werTempRoot)
                $runnerRootFull = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
                if ($privateRootFull.StartsWith($runnerRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    Remove-Item -LiteralPath $privateRootFull -Force -ErrorAction SilentlyContinue
                }
            } catch { }
        }
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
