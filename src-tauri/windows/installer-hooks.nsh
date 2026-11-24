; Tauri NSIS installer hooks.
;
; berth-termd.exe (terminal daemon) and berth-cli.exe are bundled sidecars
; installed alongside berth-gui.exe. On Windows, running sidecar processes
; keep their executable files locked, causing upgrades or uninstalls to fail
; with "Error opening file for writing". Stop them before writing or removing
; binaries; taskkill returns non-zero when no processes match, which is fine.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running Berth sidecar processes..."
  nsExec::Exec 'taskkill /F /T /IM berth-termd.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM berth-cli.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any running Berth sidecar processes..."
  nsExec::Exec 'taskkill /F /T /IM berth-termd.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM berth-cli.exe'
  Pop $0
  Sleep 500
!macroend
