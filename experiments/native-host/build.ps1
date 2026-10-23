$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$outputDir = Join-Path $repoRoot 'build/bin/native-host'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$sourceFile = Join-Path $PSScriptRoot 'NativeHost.cs'
$executable = Join-Path $outputDir 'NativeHost.exe'
& $compiler /nologo /target:exe /platform:x64 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$executable" $sourceFile
if ($LASTEXITCODE -ne 0) { throw 'Native host compilation failed' }
$crashSource = Join-Path $PSScriptRoot 'CrashStudy.cs'
$crashExecutable = Join-Path $outputDir 'CrashStudy.exe'
& $compiler /nologo /target:exe /platform:x64 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$crashExecutable" $crashSource
if ($LASTEXITCODE -ne 0) { throw 'Crash study compilation failed' }
Write-Output (Join-Path $outputDir 'NativeHost.exe')
