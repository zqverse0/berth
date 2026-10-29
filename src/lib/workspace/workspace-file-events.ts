export const WORKSPACE_FILE_SAVED_EVENT = "berth:workspace-file-saved"

export interface WorkspaceFileSavedDetail {
  path: string
}

export function emitWorkspaceFileSaved(path: string): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceFileSavedDetail>(WORKSPACE_FILE_SAVED_EVENT, {
      detail: { path },
    })
  )
}
