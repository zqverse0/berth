// 工作区命令唯一注册表：在这里登记命令和 Leader 键，在 WorkspaceCommandController
// 里实现 `run`。键位固定不可配置；`Ctrl+Space` 打开面板后按 `key` 执行。
export const WORKSPACE_COMMANDS = [
  { id: "switch_project", group: "project", key: "p" },
  { id: "open_project", group: "project", key: "o" },
  { id: "new_conversation", group: "creation", key: "n" },
  { id: "new_terminal", group: "creation", key: "c" },
  { id: "new_canvas", group: "creation" },
  { id: "open_files", group: "views", key: "f" },
  { id: "open_git", group: "views", key: "g" },
  { id: "open_berth_tasks", group: "views", key: "t" },
  { id: "open_group", group: "views", key: "m" },
  { id: "open_memory", group: "views", key: "k" },
  { id: "toggle_search", group: "views", key: "/" },
  { id: "toggle_sidebar", group: "workspace", key: "b" },
  { id: "toggle_aux_panel", group: "workspace", key: "a" },
  { id: "previous_tab", group: "tabs", key: "[" },
  { id: "next_tab", group: "tabs", key: "]" },
  { id: "focus_left_pane", group: "tabs", key: "h" },
  { id: "focus_right_pane", group: "tabs", key: "l" },
  { id: "close_tab", group: "tabs", key: "w" },
  { id: "close_all_file_tabs", group: "tabs" },
  { id: "open_settings", group: "settings", key: "," },
  { id: "open_settings_appearance", group: "settings" },
  { id: "open_settings_model_providers", group: "settings" },
  { id: "open_settings_version_control", group: "settings" },
  { id: "open_settings_advanced", group: "settings" },
] as const satisfies readonly {
  id: string
  group: string
  key?: string
}[]

export type WorkspaceCommand = (typeof WORKSPACE_COMMANDS)[number]
export type WorkspaceCommandId = WorkspaceCommand["id"]
export type WorkspaceCommandGroup = WorkspaceCommand["group"]

/** 放宽成统一形状，方便按 `key` 查找 */
export const COMMAND_KEYS: readonly { id: WorkspaceCommandId; key?: string }[] =
  WORKSPACE_COMMANDS

export const LEADER_LABEL = "Ctrl+Space"
export const OPEN_PROJECT_SWITCHER_EVENT = "berth:open-project-switcher"

/** 按钮 tooltip 用的完整键位提示，例如 `Ctrl+Space B`。 */
export function commandHint(id: WorkspaceCommandId): string {
  const key = COMMAND_KEYS.find((command) => command.id === id)?.key
  return key ? `${LEADER_LABEL} ${key.toUpperCase()}` : ""
}

/** 面板内单键 → 命令；字母大小写不敏感。 */
export function commandForKey(key: string): WorkspaceCommandId | undefined {
  const normalized = key.toLocaleLowerCase()
  return COMMAND_KEYS.find((command) => command.key === normalized)?.id
}
