export type WorkbenchScope = "global" | "project"

export type WorkbenchPageId = "settings"

export type WorkbenchPanelId =
  | "model-providers"
  | "tools"
  | "experts"
  | "appearance"
  | "advanced"

export interface WorkbenchPageDef {
  id: WorkbenchPageId
  scope: WorkbenchScope
}

export interface WorkbenchPanelDef {
  id: WorkbenchPanelId
  scope: WorkbenchScope
  factoryPageId: WorkbenchPageId
  labelKey: string
}

export interface ResolvedWorkbench {
  pages: Record<WorkbenchPageId, WorkbenchPanelId[]>
}
