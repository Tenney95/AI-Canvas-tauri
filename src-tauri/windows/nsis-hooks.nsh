; This hook is included before Tauri defines PRODUCTNAME, MAINBINARYNAME and
; UpdateMode. Helpers use runtime values; the main binary is passed by the macro.
!include LogicLib.nsh
!include FileFunc.nsh

Var AICanvasUpdateParameters
Var AICanvasUpdateSid
Var AICanvasUpdateOriginSid
Var AICanvasUpdateElevated
Var AICanvasUpdateOnce
Var AICanvasUpdateActive
Var AICanvasUpdateError
Var AICanvasUpdatePhase
Var AICanvasUpdateProbeError
Var AICanvasUpdateMainBinary

LangString AICanvasUpdateContextError 1033 "The update could not verify the existing per-user NSIS installation. No application files were replaced. Close this installer and install the new version manually using the original Windows account."
LangString AICanvasUpdateContextError 2052 "更新无法确认原账户的 NSIS 安装上下文，未替换应用文件。请关闭安装器，使用原 Windows 账户手动安装新版本。"
LangString AICanvasUpdateAccountError 1033 "This update requires elevation under the same Windows account. Switching to another administrator account is not supported. No application files were replaced."
LangString AICanvasUpdateAccountError 2052 "本次更新只支持在同一 Windows 账户下提权，不支持切换到其他管理员账户。未替换应用文件。"
LangString AICanvasUpdateMsiError 1033 "A matching MSI installation was found. Automatic NSIS elevation cannot migrate or uninstall it. Close this installer and use the matching installer manually."
LangString AICanvasUpdateMsiError 2052 "检测到对应的 MSI 安装。NSIS 自动提权不会迁移或卸载它，请关闭安装器并手动使用对应的安装包。"
LangString AICanvasUpdateWriteError 1033 "The update cannot safely replace the existing application files. Elevation was cancelled, unavailable or did not resolve the problem. Close other application instances and retry the installer manually."
LangString AICanvasUpdateWriteError 2052 "更新无法安全替换现有应用文件。提权已取消、不可用或仍未解决问题，请关闭其他应用实例后手动重试安装器。"

!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "AI Canvas update guard must be composed with the existing GUI initialization callback."
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT AICanvasUpdateGuiInit

; TokenUser identifies the account, not its display name or administrator group.
; Every native allocation and handle is released before returning or failing.
Function AICanvasReadUpdateIdentity
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $AICanvasUpdateSid ""
  StrCpy $AICanvasUpdateElevated 0
  StrCpy $1 0
  StrCpy $3 0
  StrCpy $5 0
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 0x0008, *p.r1) i.r2'
  StrCmp $2 0 identity_done
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p 0, i 0, *i.r2) i.r0'
  IntCmp $2 65536 0 0 identity_done
  IntCmp $2 8 0 identity_done 0
  System::Alloc $2
  Pop $3
  StrCmp $3 0 identity_done
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p r3, i r2, *i.r4) i.r0'
  StrCmp $0 0 identity_done
  System::Call '*$3(p.r4)'
  System::Call 'advapi32::ConvertSidToStringSidW(p r4, *p.r5) i.r0'
  StrCmp $0 0 identity_done
  System::Call '*$5(&w${NSIS_MAX_STRLEN} .r4)'
  StrCpy $AICanvasUpdateOriginSid $4
  System::Call 'advapi32::GetTokenInformation(p r1, i 20, p r3, i 4, *i.r4) i.r0'
  StrCmp $0 0 identity_done
  System::Call '*$3(i.r4)'
  StrCpy $AICanvasUpdateElevated $4
  StrCpy $AICanvasUpdateSid $AICanvasUpdateOriginSid
identity_done:
  StrCmp $5 0 +2
    System::Call 'kernel32::LocalFree(p r5) p'
  StrCmp $3 0 +2
    System::Free $3
  StrCmp $1 0 +2
    System::Call 'kernel32::CloseHandle(p r1) i'
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Mirror the locked Tauri 2.11.2 PageReinstall WiX detection. That page can
; uninstall MSI before PREINSTALL, so reject matching MSI before showing pages.
Function AICanvasRejectWixUpdate
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 0
wix_check_next:
  EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
  StrCmp $1 "" wix_check_done
  IntOp $0 $0 + 1
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
  StrCmp $2 "$(^Name)" 0 wix_check_next
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
  StrCmp $2 "aicanvas" 0 wix_check_next
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
  StrCpy $3 $2 7
  StrCmp $3 "msiexec" 0 wix_check_next
  StrCpy $AICanvasUpdateError "$(AICanvasUpdateMsiError)"
wix_check_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function AICanvasCheckUpdateContext
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $AICanvasUpdateError ""
  StrCpy $AICanvasUpdateActive 0
  StrCpy $AICanvasUpdateOnce 0
  ${GetParameters} $AICanvasUpdateParameters
  ClearErrors
  ${GetOptions} $AICanvasUpdateParameters "/AICANVASUPDATEONCE=" $0
  IfErrors context_update_flag
  StrCpy $AICanvasUpdateOnce 1
  StrCpy $AICanvasUpdateOriginSid $0
  StrCpy $1 $AICanvasUpdateParameters 20
  StrCmpS $1 "/AICANVASUPDATEONCE=" 0 context_invalid
context_update_flag:
  ClearErrors
  ${GetOptions} $AICanvasUpdateParameters "/UPDATE" $0
  IfErrors context_not_update
  StrCmp $0 "" 0 context_invalid
  StrCpy $AICanvasUpdateActive 1
  ; Refuse truncated update command lines without changing normal installs.
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'kernel32::lstrlenW(p r0) i.r1'
  IntCmp $1 ${NSIS_MAX_STRLEN} context_invalid 0 context_invalid
  ; Keep the incoming SID separate while obtaining the actual process identity.
  StrCpy $2 $AICanvasUpdateOriginSid
  Call AICanvasReadUpdateIdentity
  StrCmp $AICanvasUpdateSid "" context_invalid
  StrCmp $AICanvasUpdateOnce 1 0 context_installation
  StrCmpS $2 $AICanvasUpdateSid 0 context_account
  StrCmp $AICanvasUpdateElevated 1 0 context_account
context_installation:
  ; Only the registered installation for this product/account is eligible.
  ; 'aicanvas' is this project's publisher derived from com.aicanvas.app.
  ReadRegStr $0 HKCU "Software\aicanvas\$(^Name)" ""
  StrCmp $0 "" context_invalid
  GetFullPathName $1 $0
  GetFullPathName $3 $INSTDIR
  StrCmp $1 $3 0 context_invalid
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$(^Name)" "UninstallString"
  StrCmp $0 '"$1\uninstall.exe"' 0 context_invalid
  IfFileExists "$1\uninstall.exe" 0 context_invalid
  StrCmp $AICanvasUpdateMainBinary "" context_directory
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$(^Name)" "MainBinaryName"
  StrCmp $0 $AICanvasUpdateMainBinary 0 context_invalid
context_directory:
  ; Require an existing local directory, excluding device/UNC and reparse roots.
  StrCpy $0 $1 2 1
  StrCmp $0 ":\" 0 context_invalid
  System::Call 'kernel32::GetFileAttributesW(w r1) i.r0'
  StrCmp $0 -1 context_invalid
  IntOp $0 $0 & 0x410
  IntCmp $0 0x10 0 context_invalid context_invalid
  Call AICanvasRejectWixUpdate
  Goto context_done
context_not_update:
  StrCmp $AICanvasUpdateOnce 0 context_done
context_invalid:
  StrCpy $AICanvasUpdateError "$(AICanvasUpdateContextError)"
  Goto context_done
context_account:
  StrCpy $AICanvasUpdateError "$(AICanvasUpdateAccountError)"
context_done:
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function AICanvasAbortUpdate
  SetErrorLevel 1
  IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "$AICanvasUpdateError"
  ; Abort in GUI callbacks is not an installation-section abort. Quit there with
  ; an explicit failure status so the reinstall page can never run afterwards.
  StrCmp $AICanvasUpdatePhase "gui" 0 +2
    Quit
  Abort "$AICanvasUpdateError"
FunctionEnd

Function AICanvasUpdateGuiInit
  StrCpy $AICanvasUpdatePhase "gui"
  Call AICanvasCheckUpdateContext
  StrCmp $AICanvasUpdateError "" +2
    Call AICanvasAbortUpdate
FunctionEnd

; No CREATE_ALWAYS, truncation, writes or deletion of existing files. The exact
; main executable must permit write/replacement; a new empty probe is removed
; automatically on close. Only ERROR_ACCESS_DENIED is eligible for one UAC retry.
Function AICanvasProbeUpdateWrites
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $AICanvasUpdateProbeError 0
  StrCpy $0 "$INSTDIR\$AICanvasUpdateMainBinary"
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  StrCmp $1 -1 probe_invalid
  IntOp $1 $1 & 0x410
  IntCmp $1 0 0 probe_invalid probe_invalid
  System::Call 'kernel32::CreateFileW(w r0, i 0x40010000, i 7, p 0, i 3, i 0x80, p 0) p.r1 ?e'
  Pop $2
  StrCmp $1 -1 probe_failed
  System::Call 'kernel32::CloseHandle(p r1) i.r2'
  StrCmp $2 0 probe_invalid
  System::Call 'kernel32::GetCurrentProcessId() i.r1'
  System::Call 'kernel32::GetTickCount() i.r2'
  StrCpy $3 0
probe_next:
  StrCpy $0 "$INSTDIR\.ai-canvas-update-$1-$2-$3.tmp"
  System::Call 'kernel32::CreateFileW(w r0, i 0x40010000, i 7, p 0, i 1, i 0x04000100, p 0) p.r4 ?e'
  Pop $AICanvasUpdateProbeError
  StrCmp $4 -1 probe_collision
  System::Call 'kernel32::CloseHandle(p r4) i.r4'
  StrCmp $4 0 probe_invalid
  ; An external handle can delay deletion. Do not claim cleanup or delete by
  ; name: it could already refer to a different file created by another process.
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r4 ?e'
  Pop $AICanvasUpdateProbeError
  StrCmp $4 -1 0 probe_invalid
  StrCmp $AICanvasUpdateProbeError 2 0 probe_invalid
  StrCpy $AICanvasUpdateProbeError 0
  Goto probe_done
probe_collision:
  StrCmp $AICanvasUpdateProbeError 80 probe_retry
  StrCmp $AICanvasUpdateProbeError 183 probe_retry probe_done
probe_retry:
  IntOp $3 $3 + 1
  IntCmp $3 8 probe_done probe_next probe_done
probe_failed:
  StrCpy $AICanvasUpdateProbeError $2
  Goto probe_done
probe_invalid:
  StrCpy $AICanvasUpdateProbeError 87
probe_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function AICanvasPrepareUpdateInstall
  Push $0
  Push $1
  StrCmp $AICanvasUpdateActive 1 0 prepare_done
  Call AICanvasProbeUpdateWrites
  StrCmp $AICanvasUpdateProbeError 0 prepare_done
  StrCmp $AICanvasUpdateProbeError 5 0 prepare_failed
  StrCmp $AICanvasUpdateOnce 0 0 prepare_failed
  StrCmp $AICanvasUpdateElevated 0 0 prepare_failed
  ; Silent callers must request elevation explicitly outside the installer.
  IfSilent prepare_failed
  ; Include the exe/quotes and fixed separators in the bound before building a
  ; string: StrCpy would otherwise silently truncate the final /D or app args.
  StrLen $0 $AICanvasUpdateParameters
  StrLen $1 $AICanvasUpdateSid
  IntOp $0 $0 + $1
  StrLen $1 $INSTDIR
  IntOp $0 $0 + $1
  StrLen $1 $EXEPATH
  IntOp $0 $0 + $1
  IntOp $0 $0 + 64
  IntCmp $0 ${NSIS_MAX_STRLEN} prepare_failed 0 prepare_failed
  ; NSIS removes /D from CMDLINE. Preserve GetParameters verbatim (/ARGS too),
  ; prepend only our context flag and put the original directory last, unquoted.
  StrCpy $0 "/AICANVASUPDATEONCE=$AICanvasUpdateSid $AICanvasUpdateParameters /D=$INSTDIR"
  ClearErrors
  ExecShell "runas" "$EXEPATH" "$0" SW_SHOWNORMAL
  IfErrors prepare_failed
  ; Only the installer was launched. This is not .onInstSuccess or an update
  ; completion result, and the main application is never relaunched elevated.
  SetErrorLevel 0
  Quit
prepare_failed:
  StrCpy $AICanvasUpdateError "$(AICanvasUpdateWriteError)"
  Call AICanvasAbortUpdate
prepare_done:
  ClearErrors
  Pop $1
  Pop $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  StrCpy $AICanvasUpdateMainBinary "${MAINBINARYNAME}.exe"
  StrCpy $AICanvasUpdatePhase "install"
  ; Also runs for /S, where .onGUIInit is not called. Validate the same account
  ; and installation before invoking even Tauri's existing current-user closer.
  Call AICanvasCheckUpdateContext
  StrCmp $AICanvasUpdateError "" +2
    Call AICanvasAbortUpdate
  ${If} $AICanvasUpdateActive = 1
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  ${EndIf}
  Call AICanvasPrepareUpdateInstall
!macroend

!define AICANVAS_PLUGIN_PACKAGE_PROGID "AICanvas.PluginPackage"

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  WriteRegStr HKCU "Software\Classes\${AICANVAS_PLUGIN_PACKAGE_PROGID}" "" "AI Canvas Plugin Package"
  WriteRegStr HKCU "Software\Classes\${AICANVAS_PLUGIN_PACKAGE_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr HKCU "Software\Classes\.aicplugin\OpenWithProgids" "${AICANVAS_PLUGIN_PACKAGE_PROGID}" ""
  ReadRegStr $0 HKCR ".aicplugin" ""
  ${If} $0 == ""
    WriteRegStr HKCU "Software\Classes\.aicplugin" "" "${AICANVAS_PLUGIN_PACKAGE_PROGID}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\com.aicanvas.app\director-desk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\${AICANVAS_PLUGIN_PACKAGE_PROGID}\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    ReadRegStr $0 HKCU "Software\Classes\.aicplugin" ""
    ${If} $0 == "${AICANVAS_PLUGIN_PACKAGE_PROGID}"
      DeleteRegValue HKCU "Software\Classes\.aicplugin" ""
    ${EndIf}
    DeleteRegValue HKCU "Software\Classes\.aicplugin\OpenWithProgids" "${AICANVAS_PLUGIN_PACKAGE_PROGID}"
    DeleteRegKey /ifempty HKCU "Software\Classes\.aicplugin\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.aicplugin"
    DeleteRegKey HKCU "Software\Classes\${AICANVAS_PLUGIN_PACKAGE_PROGID}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  Pop $0
!macroend
