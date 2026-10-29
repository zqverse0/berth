"use client"

import { memo, useEffect, useRef } from "react"
import { PanelLeft, Settings } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { useAttentionCount } from "@/lib/terminal/agent-panes"
import { usePlatform } from "@/hooks/use-platform"
import { hasNativeWindowChrome } from "@/lib/window-chrome"
import { cn } from "@/lib/utils"
import type { SettingsPageId } from "@/lib/workspace/settings-tab"
import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"
import { SETTINGS_NAV, settingsNavOf } from "@/components/settings/settings-nav"
import { commandHint } from "@/components/layout/commands/commands"
import {
  SIDEBAR_VIEWS,
  useSidebarViewLabel,
  useSidebarViewStore,
  type SidebarView,
} from "@/components/layout/sidebar/views"

const ICON_BUTTON =
  "relative size-9 shrink-0 rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"

/**
 * One icon per sidebar view. On desktop, clicking the active view while the
 * sidebar is open collapses it, and any view icon reopens a collapsed sidebar.
 */
export function SidebarViewNav({ className }: { className?: string }) {
  const t = useTranslations("Folder.sidebar")
  const view = useSidebarViewStore((state) => state.view)
  const setView = useSidebarViewStore((state) => state.setView)
  const sidebarOpen = useAppUiStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppUiStore((state) => state.toggleSidebar)
  const getLabel = useSidebarViewLabel()
  const { isActive: settingsActive, closeSettings } = useSettingsWorkspace()

  return (
    <nav
      aria-label={t("views")}
      className={cn("flex flex-col items-center gap-1.5", className)}
    >
      {SIDEBAR_VIEWS.map((item) => {
        const Icon = item.icon
        const active = sidebarOpen && view === item.id
        const label = getLabel(item.id)
        return (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            className={cn(
              ICON_BUTTON,
              active &&
                "bg-accent text-accent-foreground hover:bg-accent before:absolute before:-left-1.5 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-primary"
            )}
            onClick={() => {
              if (!sidebarOpen || view === item.id) toggleSidebar()
              setView(item.id)
              // 设置是模式：切到别的视图就退出设置。
              if (settingsActive) closeSettings()
            }}
            title={label}
            aria-label={label}
            aria-pressed={active}
          >
            <Icon className="size-[1.125rem]" />
            {item.id === "projects" ? <AttentionBadge /> : null}
          </Button>
        )
      })}
    </nav>
  )
}

/** 全部项目未读「需要关注」的 Agent 数，为 0 时不渲染。 */
function AttentionBadge() {
  const t = useTranslations("BerthTasks.panes")
  const count = useAttentionCount()
  if (count === 0) return null
  return (
    <span
      title={t("attentionCount", { count })}
      className="pointer-events-none absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[0.625rem] font-semibold leading-none text-white"
    >
      {count}
    </span>
  )
}

/**
 * 设置是模式：激活时侧栏切到设置视图（列出当前设置页的条目），离开设置时回到原视图。
 * 桌面由活动栏挂，手机（没有活动栏）由外壳挂。
 */
export function useSettingsViewSync() {
  const { isActive, closeSettings } = useSettingsWorkspace()
  const previous = useRef<SidebarView>("projects")
  useEffect(() => {
    const { view, setView } = useSidebarViewStore.getState()
    if (isActive) {
      if (view !== "settings") previous.current = view
      setView("settings")
      const ui = useAppUiStore.getState()
      if (!ui.sidebarOpen) ui.toggleSidebar()
    } else if (view === "settings") {
      // 点了中间的 tab：设置不留在后台。
      closeSettings()
      setView(previous.current)
    }
  }, [isActive, closeSettings])
}

/** 设置模式下齿轮上方的页面图标：每个设置页像一个独立视图（手机在侧栏图标列底部）。 */
export function SettingsPageNav() {
  const t = useTranslations("Workbench.panels")
  const tShell = useTranslations("SettingsShell")
  const { selected } = useWorkbenchLayout()
  const { openSettings } = useSettingsWorkspace()
  const current = settingsNavOf(
    (selected.settings ?? "model-providers") as SettingsPageId
  )
  return (
    <nav
      aria-label={tShell("title")}
      className="flex flex-col items-center gap-1.5 border-b border-border/50 ws-chrome-border pb-1.5"
    >
      {SETTINGS_NAV.map((item) => {
        const Icon = item.icon
        const active = current === item.id
        const label = t(item.labelKey)
        return (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            className={cn(
              ICON_BUTTON,
              active &&
                "bg-accent text-accent-foreground hover:bg-accent before:absolute before:-left-1.5 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-primary"
            )}
            onClick={() =>
              openSettings(item.id === "general" ? "appearance" : item.id)
            }
            title={label}
            aria-label={label}
            aria-pressed={active}
          >
            <Icon className="size-[1.125rem]" />
          </Button>
        )
      })}
    </nav>
  )
}

/**
 * Desktop activity bar: a fixed column left of the sidebar that stays visible
 * when the sidebar collapses. Top: sidebar toggle and views; bottom: settings
 * (its pages expand above the gear while settings is open). Adding a project lives in the
 * project list header.
 */
export const ActivityBar = memo(function ActivityBar() {
  useSettingsViewSync()
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const sidebarOpen = useAppUiStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppUiStore((state) => state.toggleSidebar)
  const {
    isActive: settingsActive,
    openSettings,
    closeSettings,
  } = useSettingsWorkspace()
  const { isMac } = usePlatform()
  // The macOS traffic lights sit over the top cell, so the toggle moves down.
  const macTrafficLights = isMac && hasNativeWindowChrome()

  const toggleLabel = tTitleBar(sidebarOpen ? "hideSidebar" : "showSidebar")
  const toggleButton = (
    <Button
      variant="ghost"
      size="icon"
      className={ICON_BUTTON}
      onClick={toggleSidebar}
      title={tTitleBar("withShortcut", {
        label: toggleLabel,
        shortcut: commandHint("toggle_sidebar"),
      })}
      aria-label={toggleLabel}
    >
      <PanelLeft className="size-[1.125rem]" />
    </Button>
  )

  return (
    <div
      data-activity-bar
      className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border/50 ws-chrome-border ws-surface-sidebar select-none"
    >
      <div
        data-tauri-drag-region
        className="flex h-10 w-full shrink-0 items-center justify-center border-b border-border/50 ws-chrome-border"
      >
        {macTrafficLights ? null : toggleButton}
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto no-scrollbar py-2">
        {macTrafficLights ? toggleButton : null}
        <SidebarViewNav />
      </div>
      <div className="flex w-full shrink-0 flex-col items-center gap-1.5 pb-2">
        {settingsActive ? <SettingsPageNav /> : null}
        <Button
          variant="ghost"
          size="icon"
          className={cn(ICON_BUTTON, settingsActive && "text-foreground")}
          aria-pressed={settingsActive}
          onClick={() => {
            if (settingsActive) {
              closeSettings()
              return
            }
            openSettings()
            if (!sidebarOpen) toggleSidebar()
          }}
          title={tTitleBar("withShortcut", {
            label: tTitleBar("openSettings"),
            shortcut: commandHint("open_settings"),
          })}
          aria-label={tTitleBar("openSettings")}
        >
          <Settings className="size-[1.125rem]" />
        </Button>
      </div>
    </div>
  )
})
