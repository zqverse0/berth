"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { ChevronDown } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import { terminateTerminalSession } from "@/lib/api"
import {
  workspaceTabKey,
  type WorkspacePane,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"
import { FileWorkspaceTabItem } from "@/components/files/file-workspace-tab-item"
import { TabItem } from "@/components/tabs/tab-item"
import { cn } from "@/lib/utils"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface WorkspaceTabStripProps {
  pane: WorkspacePane
  /** Global tabs that remain ahead of regular tabs in this pane；参数是全部标签菜单，由前置 tab 放进自己的 actions。 */
  leadingTabs?: (tabListMenu: ReactNode) => ReactNode
  /** 前置 tab（辅助面板的群组）占着选中态：本组 tab 都画成未选中。 */
  leadingActive?: boolean
  /** 选中本组任一 tab 后调用（含点已选中的那个）。 */
  onTabSelected?: () => void
  className?: string
}

interface WorkspaceTabEntry {
  key: string
  ref: WorkspaceTabRef
  primaryTab?: TabItemData
  fileTab?: FileWorkspaceTab
}

/**
 * Both panes use one ordered workspace-tab projection. Domain adapters retain
 * close/pin/file semantics, while selection, ordering and cross-pane movement
 * are managed once here.
 */
export function WorkspaceTabStrip({
  pane,
  leadingTabs,
  leadingActive = false,
  onTabSelected,
  className,
}: WorkspaceTabStripProps) {
  const primaryTabs = useTabStore((state) => state.tabs)
  const {
    fileTabsByPane,
    orderedTabsByPane,
    activeWorkspaceTab,
    activeTabByPane,
    dragging,
    dragOverPane,
    dragInsertIndex,
  } = useWorkspaceLayoutProjection()
  const selectWorkspaceTab = useWorkspaceLayoutStore(
    (state) => state.selectWorkspaceTab
  )
  const moveWorkspaceTab = useWorkspaceLayoutStore(
    (state) => state.moveWorkspaceTab
  )
  const { closeFileTab, closeOtherFileTabs } = useWorkspaceRuntimeActions()
  const toggleFileTabGlobal = useWorkspaceFileStore(
    (state) => state.toggleFileTabGlobal
  )
  const { closeTab, closeOtherTabs, pinTab } = useTabActions()
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const { activeFolderId } = useActiveFolder()
  const branches = useAppWorkspaceStore((state) => state.branches)

  const entries = useMemo<WorkspaceTabEntry[]>(() => {
    const primaryById = new Map(primaryTabs.map((tab) => [tab.id, tab]))
    const fileById = new Map(
      Object.values(fileTabsByPane)
        .flat()
        .map((tab) => [tab.id, tab])
    )
    return orderedTabsByPane[pane].flatMap<WorkspaceTabEntry>((ref) => {
      if (ref.kind === "global") return []
      if (ref.kind === "primary") {
        const primaryTab = primaryById.get(ref.id)
        return primaryTab
          ? [{ key: workspaceTabKey(ref), ref, primaryTab }]
          : []
      }
      const fileTab = fileById.get(ref.id)
      return fileTab ? [{ key: workspaceTabKey(ref), ref, fileTab }] : []
    })
  }, [fileTabsByPane, orderedTabsByPane, pane, primaryTabs])

  const paneActiveTab = leadingActive ? null : activeTabByPane[pane]
  const selectTab = useCallback(
    (ref: WorkspaceTabRef) => {
      selectWorkspaceTab(ref)
      // 点 tab（含已激活的那个）收起项目首页
      useAppUiStore.setState({ projectHomeOver: null })
      onTabSelected?.()
    },
    [onTabSelected, selectWorkspaceTab]
  )
  const folderIndex = useMemo(() => {
    const map = new Map<number, { name: string }>()
    for (const folder of allFolders) map.set(folder.id, { name: folder.name })
    return map
  }, [allFolders])

  const scrollRef = useRef<HTMLDivElement>(null)
  // While a tab is dragged it leaves every strip; the target strip shows a
  // same-width gap where it would land (`workspace-tab-drag-controller`).
  const draggingKey = dragging ? workspaceTabKey(dragging) : null
  const displayedEntries = useMemo(
    () =>
      draggingKey
        ? entries.filter((entry) => entry.key !== draggingKey)
        : entries,
    [draggingKey, entries]
  )
  const gapIndex = draggingKey && dragOverPane === pane ? dragInsertIndex : null
  const activeIndex = displayedEntries.findIndex(
    (entry) =>
      paneActiveTab != null &&
      workspaceTabKey(entry.ref) === workspaceTabKey(paneActiveTab)
  )

  useEffect(() => {
    if (
      !activeWorkspaceTab ||
      activeWorkspaceTab.kind === "global" ||
      !scrollRef.current
    ) {
      return
    }
    const root = scrollRef.current
    const selector =
      activeWorkspaceTab.kind === "primary"
        ? `[data-tab-id="${activeWorkspaceTab.id}"]`
        : `[data-file-tab-id="${activeWorkspaceTab.id}"]`
    // 下一帧再量，只滚 tab 条自己：提交阶段的 scrollIntoView 会强制排版并滚动祖先，
    // 切项目时单这一步就近 100ms；没溢出（常见情况）直接跳过。
    const frame = requestAnimationFrame(() => {
      const tab = root.querySelector<HTMLElement>(selector)
      const list = tab?.closest<HTMLElement>('[role="tablist"]')
      if (!tab || !list || list.scrollWidth <= list.clientWidth) return
      const box = list.getBoundingClientRect()
      const rect = tab.getBoundingClientRect()
      if (rect.left < box.left) list.scrollLeft -= box.left - rect.left
      else if (rect.right > box.right) list.scrollLeft += rect.right - box.right
    })
    return () => cancelAnimationFrame(frame)
  }, [activeWorkspaceTab])

  const handleCloseToRight = useCallback(
    (targetIndex: number) => {
      const rightEntries = displayedEntries.slice(targetIndex + 1)
      if (rightEntries.length === 0) return

      const currentActiveKey =
        paneActiveTab != null ? workspaceTabKey(paneActiveTab) : null
      const willCloseActive = rightEntries.some(
        (entry) => workspaceTabKey(entry.ref) === currentActiveKey
      )
      if (willCloseActive) {
        const targetEntry = displayedEntries[targetIndex]
        if (targetEntry) {
          selectWorkspaceTab(targetEntry.ref)
        }
      }

      for (const entry of rightEntries) {
        if (entry.ref.kind === "primary") {
          const primary = primaryTabs.find((t) => t.id === entry.ref.id)
          if (primary && isTerminalTab(primary)) {
            void terminateTerminalSession(primary.terminalId).catch(() => {})
          }
          closeTab(entry.ref.id)
        } else {
          closeFileTab(entry.ref.id)
        }
      }
    },
    [
      closeFileTab,
      closeTab,
      displayedEntries,
      paneActiveTab,
      primaryTabs,
      selectWorkspaceTab,
    ]
  )

  // 传给 tab 的回调身份不变，只在调用时读当前列表。
  const latest = useRef({ displayedEntries, handleCloseToRight })
  useLayoutEffect(() => {
    latest.current = { displayedEntries, handleCloseToRight }
  })
  const closeToRightOf = useCallback((ref: WorkspaceTabRef) => {
    const key = workspaceTabKey(ref)
    const index = latest.current.displayedEntries.findIndex(
      (entry) => entry.key === key
    )
    if (index >= 0) latest.current.handleCloseToRight(index)
  }, [])
  const pinFileTab = useCallback(
    (tabId: string) => toggleFileTabGlobal(tabId, activeFolderId),
    [activeFolderId, toggleFileTabGlobal]
  )

  // A split needs a tab left behind, so a lone left tab can't split right.
  const groupMove =
    pane === "files" && orderedTabsByPane.files.length > 1
      ? "files-split"
      : pane === "files-split"
        ? "files"
        : undefined

  if (
    dragging === null &&
    displayedEntries.length === 0 &&
    leadingTabs == null
  ) {
    return null
  }

  const gap = (
    <div
      key="drag-gap"
      data-workspace-tab-placeholder
      aria-hidden
      className="h-full shrink-0 pt-1.5"
      style={{ width: "var(--berth-tab-drag-width)" }}
    >
      <div className="h-full rounded-t-lg bg-foreground/5" />
    </div>
  )

  const tabListMenu =
    displayedEntries.length > 1 ? (
      <TabListMenu entries={displayedEntries} onSelect={selectTab} />
    ) : null

  return (
    <div
      data-workspace-pane={pane}
      data-workspace-tab-strip={pane}
      className={cn(
        "flex h-full min-w-0 flex-1 items-stretch overflow-hidden",
        className
      )}
    >
      <div
        ref={scrollRef}
        data-workspace-tab-scroll
        className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {leadingTabs?.(tabListMenu)}
        <div
          role="tablist"
          // 滚动条隐藏：竖向滚轮横向滚动 tab 条
          onWheel={(event) => {
            if (event.deltaX === 0)
              event.currentTarget.scrollLeft += event.deltaY
          }}
          className={cn(
            // Chrome-style tab squeeze: the list yields (`shrink` + `min-w-0`) so
            // items trade width fairly down to their min width; past that the
            // list itself scrolls instead of squeezing titles away.
            "flex min-w-0 shrink items-stretch gap-0 overflow-x-auto overflow-y-hidden pr-2 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            leadingTabs == null && "pl-2"
          )}
        >
          {displayedEntries.flatMap((entry, index) => {
            const adjacentActive =
              activeIndex < 0
                ? undefined
                : index === activeIndex - 1
                  ? "before"
                  : index === activeIndex + 1
                    ? "after"
                    : undefined
            const active =
              paneActiveTab != null &&
              workspaceTabKey(entry.ref) === workspaceTabKey(paneActiveTab)
            const hasTabsToRight = index < displayedEntries.length - 1
            const item = entry.primaryTab ? (
              <TabItem
                key={entry.key}
                tab={entry.primaryTab}
                isActive={active}
                adjacentActive={adjacentActive}
                folderName={
                  entry.primaryTab.folderId != null
                    ? (folderIndex.get(entry.primaryTab.folderId)?.name ?? null)
                    : null
                }
                folderBranch={
                  entry.primaryTab.folderId != null
                    ? (branches.get(entry.primaryTab.folderId) ?? null)
                    : null
                }
                onSwitch={selectTab}
                onClose={closeTab}
                onCloseOthers={closeOtherTabs}
                onCloseToRight={closeToRightOf}
                hasTabsToRight={hasTabsToRight}
                onPin={pinTab}
                dragRef={entry.ref}
                groupMove={groupMove}
                onMoveToGroup={moveWorkspaceTab}
              />
            ) : entry.fileTab ? (
              <FileWorkspaceTabItem
                key={entry.key}
                tab={entry.fileTab}
                active={active}
                adjacentActive={adjacentActive}
                onSwitch={selectTab}
                onClose={closeFileTab}
                onCloseOthers={closeOtherFileTabs}
                onCloseToRight={closeToRightOf}
                hasTabsToRight={hasTabsToRight}
                onPin={pinFileTab}
                dragRef={entry.ref}
                groupMove={groupMove}
                onMoveToGroup={moveWorkspaceTab}
              />
            ) : null
            return index === gapIndex ? [gap, item] : [item]
          })}
          {gapIndex !== null && gapIndex >= displayedEntries.length && gap}
        </div>
        <div
          data-tauri-drag-region
          className="h-full min-w-10 flex-1 ws-strip-line"
        />
      </div>
      {leadingTabs == null && tabListMenu ? (
        <div className="flex shrink-0 items-center px-1 py-1.5 ws-strip-line">
          {tabListMenu}
        </div>
      ) : null}
    </div>
  )
}

/** tab 条上与 tab 并排的小按钮（全部标签、新建）：同高、同圆角、同悬停色。 */
export const TAB_TOOLBAR_BUTTON =
  "flex h-6 min-w-6 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-foreground/10 hover:text-foreground"

/** 弹层能用的最大宽度：不超出碰撞边界。 */
export const PANE_POPOVER_FIT =
  "max-w-[var(--radix-popover-content-available-width)]"

/**
 * tab 条上的弹层只在所在分栏（split pane）内展开，不压到相邻工作区：
 * 触发按钮 ref 挂 `trackTrigger`，PopoverContent 展开 `content`。
 */
export function usePaneBoundary() {
  const [boundary, setBoundary] = useState<Element | null>(null)
  // 分栏容器挂载后不变：触发按钮挂上时取一次
  const trackTrigger = useCallback(
    (el: HTMLButtonElement | null) =>
      setBoundary(el?.closest("[data-split-pane]") ?? null),
    []
  )
  return {
    trackTrigger,
    content: {
      align: "start" as const,
      collisionBoundary: boundary,
      collisionPadding: 8,
    },
  }
}

/** tab 多时按名字搜索跳转。 */
function TabListMenu({
  entries,
  onSelect,
}: {
  entries: WorkspaceTabEntry[]
  onSelect: (ref: WorkspaceTabRef) => void
}) {
  const t = useTranslations("Folder.tabs")
  const [open, setOpen] = useState(false)
  const { trackTrigger, content: paneContent } = usePaneBoundary()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trackTrigger}
          type="button"
          title={t("allTabs")}
          aria-label={t("allTabs")}
          className={TAB_TOOLBAR_BUTTON}
        >
          {entries.length}
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...paneContent}
        className={cn("w-80 p-0", PANE_POPOVER_FIT)}
      >
        <Command>
          <CommandInput placeholder={t("searchTabs")} />
          <CommandList>
            <CommandEmpty>{t("noTabsFound")}</CommandEmpty>
            {entries.map((entry) => {
              const title =
                entry.fileTab?.title ?? entry.primaryTab?.title ?? entry.key
              const detail = entry.fileTab?.description ?? null
              return (
                <CommandItem
                  key={entry.key}
                  value={`${title} ${detail ?? ""} ${entry.key}`}
                  onSelect={() => {
                    onSelect(entry.ref)
                    setOpen(false)
                  }}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{title}</span>
                    {detail ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {detail}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
