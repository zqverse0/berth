import type {
  ResolvedWorkbench,
  WorkbenchPageDef,
  WorkbenchPageId,
  WorkbenchPanelDef,
  WorkbenchPanelId,
} from "./types"

export const WORKBENCH_PAGES: readonly WorkbenchPageDef[] = [
  { id: "settings", scope: "global" },
]

export const WORKBENCH_PANELS: readonly WorkbenchPanelDef[] = [
  {
    id: "model-providers",
    scope: "global",
    factoryPageId: "settings",
    labelKey: "modelProviders",
  },
  {
    id: "tools",
    scope: "global",
    factoryPageId: "settings",
    labelKey: "tools",
  },
  {
    id: "experts",
    scope: "global",
    factoryPageId: "settings",
    labelKey: "experts",
  },
  {
    id: "appearance",
    scope: "global",
    factoryPageId: "settings",
    labelKey: "appearance",
  },
  {
    id: "advanced",
    scope: "global",
    factoryPageId: "settings",
    labelKey: "advanced",
  },
]

/** 面板归属固定：每个 page 按目录顺序列出自己的面板。 */
export const WORKBENCH_LAYOUT: ResolvedWorkbench = {
  pages: Object.fromEntries(
    WORKBENCH_PAGES.map((page) => [
      page.id,
      WORKBENCH_PANELS.filter((panel) => panel.factoryPageId === page.id).map(
        (panel) => panel.id
      ),
    ])
  ) as ResolvedWorkbench["pages"],
}

export function pageOfPanel(panelId: WorkbenchPanelId): WorkbenchPageId {
  return (
    WORKBENCH_PANELS.find((panel) => panel.id === panelId)?.factoryPageId ??
    "settings"
  )
}
