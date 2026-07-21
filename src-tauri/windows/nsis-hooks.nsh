!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\com.aicanvas.app\director-desk"
!macroend
