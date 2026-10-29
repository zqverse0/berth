export type SettingsPageId =
  | "model-providers"
  | "tools"
  | "experts"
  | "appearance"
  | "advanced"

export const SETTINGS_GLOBAL_TAB_ID = "settings" as const

export const SETTINGS_PAGE_IDS = [
  "model-providers",
  "tools",
  "experts",
  "appearance",
  "advanced",
] as const satisfies readonly SettingsPageId[]

export function isSettingsPageId(value: string): value is SettingsPageId {
  return (SETTINGS_PAGE_IDS as readonly string[]).includes(value)
}
