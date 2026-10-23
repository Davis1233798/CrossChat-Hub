# Developer CI only: installs and removes a build on a disposable Windows runner.
# Never offer this script as an end-user installation or repair step.
$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem dist -Filter 'CrossChat-Hub-*-win-x64.exe' | Select-Object -First 1
if (-not $installer) { throw 'NSIS executable missing' }
$appPath = Join-Path $env:LOCALAPPDATA 'Programs\CrossChat Hub\CrossChat Hub.exe'
if (Test-Path -LiteralPath $appPath) { throw 'This test requires a clean disposable Windows runner' }

function Invoke-Setup {
    $setup = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -PassThru -Wait
    if ($setup.ExitCode -ne 0) { throw "Silent installation failed with code $($setup.ExitCode)" }
    if (-not (Test-Path -LiteralPath $appPath)) { throw "Installed EXE not found: $appPath" }
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
} finally {
    if ($running -and -not $running.HasExited) { Stop-Process -Id $running.Id -Force }
}
