param(
  [Parameter(Mandatory = $true)][string]$CefProject,
  [Parameter(Mandatory = $true)][string]$BuildDirectory,
  [string]$CMake = 'cmake'
)
$ErrorActionPreference = 'Stop'
$expectedRevision = '3aec7049cf63a36876d7a6ef538842d6af314482'
$version = '144.0.6+g5f7e671+chromium-144.0.7559.59'
$projectRoot = (Resolve-Path -LiteralPath $CefProject).Path
$revision = & git -C $projectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -ne $expectedRevision) {
  throw 'Expected pinned cef-project revision.'
}
$distribution = Join-Path $projectRoot "third_party/cef/cef_binary_${version}_windows64"
$header = Get-Content -LiteralPath (Join-Path $distribution 'include/cef_version.h') -Raw
if (!$header.Contains("#define CEF_VERSION `"$version`"")) {
  throw 'Expected pinned Windows x64 CEF distribution.'
}
# Only overwrite the two declared sample overlays; no LINE package is involved.
foreach ($source in @('simple_app.cc', 'cefsimple_win.cc')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $source) -Destination (Join-Path $distribution "tests/cefsimple/$source")
}
& $CMake -S $projectRoot -B $BuildDirectory -G 'Visual Studio 17 2022' -A x64 -DWITH_EXAMPLES=OFF -DUSE_SANDBOX=ON
if ($LASTEXITCODE -ne 0) { throw 'CEF configuration failed.' }
& $CMake --build $BuildDirectory --config Release --target cefsimple -j 8
if ($LASTEXITCODE -ne 0) { throw 'CEF build failed.' }
# This command builds only. It never starts the executable or installs extensions.
