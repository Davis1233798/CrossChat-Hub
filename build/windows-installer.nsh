; The NSIS installer must be self-contained: on upgrade close the running app
; before attempting to replace the executable. No customer repair script needed.
!macro customInit
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "CrossChat Hub.exe"'
  Sleep 1200
!macroend

!macro customUnInit
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "CrossChat Hub.exe"'
  Sleep 700
!macroend
