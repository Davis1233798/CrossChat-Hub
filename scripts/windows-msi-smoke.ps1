# Disposable CI runner only; independent of NSIS install/upgrade behavior.
$ErrorActionPreference = 'Stop'
$msi = Get-ChildItem dist -Filter 'CrossChat-Hub-*-win-x64.msi' | Select-Object -First 1
if (-not $msi) { throw 'MSI missing' }
$testRoot = Join-Path $env:RUNNER_TEMP ('crosschat-msi-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot 'Application'
New-Item -ItemType Directory -Path $testRoot | Out-Null
$appPath = Join-Path $installDirectory 'CrossChat Hub.exe'
$running = $null
function Invoke-Msi($operation, $logName) {
    $arguments = @($operation, ('"' + $msi.FullName + '"'), '/qn', '/norestart', '/L*v', ('"' + (Join-Path $testRoot $logName) + '"'))
    if ($operation -eq '/i') { $arguments += ('APPLICATIONFOLDER="' + $installDirectory + '"') }
    $result = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($result.ExitCode -ne 0) { throw "MSI $operation failed: $($result.ExitCode); log: $logName" }
}
try {
    Invoke-Msi '/i' 'install.log'
    if (-not (Test-Path -LiteralPath $appPath)) { throw 'MSI did not install the expected executable' }
    for ($launch = 1; $launch -le 2; $launch++) {
        $running = Start-Process -FilePath $appPath -PassThru
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 500
            $running.Refresh()
            if ($running.HasExited) { throw 'MSI installed application exited before creating a window' }
            if ($running.MainWindowHandle -ne [IntPtr]::Zero) { break }
        }
        if ($running.MainWindowHandle -eq [IntPtr]::Zero) { throw 'MSI installed application window missing' }
        if (-not $running.CloseMainWindow() -or -not $running.WaitForExit(12000) -or $running.ExitCode -ne 0) { throw 'MSI installed application did not close normally' }
        Write-Output "PASS: MSI installed application launch $launch, visible window and normal close"
    }
    Invoke-Msi '/x' 'uninstall.log'
    if (Test-Path -LiteralPath $appPath) { throw 'MSI left executable after uninstall' }
    if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $appPath }) { throw 'MSI app process remains after uninstall' }
    Write-Output 'PASS: independent MSI clean install, relaunch and uninstall; no upgrade/coexistence claim'
} finally {
    if ($running -and -not $running.HasExited) { Stop-Process -Id $running.Id -Force }
}
