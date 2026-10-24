; Override electron-builder's nsExec/getProcessInfo-based process checks.
; Both installation and uninstallation invoke this before changing files.
!macro customCheckAppRunning
  FindWindow $R2 "" "CrossChat Hub"
  ${if} $R2 != 0
    SendMessage $R2 0x0010 0 0 /TIMEOUT=3000
  ${endif}
  StrCpy $R1 0
  crosschat_wait_for_exit:
    ; Fully qualified tools avoid resolving executables from the download folder.
    ClearErrors
    GetTempFileName $R3
    ${ifnot} ${Errors}
      ExecWait '"$SYSDIR\cmd.exe" /D /S /C ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH > "$R3""' $R0
      ${if} $R0 == 0
        ExecWait '"$SYSDIR\cmd.exe" /D /S /C ""$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" "$R3" > NUL"' $R0
        Delete $R3
        ${if} $R0 == 1
          Goto crosschat_not_running
        ${endif}
      ${else}
        Delete $R3
      ${endif}
    ${endif}
    ; find exit 0 = process remains; other failures must not imply safety.
    IntOp $R1 $R1 + 1
    ${if} $R1 < 10
      Sleep 500
      Goto crosschat_wait_for_exit
    ${endif}
    MessageBox MB_OK|MB_ICONEXCLAMATION "CrossChat Hub could not be closed safely. Save your work and close CrossChat Hub before trying again. No running application was force-terminated." /SD IDOK
    SetErrorLevel 2
    Quit
  crosschat_not_running:
!macroend
