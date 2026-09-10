; NSIS hooks for the Cos Nostra installer (referenced from tauri.conf.json
; bundle.windows.nsis.installerHooks).
;
; The app links obs.dll at load time. The installer ships the 60 KB placeholder
; from libobs-bootstrapper as resources\obs-dummy.dll and copies it to
; $INSTDIR\obs.dll on a fresh install. On first launch the bootstrapper replaces
; it with the real OBS runtime (obs.dll, obs-plugins\, data\, ffmpeg DLLs, ...)
; extracted next to the exe, which is why the install runs per user into a
; directory that needs no elevation. Upgrades keep an existing obs.dll so the
; runtime is not re-downloaded.

!macro NSIS_HOOK_POSTINSTALL
  ${IfNot} ${FileExists} "$INSTDIR\obs.dll"
    CopyFiles /SILENT "$INSTDIR\resources\obs-dummy.dll" "$INSTDIR\obs.dll"
  ${EndIf}
!macroend

; Tauri's uninstaller only deletes the files it installed. Everything the OBS
; bootstrapper and the OBS plugins wrote next to the exe at runtime has to go
; here, before Tauri removes $INSTDIR itself.
!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\obs_new"
  RMDir /r "$INSTDIR\obs-plugins"
  RMDir /r "$INSTDIR\data"
  RMDir /r "$INSTDIR\platforms"
  RMDir /r "$INSTDIR\styles"
  RMDir /r "$INSTDIR\iconengines"
  RMDir /r "$INSTDIR\rtmp-services"
  RMDir /r "$INSTDIR\win-capture"
  RMDir /r "$INSTDIR\text-freetype2"
  Delete "$INSTDIR\obs.dll"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pdb"
  Delete "$INSTDIR\obs-amf-test.exe"
  Delete "$INSTDIR\obs-nvenc-test.exe"
  Delete "$INSTDIR\obs-qsv-test.exe"
  Delete "$INSTDIR\obs-ffmpeg-mux.exe"
  Delete "$INSTDIR\*.7z"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir "$INSTDIR\resources"
  RMDir "$INSTDIR"
!macroend
