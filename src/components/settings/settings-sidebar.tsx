"use client"

import { useTranslations } from "next-intl"
import { SettingsListTarget } from "@/components/settings/settings-split"
import {
  GENERAL_SECTIONS,
  SETTINGS_NAV,
  isGeneralPage,
  settingsNavOf,
  useGeneralSectionStore,
} from "@/components/settings/settings-nav"
import { useOpenWorkbenchPanel } from "@/hooks/workspace/use-open-workbench-panel"
import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"
import { cn } from "@/lib/utils"
import type { SettingsPageId } from "@/lib/workspace/settings-tab"

function useSettingsPage(): SettingsPageId {
  return (useWorkbenchLayout().selected.settings ??
    "model-providers") as SettingsPageId
}

/** 侧栏标题：当前设置页的名字（页面在活动栏切换）。 */
export function useSettingsTitle(): string {
  const t = useTranslations("Workbench.panels")
  const nav = settingsNavOf(useSettingsPage())
  return t(SETTINGS_NAV.find((item) => item.id === nav)!.labelKey)
}

/**
 * 侧栏「设置」视图的正文：当前页的列表（页面经 `SettingsSplit` 渲染进来）；
 * 「通用」没有自己的列表，这里列出外观与高级的分节。
 */
export function SettingsSidebar({ open }: { open: boolean }) {
  const page = useSettingsPage()
  if (isGeneralPage(page)) return <GeneralSections page={page} />
  // 侧栏收起时不提供落点，列表回到页内，免得藏在看不见的侧栏里。
  return open ? <SettingsListTarget /> : null
}

function GeneralSections({ page }: { page: keyof typeof GENERAL_SECTIONS }) {
  const tPanels = useTranslations("Workbench.panels")
  const t = useTranslations("SettingsShell.sections")
  const { openSettings } = useOpenWorkbenchPanel()
  const selected = useGeneralSectionStore((s) => s.section)
  return (
    <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      {(Object.keys(GENERAL_SECTIONS) as (keyof typeof GENERAL_SECTIONS)[]).map(
        (group) => (
          <div key={group} className="mb-2 flex flex-col gap-0.5">
            <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-muted-foreground">
              {tPanels(group)}
            </p>
            {GENERAL_SECTIONS[group].map((section, index) => {
              const active =
                page === group &&
                (selected === section ||
                  (index === 0 &&
                    !(GENERAL_SECTIONS[group] as readonly string[]).includes(
                      selected ?? ""
                    )))
              return (
                <button
                  key={section}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    useGeneralSectionStore.setState({ section })
                    openSettings(group)
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-left text-sm",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-foreground/80 hover:bg-muted/50 hover:text-foreground"
                  )}
                >
                  {t(section)}
                </button>
              )
            })}
          </div>
        )
      )}
    </nav>
  )
}
