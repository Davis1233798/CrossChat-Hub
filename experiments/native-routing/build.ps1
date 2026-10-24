$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$outputDir = Join-Path $repoRoot 'build/bin/native-routing'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$uiaRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/WPF'
$reader = Join-Path $outputDir 'ReadOnlyRouting.exe'
& $compiler /nologo /target:winexe /platform:x64 /reference:System.Web.Extensions.dll "/reference:$uiaRoot/UIAutomationClient.dll" "/reference:$uiaRoot/UIAutomationTypes.dll" "/reference:$uiaRoot/WindowsBase.dll" "/out:$reader" (Join-Path $PSScriptRoot 'ReadOnlyRouting.cs')
if ($LASTEXITCODE -ne 0) { throw 'Read-only routing compilation failed' }
$fixture = Join-Path $outputDir 'SyntheticRouting.exe'
& $compiler /nologo /target:exe /platform:x64 /reference:System.Web.Extensions.dll /reference:System.Xaml.dll "/reference:$uiaRoot/PresentationFramework.dll" "/reference:$uiaRoot/PresentationCore.dll" "/reference:$uiaRoot/WindowsBase.dll" "/reference:$uiaRoot/UIAutomationTypes.dll" "/out:$fixture" (Join-Path $PSScriptRoot 'SyntheticRouting.cs')
if ($LASTEXITCODE -ne 0) { throw 'Routing fixture compilation failed' }
Write-Output $reader
