# Close only the user's CrossChat Hub EXE in the per-user install directory.
# This repairs legacy instances that still lock the installer; it never deletes data.
$install = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\CrossChat Hub'))
$expected = Join-Path $install 'CrossChat Hub.exe'
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'CrossChat Hub.exe'" -ErrorAction Stop |
  Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath),$expected,[StringComparison]::OrdinalIgnoreCase) })
if ($targets.Count -eq 0) { Write-Host 'No matching CrossChat Hub process found.'; exit 0 }
foreach ($item in $targets) {
  Write-Host "Closing CrossChat Hub PID $($item.ProcessId) at $($item.ExecutablePath)"
  Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
}
Start-Sleep -Milliseconds 600
$remaining = @(Get-Process -Name 'CrossChat Hub' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals($_.Path,$expected,[StringComparison]::OrdinalIgnoreCase) })
if ($remaining.Count -gt 0) { throw 'Unable to stop CrossChat Hub. Check antivirus/other active accounts.' }
Write-Host 'Process closed. Retry the installer.'
