$ErrorActionPreference = 'Stop'
$minidumpParserPath = Join-Path $PSScriptRoot 'windows-minidump-summary.ps1'
. $minidumpParserPath
$sourcePath = Join-Path $PSScriptRoot 'windows-install-smoke.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }

$functionAsts = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -in @(
            'Invoke-Setup', 'Start-WerLocalDumpCapture', 'Restore-WerLocalDumpCapture',
            'Get-WerDumpSummaryBestEffort', 'Remove-WerDumpFolderBestEffort',
            'Save-FailureDiagnostics', 'Save-FailureDiagnosticsBestEffort'
        )
}, $true)
Invoke-Expression (($functionAsts | ForEach-Object { $_.Extent.Text }) -join "`n")
$script:ActualSaveFailureDiagnostics = (Get-Item Function:Save-FailureDiagnostics).ScriptBlock

function Assert-Condition([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}

function New-MinidumpFixture([string]$Path, [switch]$NoModuleStream, [switch]$InvalidStream) {
    $streamCount = if ($NoModuleStream) { 1 } else { 2 }
    $directoryRva = [uint32]32
    $exceptionRva = [uint32](32 + ($streamCount * 12))
    $moduleRva = [uint32]($exceptionRva + 168)
    $name = [System.Text.Encoding]::Unicode.GetBytes('C:\Temp\setup.exe')
    $nameRva = [uint32]($moduleRva + 112)
    $memory = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($memory)
    try {
        $writer.Write([uint32]0x504d444d)
        $writer.Write([uint32]0x0000a793)
        $writer.Write([uint32]$streamCount)
        $writer.Write([uint32]$directoryRva)
        $writer.Write([uint32]0)
        $writer.Write([uint32]0)
        $writer.Write([uint64]0)
        $writer.Write([uint32]6)
        $writer.Write([uint32]168)
        $writer.Write([uint32]$(if ($InvalidStream) { 0x7fffffff } else { $exceptionRva }))
        if (-not $NoModuleStream) {
            $writer.Write([uint32]4)
            $writer.Write([uint32]112)
            $writer.Write([uint32]$moduleRva)
        }
        $writer.Write([uint32]1)
        $writer.Write([uint32]0)
        $writer.Write([Convert]::ToUInt32('C0000005', 16))
        $writer.Write([uint32]0)
        $writer.Write([uint64]0)
        $writer.Write([uint64]0x0000000140001234)
        $writer.Write([uint32]0)
        $writer.Write([uint32]0)
        for ($i = 0; $i -lt 15; $i++) { $writer.Write([uint64]0) }
        $writer.Write([uint32]0)
        $writer.Write([uint32]0)
        if (-not $NoModuleStream) {
            $writer.Write([uint32]1)
            $writer.Write([uint64]0x0000000140000000)
            $writer.Write([uint32]0x20000)
            $writer.Write([uint32]0)
            $writer.Write([uint32]0)
            $writer.Write([uint32]$nameRva)
            for ($i = 0; $i -lt 13; $i++) { $writer.Write([uint32]0) }
            for ($i = 0; $i -lt 4; $i++) { $writer.Write([uint32]0) }
            $writer.Write([uint64]0)
            $writer.Write([uint64]0)
            $writer.Write([uint32]$name.Length)
            $writer.Write($name)
        }
        [System.IO.File]::WriteAllBytes($Path, $memory.ToArray())
    } finally {
        $writer.Dispose()
        $memory.Dispose()
    }
}

function Save-SetupAttempts { throw 'mock metadata write failure' }
function Save-FailureDiagnostics {
    if ($script:MockFailDiagnostics) { throw 'mock failure report write failure' }
    & $script:ActualSaveFailureDiagnostics
}
function Get-WinEvent { param($FilterHashtable, $ErrorAction); $script:MockEvents }
function Start-Process {
    param(
        [string]$FilePath,
        [string]$ArgumentList,
        [switch]$PassThru,
        [switch]$Wait,
        [string]$RedirectStandardOutput,
        [string]$RedirectStandardError
    )
    if ($RedirectStandardOutput) { [IO.File]::WriteAllText($RedirectStandardOutput, 'mock stdout') }
    if ($RedirectStandardError) { [IO.File]::WriteAllText($RedirectStandardError, 'mock stderr') }
    [pscustomobject]@{ ExitCode = $script:MockExitCode }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('crosschat-installer-diagnostics-test-' + [guid]::NewGuid().ToString('N'))
$savedGithubActions = $env:GITHUB_ACTIONS
$savedRunnerTemp = $env:RUNNER_TEMP
$env:GITHUB_ACTIONS = $null
$env:RUNNER_TEMP = $null
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $validDump = Join-Path $testRoot 'valid-fixture.dmp'
    New-MinidumpFixture -Path $validDump
    $summary = Get-MinidumpCrashSummary -Path $validDump
    Assert-Condition ($summary.status -eq 'parsed') 'Valid minidump fixture was not parsed.'
    Assert-Condition ($summary.exceptionCode -eq '0xC0000005') 'Exception code was not read from the exception stream.'
    Assert-Condition ($summary.exceptionAddress -eq '0x0000000140001234') 'Exception address was not read from the exception stream.'
    Assert-Condition ($summary.faultingModuleName -eq 'setup.exe') 'Exception address was not mapped to the module basename.'
    $summaryJson = $summary | ConvertTo-Json -Compress
    Assert-Condition (-not $summaryJson.Contains('C:\Temp')) 'Minidump summary leaked a module path.'
    Assert-Condition ((@($summary.PSObject.Properties.Name) -join ',') -eq 'status,exceptionCode,exceptionAddress,faultingModuleName') 'Minidump summary emitted fields outside the safe allowlist.'

    $diagnosticRoot = $testRoot
    $installer = [pscustomobject]@{ Name = 'mock-installer.exe' }
    $localCapture = Start-WerLocalDumpCapture -DumpFolder (Join-Path $testRoot 'private')
    Assert-Condition (-not $localCapture.enabled -and $localCapture.reason -eq 'not-github-actions') 'WER registry capture was not disabled outside GitHub Actions.'

    $truncatedDump = Join-Path $testRoot 'truncated-fixture.dmp'
    $validBytes = [System.IO.File]::ReadAllBytes($validDump)
    [System.IO.File]::WriteAllBytes($truncatedDump, [byte[]]$validBytes[0..40])
    Assert-Condition ((Get-MinidumpCrashSummary -Path $truncatedDump).status -ne 'parsed') 'Truncated minidump fixture was accepted.'

    $noModuleDump = Join-Path $testRoot 'no-module-fixture.dmp'
    New-MinidumpFixture -Path $noModuleDump -NoModuleStream
    Assert-Condition ((Get-MinidumpCrashSummary -Path $noModuleDump).status -eq 'no-module-stream') 'Missing module stream was not reported safely.'

    $invalidStreamDump = Join-Path $testRoot 'invalid-stream-fixture.dmp'
    New-MinidumpFixture -Path $invalidStreamDump -InvalidStream
    Assert-Condition ((Get-MinidumpCrashSummary -Path $invalidStreamDump).status -eq 'invalid-stream') 'Out-of-bounds stream was not rejected.'

    $privateRoot = Join-Path $testRoot 'private-root'
    $privateFolder = Join-Path $privateRoot 'attempt-1'
    New-Item -ItemType Directory -Path $privateFolder -Force | Out-Null
    $privateDump = Join-Path $privateFolder 'captured.dmp'
    Copy-Item -LiteralPath $validDump -Destination $privateDump
    $outsideDump = Join-Path $testRoot 'outside.dmp'
    Copy-Item -LiteralPath $validDump -Destination $outsideDump
    Remove-WerDumpFolderBestEffort -DumpFolder $privateFolder -AttemptRoot $privateRoot -DumpPath $privateDump
    Assert-Condition (-not (Test-Path -LiteralPath $privateDump) -and -not (Test-Path -LiteralPath $privateFolder)) 'Private WER dump cleanup failed.'
    Assert-Condition ((Test-Path -LiteralPath $outsideDump)) 'WER dump cleanup escaped its attempt directory.'

    $setupAttempts = [System.Collections.Generic.List[object]]::new()
    $script:lastSetupStartedAt = $null
    $installerPath = Join-Path $testRoot 'installer.exe'
    $appPath = Join-Path $testRoot 'app.exe'
    [IO.File]::WriteAllText($installerPath, 'mock installer')
    [IO.File]::WriteAllText($appPath, 'mock app')
    $installer = [pscustomobject]@{ FullName = $installerPath }

    $script:MockExitCode = 0
    Invoke-Setup
    Assert-Condition ($setupAttempts[0].exitCode -eq 0) 'Successful setup was changed by failed metadata persistence.'
    Assert-Condition (Test-Path (Join-Path $testRoot 'setup-1.stdout.txt')) 'Mock stdout was not captured.'

    $script:MockExitCode = -1073741819
    $script:MockFailDiagnostics = $true
    $originalFailure = $null
    try { Invoke-Setup } catch { $originalFailure = $_.Exception.Message }
    Assert-Condition ($originalFailure -eq 'Silent installation failed with code -1073741819') 'Failed setup error was replaced by metadata persistence failure.'
    Assert-Condition ($setupAttempts[1].exitCode -eq -1073741819) 'Failed setup exit code was not recorded in memory.'

    $originalFailure = $null
    try {
        try { throw 'original smoke failure' } catch {
            Save-FailureDiagnosticsBestEffort
            throw
        }
    } catch { $originalFailure = $_.Exception.Message }
    Assert-Condition ($originalFailure -eq 'original smoke failure') 'Failure diagnostics replaced the original smoke failure.'

    $script:MockFailDiagnostics = $false
    $script:MockEvents = @()
    foreach ($index in 1..30) {
        $eventXml = '<Event><EventData><Data Name="FaultingApplicationName">installer.exe</Data><Data Name="FaultingModuleName">' + ('m' * 500) + '</Data><Data Name="ExceptionCode">0xc0000005</Data><Data Name="Message">private freeform text</Data></EventData></Event>'
        $fakeEvent = [pscustomobject]@{ TimeCreated = Get-Date; ProviderName = 'Application Error'; Id = 1000; Xml = $eventXml }
        $fakeEvent | Add-Member -MemberType ScriptMethod -Name ToXml -Value { $this.Xml }
        $script:MockEvents += $fakeEvent
    }
    $unrelatedXml = '<Event><EventData><Data Name="FaultingApplicationName">other.exe</Data><Data Name="ExceptionCode">0xc0000005</Data></EventData></Event>'
    $unrelatedEvent = [pscustomobject]@{ TimeCreated = Get-Date; ProviderName = 'Application Error'; Id = 1000; Xml = $unrelatedXml }
    $unrelatedEvent | Add-Member -MemberType ScriptMethod -Name ToXml -Value { $this.Xml }
    $script:MockEvents += $unrelatedEvent
    Save-FailureDiagnostics | Out-Null
    $failure = Get-Content (Join-Path $testRoot 'failure-diagnostics.json') -Raw | ConvertFrom-Json
    $eventJson = $failure.applicationEvents | ConvertTo-Json -Compress -Depth 4
    Assert-Condition ($failure.applicationEvents.Count -gt 0 -and $failure.applicationEvents.Count -lt 30) 'Failure event matching or total-byte bound failed.'
    Assert-Condition (-not ($failure.applicationEvents | Where-Object { $_.eventData.FaultingApplicationName -eq 'other.exe' })) 'An unrelated process event was captured.'
    Assert-Condition (-not ($failure.applicationEvents[0].eventData.PSObject.Properties.Name -contains 'Message')) 'Freeform event message was captured.'
    Assert-Condition ($failure.applicationEvents[0].eventData.FaultingModuleName.Length -le 256) 'Event field value was not truncated.'
    Assert-Condition ([System.Text.Encoding]::UTF8.GetByteCount($eventJson) -le 8200) 'Application event output exceeded the total byte bound.'
    'PASS: minidump parser fixtures (valid, truncated, missing module and invalid stream); mocked setup success/failure survive metadata write failure; report failure preserves original exception; event data is process-matched, allowlisted and bounded'
} finally {
    $env:GITHUB_ACTIONS = $savedGithubActions
    $env:RUNNER_TEMP = $savedRunnerTemp
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
