param(
  [Parameter(Mandatory = $true)][string]$CefProject,
  [Parameter(Mandatory = $true)][string]$BuildDirectory,
  [string]$CMake = 'cmake',
  [Parameter(Mandatory = $true)][ValidateSet('synthetic', 'line-prelogin')][string]$AppMode
)
$ErrorActionPreference = 'Stop'
$expectedRevision = '3aec7049cf63a36876d7a6ef538842d6af314482'
$version = '144.0.6+g5f7e671+chromium-144.0.7559.59'
$projectRoot = (Resolve-Path -LiteralPath $CefProject).Path
$revision = & git -C $projectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -ne $expectedRevision) {
  throw 'Expected pinned cef-project revision.'
}
# HEAD alone does not ensure that download/configuration logic is pinned.
# The two sample overlays live under the ignored distribution, outside this check.
& git -C $projectRoot diff --quiet HEAD -- CMakeLists.txt cmake
if ($LASTEXITCODE -ne 0) {
  throw 'Expected unchanged pinned upstream CMake configuration.'
}
$distribution = Join-Path $projectRoot "third_party/cef/cef_binary_${version}_windows64"
$header = Get-Content -LiteralPath (Join-Path $distribution 'include/cef_version.h') -Raw
if (!$header.Contains("#define CEF_VERSION `"$version`"")) {
  throw 'Expected pinned Windows x64 CEF distribution.'
}
# Repository sources remain separate. Only the declared upstream scratch sample
# is selected; rebuilding another mode does not overwrite either source here.
$appSource = if ($AppMode -eq 'line-prelogin') { 'line_store_app.cc' } else { 'simple_app.cc' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot $appSource) -Destination (Join-Path $distribution 'tests/cefsimple/simple_app.cc')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cefsimple_win.cc') -Destination (Join-Path $distribution 'tests/cefsimple/cefsimple_win.cc')
# A project-end CMake hook applies the compile definition only to cefsimple.
# Explicit OFF also removes the definition when reusing a build tree for fixtures.
$modeEnabled = if ($AppMode -eq 'line-prelogin') { 'ON' } else { 'OFF' }
$modeHook = (Join-Path $PSScriptRoot 'app_mode.cmake').Replace('\', '/')
& $CMake -S $projectRoot -B $BuildDirectory -G 'Visual Studio 17 2022' -A x64 -DWITH_EXAMPLES=OFF -DUSE_SANDBOX=ON "-DCMAKE_PROJECT_INCLUDE:FILEPATH=$modeHook" "-DCROSSCHAT_LINE_PRELOGIN:BOOL=$modeEnabled"
if ($LASTEXITCODE -ne 0) { throw 'CEF configuration failed.' }
& $CMake --build $BuildDirectory --config Release --target cefsimple -j 8
if ($LASTEXITCODE -ne 0) { throw 'CEF build failed.' }
# This command builds only. It never starts the executable or installs extensions.
