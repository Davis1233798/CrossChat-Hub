$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$uiaRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/WPF'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw "Required .NET Framework x64 compiler not found: $compiler" }
$targets = @(
  @{ Source = (Join-Path $repoRoot 'experiments/native-host/LineWitness.cs'); Output = (Join-Path $repoRoot 'build/bin/native-host/LineWitness.exe'); Target = 'exe'; References = @('/reference:System.Web.Extensions.dll') },
  @{ Source = (Join-Path $repoRoot 'experiments/native-routing/ReadOnlyRouting.cs'); Output = (Join-Path $repoRoot 'build/bin/native-routing/ReadOnlyRouting.exe'); Target = 'winexe'; References = @('/reference:System.Web.Extensions.dll', "/reference:$uiaRoot/UIAutomationClient.dll", "/reference:$uiaRoot/UIAutomationTypes.dll", "/reference:$uiaRoot/WindowsBase.dll") }
)
foreach ($target in $targets) {
  if (!(Test-Path -LiteralPath $target.Source -PathType Leaf)) { throw "Native helper source missing: $($target.Source)" }
  New-Item -ItemType Directory -Path (Split-Path $target.Output -Parent) -Force | Out-Null
  $needsBuild = !(Test-Path -LiteralPath $target.Output -PathType Leaf)
  if (!$needsBuild) {
    $outputTime = (Get-Item -LiteralPath $target.Output).LastWriteTimeUtc
    $needsBuild = (Get-Item -LiteralPath $target.Source).LastWriteTimeUtc -gt $outputTime
    if (!$needsBuild) { $needsBuild = (Get-Item -LiteralPath $compiler).LastWriteTimeUtc -gt $outputTime }
  }
  if ($needsBuild) {
    & $compiler /nologo "/target:$($target.Target)" /platform:x64 @($target.References) "/out:$($target.Output)" $target.Source
    if ($LASTEXITCODE -ne 0) { throw "Native helper compilation failed: $($target.Source)" }
  }
  Write-Output $target.Output
}
$productBroker = Join-Path $repoRoot 'build/bin/native-host/ProductBroker.exe'
$manifest = Join-Path $repoRoot 'experiments/native-host/HubBrokerMixed.manifest'
$productSources = @((Join-Path $repoRoot 'experiments/native-host/HubBroker.cs'), (Join-Path $repoRoot 'experiments/native-host/LineWitness.cs'))
$productNeedsBuild = !(Test-Path -LiteralPath $productBroker -PathType Leaf)
if (!$productNeedsBuild) {
  $productTime = (Get-Item -LiteralPath $productBroker).LastWriteTimeUtc
  $productNeedsBuild = $productSources | Where-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $productTime } | Select-Object -First 1
}
if ($productNeedsBuild) {
  New-Item -ItemType Directory -Path (Split-Path $productBroker -Parent) -Force | Out-Null
  & $compiler /nologo /target:winexe /platform:x64 /define:LINE_PRODUCT /main:HubBroker /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32manifest:$manifest" "/out:$productBroker" $productSources[0] $productSources[1]
  if ($LASTEXITCODE -ne 0) { throw 'Product native LINE broker build failed' }
}
Write-Output $productBroker
$fixtureBroker = Join-Path $repoRoot 'build/bin/native-host/ProductBrokerFixture.exe'
$fixtureNeedsBuild = !(Test-Path -LiteralPath $fixtureBroker -PathType Leaf)
if (!$fixtureNeedsBuild) {
  $fixtureTime = (Get-Item -LiteralPath $fixtureBroker).LastWriteTimeUtc
  $fixtureNeedsBuild = $productSources | Where-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $fixtureTime } | Select-Object -First 1
}
if ($fixtureNeedsBuild) {
  & $compiler /nologo /target:winexe /platform:x64 /define:LINE_PRODUCT,LINE_PRODUCT_FIXTURE /main:HubBroker /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32manifest:$manifest" "/out:$fixtureBroker" $productSources[0] $productSources[1]
  if ($LASTEXITCODE -ne 0) { throw 'Owned-fixture native LINE broker build failed' }
}
Write-Output $fixtureBroker
