$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'windows-install-smoke.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }

$functionAsts = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -in @('Invoke-Setup', 'Save-FailureDiagnostics', 'Save-FailureDiagnosticsBestEffort')
}, $true)
Invoke-Expression (($functionAsts | ForEach-Object { $_.Extent.Text }) -join "`n")
$script:ActualSaveFailureDiagnostics = (Get-Item Function:Save-FailureDiagnostics).ScriptBlock

function Assert-Condition([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
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
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $diagnosticRoot = $testRoot
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
    'PASS: mocked setup success/failure survive metadata write failure; report failure preserves original exception; event data is process-matched, allowlisted and bounded'
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
