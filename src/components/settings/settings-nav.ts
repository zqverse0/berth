import {
  Cable,
  SlidersHorizontal,
  UserCog,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { create } from "zustand"
import { useIsMobile } from "@/hooks/use-mobile"
import type { SettingsPageId } from "@/lib/workspace/settings-tab"

/** 活动栏里设置的页面：「通用」合并外观与高级，侧栏列出它们的分节。 */
export type SettingsNavId = "model-providers" | "tools" | "experts" | "general"

export const SETTINGS_NAV: {
  id: SettingsNavId
  icon: LucideIcon
  labelKey: "modelProviders" | "tools" | "experts" | "general"
}[] = [
  { id: "model-providers", icon: Cable, labelKey: "modelProviders" },
  { id: "tools", icon: Wrench, labelKey: "tools" },
  { id: "experts", icon: UserCog, labelKey: "experts" },
  { id: "general", icon: SlidersHorizontal, labelKey: "general" },
]

/** 「通用」的分节：每页一组，侧栏点一节，中间只显示这一节。 */
export const GENERAL_SECTIONS = {
  appearance: [
    "language",
    "theme",
    "zoom",
    "font",
    "editorLanguages",
    "background",
  ],
  advanced: [
    "version",
    "proxy",
    "runtime",
    "backup",
    "translate",
    "classifier",
    "logs",
  ],
} as const

export type GeneralPage = keyof typeof GENERAL_SECTIONS

export const isGeneralPage = (page: string): page is GeneralPage =>
  page in GENERAL_SECTIONS

export function settingsNavOf(page: SettingsPageId): SettingsNavId {
  return isGeneralPage(page) ? "general" : page
}

export const useGeneralSectionStore = create<{ section: string | null }>(
  () => ({ section: null })
)

/** 该页当前显示的分节：选中的分节不属于这页（如从命令面板直接打开）时取第一节。 */
export function useGeneralSection(page: GeneralPage): string {
  const section = useGeneralSectionStore((s) => s.section)
  const sections: readonly string[] = GENERAL_SECTIONS[page]
  return section && sections.includes(section) ? section : sections[0]
}

/** 「通用」页里某节是否显示：桌面端只显示侧栏选中的那节，移动端没有侧栏，全部显示。 */
export function useGeneralSectionShown(page: GeneralPage) {
  const section = useGeneralSection(page)
  const isMobile = useIsMobile()
  return (id: (typeof GENERAL_SECTIONS)[GeneralPage][number]) =>
    isMobile || id === section
}
