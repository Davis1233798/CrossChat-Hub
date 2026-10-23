; Per-user NSIS upgrade: close any running CrossChat Hub before replacing
; CrossChat Hub.exe. ExecWait is used rather than the nsExec plugin in customInit,
; to avoid an installer-process access violation seen in the CI smoke test.
!macro customInit
  ClearErrors
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM "CrossChat Hub.exe"' $0
  Sleep 1000
!macroend

!macro customUnInit
  ClearErrors
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM "CrossChat Hub.exe"' $0
  Sleep 700
!macroend
