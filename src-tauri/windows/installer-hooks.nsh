; Tauri NSIS installer hooks.
;
; berth-mcp.exe is the MCP stdio companion spawned by each agent CLI
; (claude / codex / opencode / ...), which is itself a grandchild of
; berth.exe. Windows does not propagate parent death to descendants the
; way Unix does, so stale berth-mcp.exe processes from a previous session
; can keep the binary file locked. The installer then fails to overwrite
; it with:
;
;     Error opening file for writing: ...\berth\berth-mcp.exe
;
; Stop any running companion processes before the installer writes new
; binaries (or removes the existing ones on uninstall). taskkill returns
; non-zero when no processes match, which is fine — we ignore the result.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running berth-mcp processes..."
  nsExec::Exec 'taskkill /F /T /IM berth-mcp.exe'
  Pop $0
  ; Small grace period so the OS releases file handles before the
  ; installer attempts to overwrite berth-mcp.exe.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any running berth-mcp processes..."
  nsExec::Exec 'taskkill /F /T /IM berth-mcp.exe'
  Pop $0
  Sleep 500
!macroend
