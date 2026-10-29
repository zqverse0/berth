"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import {
  Copy,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  FolderOpenDot,
  FolderPlus,
  Laptop,
  MoreHorizontal,
  Pin,
  Search,
  Server,
  PencilLine,
  Tag,
  Trash2,
  X,
  XCircle,
} from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useOpenFolderPicker } from "@/hooks/workspace/use-open-folder-picker"
import { OPEN_PROJECT_SWITCHER_EVENT } from "@/components/layout/commands/commands"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import {
  detachedTerminalScopeFolderId,
  tabFromDescriptor,
} from "@/lib/terminal/create-and-open-primary-terminal"
import {
  refreshTerminalInventory,
  useTerminalInventorySnapshot,
} from "@/lib/terminal/terminal-inventory-query"
import { renameWorktree, updateFolderAlias } from "@/lib/api"
import { isDesktop, revealItemInDir } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { agentTypeForTool } from "@/hooks/use-agent-profiles"
import { FileTreeTab } from "@/components/layout/aux-panel/aux-panel-file-tree-tab"
import { copyPathToClipboard } from "@/components/layout/file-tree/file-tree-node"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { FolderAliasLabel } from "./folder-alias-label"
import {
  DetachedTerminalStrip,
  ProjectActiveSessionStrip,
  type SessionStripEntry,
} from "./project-active-session-strip"
import { ProjectGroupBadge } from "./project-group-badge"
import { useGroupUnreadPolling } from "@/lib/agent/group-unread"
import {
  NewWorktreeDialog,
  type NewWorktreeSource,
} from "./new-worktree-dialog"
import { projectRowOrder } from "./project-list-order"
import {
  SidebarDeviceSection,
  SidebarGroupHeader,
  useDeviceList,
} from "./sidebar-device-section"

/** 行图标中心所在的轴线；嵌套 worktree 右移一级，连接线画在顶层轴线上。 */
const RAIL_AXIS = "0.875rem"
const NESTED_STEP = "1.25rem"

const RECONCILE_AFTER_SLIDE_MS = 300

const ProjectRow = memo(function ProjectRow({
  folderId,
  folderName,
  folderAlias,
  folderPath,
  pinned,
  selected,
  worktree,
  nested,
  railBelow,
  worktreeBranch,
  onSelect,
  onNewWorktree,
  onRemoveFromWorkspace,
  onDeleteWorktree,
  onSetAlias,
  onRenameWorktree,
  onSetPinned,
  onOpenInSystemExplorer,
}: {
  folderId: number
  folderName: string
  /** User-set alias, or null. When present the row shows `alias [name]`. */
  folderAlias: string | null
  folderPath: string
  pinned: boolean
  selected: boolean
  /** git worktree 行：FolderGit2 图标 + 分支名，只能删除不能仅从列表移除。 */
  worktree: boolean
  /** 挂在 root 下：右移一级并画连接线。 */
  nested: boolean
  /** 下一行是嵌套 worktree 行。 */
  railBelow: boolean
  worktreeBranch: string | null
  onSelect: (folderId: number) => void
  onNewWorktree: (folderId: number) => void
  onRemoveFromWorkspace: (folderId: number) => void
  onDeleteWorktree: (folderId: number) => void
  onSetAlias: (folderId: number, alias: string | null) => void
  /** worktree：目录与分支一起改名。 */
  onRenameWorktree: (folderId: number, name: string) => void
  onSetPinned: (folderId: number, pinned: boolean) => void
  onOpenInSystemExplorer: (folderId: number) => void
}) {
  // Own the translations here rather than receiving `t` as a prop: next-intl
  // returns a fresh `t` on every parent render, which would defeat this memo.
  const t = useTranslations("Folder.sidebar")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const tBranch = useTranslations("Folder.branchDropdown")
  const systemExplorerLabel =
    typeof navigator === "undefined"
      ? tFileTree("openInFileManager")
      : (() => {
          const platform =
            `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
          if (platform.includes("mac")) return tFileTree("openInFinder")
          if (platform.includes("win")) return tFileTree("openInExplorer")
          return tFileTree("openInFileManager")
        })()
  // `revealItemInDir` only works inside Tauri; disable the entry elsewhere.
  const isDesktopMode = isDesktop()

  // Alias / rename dialog is a sibling of the ContextMenu so it survives the
  // menu closing on select. Seeded from the current alias / directory name.
  const [nameDialog, setNameDialog] = useState<"alias" | "rename" | null>(null)
  const [aliasValue, setAliasValue] = useState("")
  const openAliasDialog = useCallback(() => {
    setAliasValue(folderAlias ?? "")
    setNameDialog("alias")
  }, [folderAlias])
  const openRenameDialog = useCallback(() => {
    setAliasValue(folderPath.split(/[\\/]/).filter(Boolean).pop() ?? "")
    setNameDialog("rename")
  }, [folderPath])
  const confirmAlias = useCallback(() => {
    const trimmed = aliasValue.trim()
    if (nameDialog === "rename") {
      if (trimmed) onRenameWorktree(folderId, trimmed)
    } else {
      // Empty / whitespace clears the alias (null); the backend re-normalizes too.
      onSetAlias(folderId, trimmed ? trimmed : null)
    }
    setNameDialog(null)
  }, [aliasValue, folderId, nameDialog, onRenameWorktree, onSetAlias])

  const axis = nested ? `calc(${RAIL_AXIS} + ${NESTED_STEP})` : RAIL_AXIS

  return (
    <>
      {/* 项目行与它的 Agent 图标行是一个整体：整块可点选项目，悬停、选中的底色覆盖两行。
          块内的按钮（项目名、Agent 图标、更多）各自处理点击，这里只接空白处。 */}
      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return
          onSelect(folderId)
        }}
        className={cn(
          "group cursor-pointer rounded-xl transition-colors duration-150",
          selected
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-border"
            : "hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_2%)]"
        )}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="relative h-[2rem]">
              <div className="flex h-[1.9375rem] w-full items-center">
                <button
                  data-folder-id={folderId}
                  onClick={() => onSelect(folderId)}
                  title={folderPath}
                  aria-current={selected ? "location" : undefined}
                  className={cn(
                    "relative flex h-full min-w-0 flex-1 cursor-pointer items-center pr-[0.5rem] outline-none",
                    "rounded-full text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  )}
                  style={{ paddingLeft: `calc(${axis} + 0.875rem)` }}
                >
                  {/* 连接线：嵌套行在顶层轴线上画一段竖线，相邻行首尾相接成一条线。 */}
                  {nested ? (
                    <span
                      aria-hidden
                      data-project-rail
                      className="pointer-events-none absolute z-0 bg-sidebar-border"
                      style={{
                        top: "-0.0625rem",
                        bottom: "-0.0625rem",
                        left: RAIL_AXIS,
                        width: "0.125rem",
                        transform: "translateX(-50%)",
                      }}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute flex items-center justify-center"
                    style={{
                      top: "50%",
                      left: axis,
                      width: "0.875rem",
                      height: "0.875rem",
                      transform: "translate(-50%, -50%)",
                    }}
                  >
                    {worktree ? (
                      <FolderGit2 className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
                    ) : (
                      <FolderOpen className="h-3.5 w-3.5 text-chart-3" />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-[0.5rem]">
                    {pinned ? (
                      <Pin
                        aria-hidden
                        className="h-3 w-3 shrink-0 text-muted-foreground"
                      />
                    ) : null}
                    <span
                      className={cn(
                        "min-w-0 flex-shrink truncate text-left text-[0.875rem] font-medium text-sidebar-foreground",
                        !selected && "text-sidebar-foreground/85"
                      )}
                    >
                      {worktree && !folderAlias?.trim() ? (
                        (worktreeBranch ?? folderName)
                      ) : (
                        <FolderAliasLabel
                          name={folderName}
                          alias={folderAlias}
                          bracketClassName="text-sidebar-foreground"
                        />
                      )}
                    </span>
                  </div>
                </button>
                {/* 行尾的群组未读 / 等待标记。 */}
                <ProjectGroupBadge
                  folderId={folderId}
                  folderPath={folderPath}
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    // Re-open the SAME context menu as right-click: dispatch a
                    // synthetic contextmenu event that bubbles to the trigger.
                    const rect = e.currentTarget.getBoundingClientRect()
                    e.currentTarget.dispatchEvent(
                      new MouseEvent("contextmenu", {
                        bubbles: true,
                        cancelable: true,
                        button: 2,
                        clientX: rect.left,
                        clientY: rect.bottom,
                      })
                    )
                  }}
                  title={t("moreOptions")}
                  aria-label={t("moreOptions")}
                  aria-haspopup="menu"
                  className={cn(
                    "mr-[0.375rem] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-end rounded-[0.375rem] outline-none text-muted-foreground/90",
                    "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
                    "transition-[opacity,color] duration-150 hover:text-sidebar-foreground"
                  )}
                >
                  <MoreHorizontal className="h-[0.875rem] w-[0.875rem]" />
                </button>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {!worktree ? (
              <>
                <ContextMenuItem onSelect={() => onNewWorktree(folderId)}>
                  <FolderGit2 className="h-4 w-4" />
                  {tBranch("newWorktree")}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            <ContextMenuItem
              disabled={!isDesktopMode}
              onSelect={() => onOpenInSystemExplorer(folderId)}
            >
              <ExternalLink className="h-4 w-4" />
              {systemExplorerLabel}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                void copyPathToClipboard(
                  folderPath,
                  tFileTree("toasts.copyPathFailed")
                )
              }
            >
              <Copy className="h-4 w-4" />
              {tFileTree("copyPath")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onSetPinned(folderId, !pinned)}>
              <Pin className="h-4 w-4" />
              {pinned
                ? t("folderHeaderMenu.unpinProject")
                : t("folderHeaderMenu.pinProject")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={openAliasDialog}>
              <Tag className="h-4 w-4" />
              {t("folderHeaderMenu.setAlias")}
            </ContextMenuItem>
            {worktree ? (
              <ContextMenuItem onSelect={openRenameDialog}>
                <PencilLine className="h-4 w-4" />
                {t("folderHeaderMenu.renameWorktree")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            {/* worktree 跟随 git：只能删除，不能仅从列表移除（下次对账会回来）。 */}
            {worktree ? (
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onDeleteWorktree(folderId)}
              >
                <Trash2 className="h-4 w-4" />
                {t("folderHeaderMenu.deleteWorktree")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onRemoveFromWorkspace(folderId)}
              >
                <XCircle className="h-4 w-4" />
                {t("folderHeaderMenu.removeFromWorkspace")}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
        <ProjectActiveSessionStrip
          folderId={folderId}
          // 根项目名前多一个图钉位，名字与嵌套行同列：图标统一对齐到名字。
          indent={`calc(${RAIL_AXIS} + ${NESTED_STEP} + 0.5rem)`}
          // 嵌套行，或下面紧跟 worktree 的根行：图标行接着画竖线，树线不断。
          railAxis={nested || railBelow ? RAIL_AXIS : undefined}
        />
      </div>

      <Dialog
        open={nameDialog != null}
        onOpenChange={(open) => !open && setNameDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {nameDialog === "rename"
                ? t("folderHeaderMenu.renameWorktreeTitle")
                : t("folderHeaderMenu.setAliasTitle")}
            </DialogTitle>
          </DialogHeader>
          {nameDialog === "rename" ? (
            <p className="text-xs text-muted-foreground">
              {t("folderHeaderMenu.renameWorktreeHint")}
            </p>
          ) : null}
          <Input
            value={aliasValue}
            onChange={(e) => setAliasValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key === "Process") return
              if (e.key === "Enter") confirmAlias()
            }}
            placeholder={
              nameDialog === "rename"
                ? undefined
                : t("folderHeaderMenu.setAliasPlaceholder")
            }
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNameDialog(null)}>
              {t("folderHeaderMenu.setAliasCancel")}
            </Button>
            <Button onClick={confirmAlias}>
              {t("folderHeaderMenu.setAliasSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

export interface SidebarProjectListProps {
  /** Which pane to show — project list or the active project's files. */
  pane?: "projects" | "files"
  /** Ask the host to show the file pane. */
  onOpenFiles?: () => void
  /**
   * When false the list stays mounted (preserving local state) but the file-tree
   * child is unmounted and its watcher released; the root is hidden + inert and
   * the terminal inventory projection is paused.
   */
  visible?: boolean
}

/** 侧栏项目视图：项目 / worktree 列表、当前项目文件树，以及不属于任何项目的终端。 */
export function SidebarProjectList({
  pane = "projects",
  onOpenFiles,
  visible = true,
}: SidebarProjectListProps) {
  const t = useTranslations("Folder.sidebar")
  const tCommon = useTranslations("Folder.common")
  const tTerminal = useTranslations("Folder.terminal")
  const tFolderDropdown = useTranslations("Folder.folderNameDropdown")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const tSearch = useTranslations("Folder.search")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const removeFolderFromWorkspace = useAppWorkspaceStore(
    (s) => s.removeFolderFromWorkspace
  )
  const refreshFolder = useAppWorkspaceStore((s) => s.refreshFolder)
  const { activeFolder } = useActiveFolder()
  const activeIsRepo = useAppWorkspaceStore((s) =>
    activeFolder ? s.gitHeads.get(activeFolder.id)?.is_repo === true : false
  )
  const activeTabId = useTabStore((s) => s.activeTabId)
  const allPrimaryTabs = useTabStore((s) => s.tabs)
  // The shared inventory store refreshes at explicit boundaries only (no poll);
  // it is the only source for terminals the GUI did not open itself.
  const terminalInventory = useTerminalInventorySnapshot(visible)
  const {
    closeTabsByFolder,
    activateFolderWorkspace,
    openTerminalTab,
    switchTab,
  } = useTabActions()
  const { openFolderPicker } = useOpenFolderPicker()

  const folderById = useMemo(
    () => new Map(allFolders.map((f) => [f.id, f])),
    [allFolders]
  )
  const showFiles = pane === "files" && activeFolder != null

  // ── Search box: shared by both panes, cleared when the pane changes ────────
  const [query, setQuery] = useState("")
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fileSearchRequest = useAppUiStore((s) => s.projectFileSearchRequest)
  const fileSearchQuery = useAppUiStore((s) => s.projectFileSearchQuery)
  const consumeFileSearch = useAppUiStore((s) => s.consumeProjectFileSearch)

  useEffect(() => {
    setQuery("")
  }, [pane])

  useEffect(() => {
    // Pending request waits for the host to switch to the file pane.
    if (pane !== "files") return
    if (fileSearchRequest > 0 && fileSearchQuery != null) {
      setQuery(fileSearchQuery)
      consumeFileSearch()
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      })
    }
  }, [pane, fileSearchRequest, fileSearchQuery, consumeFileSearch])

  useEffect(() => {
    const openProjectList = () => {
      setQuery("")
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
    window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, openProjectList)
    return () =>
      window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, openProjectList)
  }, [])

  // 项目视图每次变为可见，对全部 root 与 git 对账一次：worktree 以 git 为准，
  // 非活动项目没有 HEAD 轮询，靠这里补齐。不依赖列表内容，避免对账结果回灌再触发。
  const hasProjects = folders.length > 0
  // 每个 root 起一个 git 进程；等侧栏滑入动画（240ms）结束再发，不跟动画抢主线程。
  // 动画期间又关上则取消。
  useEffect(() => {
    if (!visible || !hasProjects) return
    const timer = window.setTimeout(() => {
      const { folders: openFolders, refreshWorktreeFamily } =
        useAppWorkspaceStore.getState()
      const rootIds = openFolders
        .filter((f) => f.parent_id == null)
        .map((f) => f.id)
      void refreshWorktreeFamily(...rootIds)
    }, RECONCILE_AFTER_SLIDE_MS)
    return () => window.clearTimeout(timer)
  }, [hasProjects, visible])

  // 主项目一次返回它所有 worktree 群的未读数；角标只在项目列表里，列表隐藏时不轮询。
  useGroupUnreadPolling(
    useMemo(
      () =>
        folders
          .filter((f) => f.parent_id == null)
          .map((f) => ({ id: f.id, path: f.path })),
      [folders]
    ),
    visible
  )

  // 远程项目显示在所属设备下面，不进本机项目行；项目增删（含后端直接注册）后重读设备列表。
  const folderIdsKey = useMemo(
    () => folders.map((f) => f.id).join(","),
    [folders]
  )
  const { devices, reload: reloadDevices } = useDeviceList(
    visible && !showFiles,
    folderIdsKey
  )
  const remoteFolderIds = useMemo(
    () => new Set(devices.flatMap((d) => d.projects.map((p) => p.folderId))),
    [devices]
  )
  const matchesQuery = useCallback(
    (folderId: number) => {
      const q = query.trim().toLocaleLowerCase()
      if (!q) return true
      const folder = folderById.get(folderId)
      return [folder?.name, folder?.alias, folder?.path, folder?.git_branch]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(q))
    },
    [folderById, query]
  )
  const rows = useMemo(() => {
    const ordered = projectRowOrder(
      folders.filter((folder) => !remoteFolderIds.has(folder.id))
    )
    if (!query.trim()) return ordered
    return ordered.filter(({ folderId }) => matchesQuery(folderId))
  }, [folders, query, remoteFolderIds, matchesQuery])

  // ── Terminals that belong to no project ───────────────────────────────────
  // Folderless sessions (e.g. `berth tools run <agent> launch`) and sessions
  // whose folder id is no longer registered have no project row to sit under;
  // they are listed under their device (local machine or a remote device).
  const detachedEntries = useMemo<SessionStripEntry[]>(() => {
    const isDetached = (folderId: number | null) =>
      folderId == null || !folderById.has(folderId)
    const openTerminals = allPrimaryTabs.filter(isTerminalTab)
    const openTerminalIds = new Set(openTerminals.map((tab) => tab.terminalId))
    const seenTabIds = new Set<string>()
    const entries: SessionStripEntry[] = []
    for (const tab of openTerminals) {
      if (!isDetached(tab.folderId) || seenTabIds.has(tab.id)) continue
      seenTabIds.add(tab.id)
      const title = tab.title || "Terminal"
      entries.push({
        id: tab.id,
        title,
        agentType: tab.agentType ?? null,
        active: tab.id === activeTabId,
        onSelect: () => switchTab(tab.id),
      })
    }
    for (const descriptor of terminalInventory) {
      if (descriptor.status !== "running") continue
      if (openTerminalIds.has(descriptor.terminalId)) continue
      if (!isDetached(descriptor.folderId)) continue
      const id = `terminal:${descriptor.terminalId}`
      if (seenTabIds.has(id)) continue
      seenTabIds.add(id)
      const title = descriptor.title || "Terminal"
      const agentType = agentTypeForTool(descriptor.agentId)
      entries.push({
        id,
        title,
        agentType,
        active: id === activeTabId,
        onSelect: () => {
          const scope = detachedTerminalScopeFolderId(
            descriptor.initialCwd,
            folderById,
            descriptor.folderId,
            activeFolder?.id ?? null
          )
          // 已不存在的 daemon folder 只作为 detached UI scope；cwd 不能伪造新的
          // 项目归属，但必须留下显示路径让当前项目下仍可见。
          openTerminalTab(
            tabFromDescriptor(descriptor, {
              agentType: agentType ?? undefined,
              title,
              folderId: scope,
              detachedFolderPath: scope == null ? descriptor.initialCwd : null,
            }),
            true
          )
        },
      })
    }
    return entries
  }, [
    activeFolder?.id,
    activeTabId,
    allPrimaryTabs,
    folderById,
    openTerminalTab,
    switchTab,
    terminalInventory,
  ])

  // 无项目终端按设备归组：起始目录是设备目录（`localDir`）的归到该设备，其余归本机。
  const { looseEntries, deviceEntries } = useMemo(() => {
    const deviceByDir = new Map(devices.map((d) => [d.localDir, d.id]))
    const cwdById = new Map(
      terminalInventory.map((d) => [`terminal:${d.terminalId}`, d.initialCwd])
    )
    const loose: SessionStripEntry[] = []
    const byDevice = new Map<number, SessionStripEntry[]>()
    for (const entry of detachedEntries) {
      const cwd = cwdById.get(entry.id)
      const deviceId = cwd != null ? deviceByDir.get(cwd) : undefined
      if (deviceId == null) {
        loose.push(entry)
        continue
      }
      byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), entry])
    }
    return { looseEntries: loose, deviceEntries: byDevice }
  }, [detachedEntries, devices, terminalInventory])

  // 一级分组（本机、各设备）的折叠状态；键 `local` / `device:<id>`。
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({})
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] })),
    []
  )

  // ── Row actions ────────────────────────────────────────────────────────────
  const handleSelectFolder = useCallback(
    (folderId: number) => {
      const folder = folderById.get(folderId)
      if (!folder) return
      activateFolderWorkspace(folderId)
      // 群组是项目主页：恢复上次的文件，辅助面板切到该项目的群；开不开由用户自己决定。
      useAppUiStore.setState({ auxView: "group" })
    },
    [activateFolderWorkspace, folderById]
  )

  const handleSetFolderAlias = useCallback(
    async (folderId: number, alias: string | null) => {
      try {
        await updateFolderAlias(folderId, alias)
        await refreshFolder(folderId)
      } catch (err) {
        toast.error(
          t("toasts.setFolderAliasFailed", { message: toErrorMessage(err) })
        )
      }
    },
    [refreshFolder, t]
  )

  const handleRenameWorktree = useCallback(
    async (folderId: number, name: string) => {
      try {
        await renameWorktree(folderId, name)
        // 路径变了：旧路径下的文件 tab 已失效，关掉后按新路径重开。
        closeTabsByFolder(folderId)
        await useAppWorkspaceStore.getState().fetchFolders()
        toast.success(t("toasts.worktreeRenamed", { name }))
      } catch (err) {
        toast.error(
          t("toasts.worktreeRenameFailed", { message: toErrorMessage(err) })
        )
      }
    },
    [closeTabsByFolder, t]
  )

  const handleSetFolderPinned = useCallback(
    async (folderId: number, pinned: boolean) => {
      if (!folderById.has(folderId)) return
      try {
        await updateFolderAlias(folderId, null, pinned, false)
        await refreshFolder(folderId)
      } catch (err) {
        toast.error(
          t("toasts.pinFolderFailed", { message: toErrorMessage(err) })
        )
      }
    },
    [folderById, refreshFolder, t]
  )

  const handleOpenInSystemExplorer = useCallback(
    (folderId: number) => {
      const folder = folderById.get(folderId)
      if (!folder) return
      void revealItemInDir(folder.path).catch(() => {
        toast.error(tFileTree("toasts.openDirectoryFailed"))
      })
    },
    [folderById, tFileTree]
  )

  // 项目视图只有一个「新建 worktree」对话框，行菜单与顶栏按钮共用。
  const [addDeviceOpen, setAddDeviceOpen] = useState(false)
  const [worktreeSource, setWorktreeSource] =
    useState<NewWorktreeSource | null>(null)
  const handleNewWorktree = useCallback(
    (folderId: number) => {
      const folder = folderById.get(folderId)
      if (folder) setWorktreeSource({ folderId, folderPath: folder.path })
    },
    [folderById]
  )

  const [removeConfirm, setRemoveConfirm] = useState<{
    folderId: number
    folderName: string
    terminalCount: number
    deleteWorktree: boolean
  } | null>(null)

  const requestRemove = useCallback(
    (folderId: number, deleteWorktree: boolean) => {
      const folderName = folderById.get(folderId)?.name ?? String(folderId)
      void (async () => {
        let terminalCount = 0
        try {
          const terminals = await refreshTerminalInventory()
          terminalCount = terminals.filter(
            (item) => item.folderId === folderId && item.status === "running"
          ).length
        } catch {
          terminalCount = 0
        }
        setRemoveConfirm({
          folderId,
          folderName,
          terminalCount,
          deleteWorktree,
        })
      })()
    },
    [folderById]
  )
  const handleRemoveFromWorkspace = useCallback(
    (folderId: number) => requestRemove(folderId, false),
    [requestRemove]
  )
  const handleDeleteWorktree = useCallback(
    (folderId: number) => requestRemove(folderId, true),
    [requestRemove]
  )

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeConfirm) return
    const { folderId, folderName, deleteWorktree } = removeConfirm
    // 移除 root 会连带移除其 worktree 家族，先记下成员以便关闭它们的 tab。
    const familyIds = useAppWorkspaceStore
      .getState()
      .allFolders.filter((f) => f.parent_id === folderId)
      .map((f) => f.id)
    try {
      await removeFolderFromWorkspace(folderId, deleteWorktree)
      for (const id of [folderId, ...familyIds]) closeTabsByFolder(id)
      toast.success(
        deleteWorktree
          ? t("toasts.worktreeDeleted", { name: folderName })
          : t("toasts.folderRemoved", { name: folderName })
      )
    } catch (e) {
      const message = toErrorMessage(e)
      toast.error(
        deleteWorktree
          ? t("toasts.worktreeDeleteFailed", { message })
          : t("toasts.removeFolderFailed", { message })
      )
    } finally {
      setRemoveConfirm(null)
    }
  }, [removeConfirm, closeTabsByFolder, removeFolderFromWorkspace, t])

  // ── Render ─────────────────────────────────────────────────────────────────
  const openFolderButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void openFolderPicker()}
    >
      <FolderOpenDot className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      {tFolderDropdown("openFolder")}
    </Button>
  )

  const renderRow = (
    folderId: number,
    worktree: boolean,
    nested: boolean,
    railBelow: boolean
  ) => {
    const folder = folderById.get(folderId)
    if (!folder || !folders.some((f) => f.id === folderId)) return null
    return (
      <ProjectRow
        key={folderId}
        folderId={folderId}
        folderName={folder.name}
        folderAlias={folder.alias}
        folderPath={folder.path}
        pinned={folder.pinned_at != null}
        selected={activeFolder?.id === folderId}
        worktree={worktree}
        nested={nested}
        railBelow={railBelow}
        worktreeBranch={folder.git_branch}
        onSelect={handleSelectFolder}
        onNewWorktree={handleNewWorktree}
        onRemoveFromWorkspace={handleRemoveFromWorkspace}
        onDeleteWorktree={handleDeleteWorktree}
        onSetAlias={handleSetFolderAlias}
        onRenameWorktree={handleRenameWorktree}
        onSetPinned={handleSetFolderPinned}
        onOpenInSystemExplorer={handleOpenInSystemExplorer}
      />
    )
  }

  const deviceSection = (
    <SidebarDeviceSection
      devices={devices}
      onChanged={reloadDevices}
      renderProject={(folderId) =>
        matchesQuery(folderId) ? renderRow(folderId, false, false, false) : null
      }
      terminals={deviceEntries}
      collapsed={collapsedGroups}
      onToggle={toggleGroup}
      onProjectAdded={(folder) => {
        activateFolderWorkspace(folder.id)
        onOpenFiles?.()
      }}
      addOpen={addDeviceOpen}
      onAddOpenChange={setAddDeviceOpen}
    />
  )

  let body: React.ReactNode
  if (showFiles) {
    body = visible ? (
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileTreeTab
          key={activeFolder.id}
          closeSidebarOnMobile
          hideSearch
          searchQuery={query}
          onSearchQueryChange={setQuery}
        />
      </div>
    ) : null
  } else if (
    folders.length === 0 &&
    detachedEntries.length === 0 &&
    devices.length === 0
  ) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 text-xs text-muted-foreground">
        <span>{t("noProjects")}</span>
        {openFolderButton}
        {deviceSection}
      </div>
    )
  } else {
    body = (
      <ScrollArea className="min-h-0 flex-1 px-1.5 pb-1.5">
        <div className="flex flex-col pt-1">
          <SidebarGroupHeader
            icon={<Laptop aria-hidden className="size-3.5" />}
            label={t("devices.local")}
            collapsed={collapsedGroups.local === true}
            onToggle={() => toggleGroup("local")}
            actions={[
              {
                icon: FolderPlus,
                label: t("addProject"),
                onClick: () => void openFolderPicker(),
              },
            ]}
          />
          {collapsedGroups.local ? null : (
            <>
              {rows.map(({ folderId, worktree, nested }, index) =>
                renderRow(
                  folderId,
                  worktree,
                  nested,
                  rows[index + 1]?.nested ?? false
                )
              )}
              {query.trim() && rows.length === 0 ? (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {t("noProjectsFound")}
                </div>
              ) : null}
              {!query.trim() && rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <span>{t("noProjects")}</span>
                  {openFolderButton}
                </div>
              ) : null}
              <DetachedTerminalStrip
                entries={looseEntries}
                ariaLabel={t("devices.deviceTerminals", {
                  name: t("devices.local"),
                })}
              />
            </>
          )}
          {deviceSection}
        </div>
      </ScrollArea>
    )
  }

  return (
    <div
      data-testid="sidebar-project-list-root"
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        !visible && "hidden"
      )}
      aria-hidden={visible ? undefined : true}
      inert={visible ? undefined : true}
    >
      {pane === "projects" ? (
        <SidebarHeaderActions>
          {activeFolder && activeIsRepo ? (
            <SidebarHeaderButton
              icon={FolderGit2}
              label={t("newWorktreeForActive")}
              onClick={() => handleNewWorktree(activeFolder.id)}
            />
          ) : null}
          <SidebarHeaderButton
            icon={FolderPlus}
            label={t("addProject")}
            onClick={() => void openFolderPicker()}
          />
          <SidebarHeaderButton
            icon={Server}
            label={t("devices.addTitle")}
            onClick={() => setAddDeviceOpen(true)}
          />
        </SidebarHeaderActions>
      ) : null}

      <div className="shrink-0 border-b border-border/50 px-1.5 py-1.5">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                showFiles ||
                event.key !== "Enter" ||
                event.nativeEvent.isComposing
              )
                return
              // 回车切项目：有搜索词取第一条匹配，空搜索回到上一个项目
              const { recentFolderIds } = useAppWorkspaceStore.getState()
              const target = query.trim()
                ? rows[0]?.folderId
                : recentFolderIds.find(
                    (id) => id !== activeFolder?.id && folderById.has(id)
                  )
              if (target == null) return
              event.preventDefault()
              handleSelectFolder(target)
              setQuery("")
            }}
            placeholder={
              showFiles
                ? tSearch("filePlaceholder")
                : t("searchProjectsPlaceholder")
            }
            className="h-8 rounded-full bg-muted/30 pl-8 pr-8 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("clearSearch")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {body}

      <NewWorktreeDialog
        source={worktreeSource}
        onClose={() => setWorktreeSource(null)}
        onCreated={(detail) => {
          activateFolderWorkspace(detail.id)
          onOpenFiles?.()
        }}
      />

      <AlertDialog
        open={removeConfirm !== null}
        onOpenChange={(open) => !open && setRemoveConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removeConfirm?.deleteWorktree
                ? t("deleteWorktreeConfirmTitle")
                : t("removeFolderConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeConfirm?.deleteWorktree
                ? t("deleteWorktreeConfirmDescription", {
                    name: removeConfirm.folderName,
                  })
                : t("removeFolderConfirmDescription", {
                    name: removeConfirm?.folderName ?? "",
                  })}
              {(removeConfirm?.terminalCount ?? 0) > 0 ? (
                <span className="mt-2 block">
                  {tTerminal("folderTerminateDescription", {
                    count: removeConfirm?.terminalCount ?? 0,
                  })}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveConfirm}>
              {tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
