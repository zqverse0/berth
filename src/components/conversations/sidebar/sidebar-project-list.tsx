"use client"

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import {
  Copy,
  ExternalLink,
  FolderGit2,
  FolderInput,
  FolderOpenDot,
  FolderPlus,
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
import {
  NEXT_ATTENTION_EVENT,
  OPEN_PROJECT_SWITCHER_EVENT,
  OPEN_SESSION_SWITCHER_EVENT,
} from "@/components/layout/commands/commands"
import { tabFromDescriptor } from "@/lib/terminal/create-and-open-primary-terminal"
import {
  refreshTerminalInventory,
  useTerminalInventorySnapshot,
} from "@/lib/terminal/terminal-inventory-query"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"
import { deviceFolderId, parseDeviceRef } from "@/lib/transport/device"
import { renameWorktree, updateFolderAlias } from "@/lib/api"
import { isDesktop, revealItemInDir } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import {
  assignWorkspaceGroup,
  createWorkspaceGroup,
  defaultGroupId,
  moveWorkspaceGroup,
  normalizeWorkspaceGroups,
  pruneWorkspaceMembers,
  removeWorkspaceGroup,
  renameWorkspaceGroup,
  useWorkspaceGroupsStore,
  type WorkspaceGroup,
  type WorkspaceGroupsState,
} from "@/lib/workspace-groups"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { agentTypeForTool } from "@/hooks/use-agent-profiles"
import { copyPathToClipboard } from "@/components/layout/file-tree/file-tree-node"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
  SidebarHeaderTitle,
} from "@/components/layout/sidebar/sidebar-header"
import { useProjectPanelStore } from "@/components/layout/sidebar/views"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
import {
  ProjectRowButton,
  projectBlockClass,
  sessionIndent,
} from "./project-row-face"
import { ProjectGroupBadge } from "./project-group-badge"
import { useGroupUnreadPolling } from "@/lib/agent/group-unread"
import {
  NewWorktreeDialog,
  type NewWorktreeSource,
} from "./new-worktree-dialog"
import {
  DeviceFeed,
  DeviceProjectMenuItems,
  useDeviceDrop,
  useOsFileDropToDevices,
  type DeviceFeedState,
} from "./device-projects"
import {
  AddDeviceDialog,
  STATUS_DOT,
  notifyDevicesChanged,
  useDevices,
  type DeviceStatus,
} from "@/components/devices/devices"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { SessionRow } from "./session-row"
import {
  buildSidebarSessions,
  switcherOrder,
  type SidebarSession,
} from "./sidebar-sessions"
import { SessionSwitcher } from "./session-switcher"
import { useSidebarDrag } from "./use-sidebar-drag"
import {
  WorkspaceGroupDialog,
  WorkspaceGroupHeader,
  WorkspaceSwitcher,
} from "./workspace-group-header"
import {
  workspaceSections,
  workspaceSwitchTarget,
  type SectionFolder,
  type WorkspaceLast,
} from "./workspace-sections"

const RECONCILE_AFTER_SLIDE_MS = 300
/** 用户手动设过的工作区「完整 / 只看运行中」：界面状态，存本地，不进工作区文件。 */
const EXPANDED_KEY = "berth.sidebar.workspaceGroups.expanded"

/** 每个工作区上次停留的项目与标签页：界面状态，存本地。 */
const WORKSPACE_LAST_KEY = "berth.sidebar.workspaceLast"

function loadWorkspaceLast(): Record<string, WorkspaceLast> {
  try {
    return JSON.parse(localStorage.getItem(WORKSPACE_LAST_KEY) ?? "{}")
  } catch {
    return {}
  }
}

function loadExpanded(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(EXPANDED_KEY) ?? "{}"
    )
    return value && typeof value === "object"
      ? (value as Record<string, boolean>)
      : {}
  } catch {
    return {}
  }
}

/** 对方项目在行上要用的：所在设备与它的在线状态。 */
interface RowDevice {
  id: number
  name: string
  state: DeviceStatus
}

const ProjectRow = memo(function ProjectRow({
  folderId,
  folderName,
  folderAlias,
  folderPath,
  pinned,
  selected,
  worktree,
  nested,
  worktreeBranch,
  device,
  idle,
  groups,
  groupId,
  onSelect,
  onNewWorktree,
  onRemoveFromWorkspace,
  onDeleteWorktree,
  onSetAlias,
  onRenameWorktree,
  onSetPinned,
  onOpenInSystemExplorer,
  onMoveToGroup,
  onDragStart,
  onOfflineReason,
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
  worktreeBranch: string | null
  /** 对方设备的项目；本机为 null（本机不标）。 */
  device: RowDevice | null
  /** 没有会话：名称淡色。 */
  idle: boolean
  /** 可移到的工作区；worktree 跟着 root，为 null。 */
  groups: readonly WorkspaceGroup[] | null
  groupId: string
  onSelect: (folderId: number) => void
  onNewWorktree: (folderId: number) => void
  onRemoveFromWorkspace: (folderId: number) => void
  onDeleteWorktree: (folderId: number) => void
  onSetAlias: (folderId: number, alias: string | null) => void
  /** worktree：目录与分支一起改名。 */
  onRenameWorktree: (folderId: number, name: string) => void
  onSetPinned: (folderId: number, pinned: boolean) => void
  onOpenInSystemExplorer: (folderId: number) => void
  onMoveToGroup: (folderId: number, groupId: string) => void
  onDragStart: (folderId: number, event: PointerEvent) => void
  onOfflineReason: (deviceId: number) => void
}) {
  // Own the translations here rather than receiving `t` as a prop: next-intl
  // returns a fresh `t` on every parent render, which would defeat this memo.
  const t = useTranslations("Folder.sidebar")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const tBranch = useTranslations("Folder.branchDropdown")
  const tGroups = useTranslations("WorkspaceGroups")
  const live = device?.state === "online"
  const deviceDrop = useDeviceDrop(device?.id ?? 0, device != null && live)
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

  const offline = device?.state === "offline"
  const moveMenu = groups ? (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInput className="h-4 w-4" />
        {tGroups("moveTo")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {groups.map((group) => (
          <ContextMenuItem
            key={group.id}
            disabled={group.id === groupId}
            onSelect={() => onMoveToGroup(folderId, group.id)}
          >
            {group.emoji ? <span aria-hidden>{group.emoji}</span> : null}
            {group.name}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  ) : null

  return (
    <>
      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return
          onSelect(folderId)
        }}
        onPointerDown={
          groups ? (event) => onDragStart(folderId, event) : undefined
        }
        className={cn(projectBlockClass(selected), offline && "opacity-60")}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="relative h-[2rem]">
              <div className="flex h-[1.9375rem] w-full items-center">
                <ProjectRowButton
                  data-folder-id={folderId}
                  onClick={() => onSelect(folderId)}
                  name={folderName}
                  alias={folderAlias}
                  path={folderPath}
                  pinned={pinned}
                  selected={selected}
                  worktree={worktree}
                  nested={nested}
                  branch={worktreeBranch}
                  dim={idle}
                  disabled={device != null && !live}
                  badge={
                    device ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground">
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 rounded-full",
                            STATUS_DOT[device.state]
                          )}
                        />
                        {device.name}
                      </span>
                    ) : null
                  }
                  {...(device ? deviceDrop(folderPath) : {})}
                />
                {/* 行尾的群组未读 / 等待标记。 */}
                {device ? null : (
                  <ProjectGroupBadge
                    folderId={folderId}
                    folderPath={folderPath}
                  />
                )}
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
            {device ? (
              <>
                <DeviceProjectMenuItems
                  deviceId={device.id}
                  path={folderPath}
                />
                {moveMenu ? (
                  <>
                    <ContextMenuSeparator />
                    {moveMenu}
                  </>
                ) : null}
              </>
            ) : (
              <>
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
                <ContextMenuItem
                  onSelect={() => onSetPinned(folderId, !pinned)}
                >
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
                {moveMenu}
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
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        {offline && device ? (
          <button
            type="button"
            onClick={() => onOfflineReason(device.id)}
            className="block h-6 w-full truncate text-left text-xs text-muted-foreground hover:text-foreground"
            style={{ paddingLeft: sessionIndent(nested) }}
          >
            {tGroups("offlineReason")}
          </button>
        ) : null}
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
  /**
   * When false the list stays mounted (preserving local state); the root is
   * hidden + inert and the terminal inventory projection is paused.
   */
  visible?: boolean
  /** 下方面板最大化：列表保持挂载（滚动位置不丢），上面盖一行当前工作区摘要，点击还原。 */
  summaryOnly?: boolean
}

/** 列表里一个项目（本机或对方）：显示用的字段与所在设备。 */
interface ListFolder extends SectionFolder {
  alias: string | null
  git_branch: string | null
  device: number
}

type DragItem =
  | { kind: "project"; device: number; path: string }
  | { kind: "group"; id: string }

/**
 * 侧栏项目视图：按工作区分节——当前工作区完整（项目 → worktree → 会话），其他只看运行中的会话；
 * 本机与设备项目在同一张列表里；不属于任何项目的会话在「未归属会话」。
 */
export function SidebarProjectList({
  visible = true,
  summaryOnly = false,
}: SidebarProjectListProps) {
  const t = useTranslations("Folder.sidebar")
  const tCommon = useTranslations("Folder.common")
  const tTerminal = useTranslations("Folder.terminal")
  const tFolderDropdown = useTranslations("Folder.folderNameDropdown")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const tGroups = useTranslations("WorkspaceGroups")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
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
  const panes = useAllAgentPanes(visible)
  const seen = useAgentPaneStore((s) => s.seen)
  const {
    closeTabsByFolder,
    activateFolderWorkspace,
    leaveFolderWorkspace,
    openTerminalTab,
    switchTab,
  } = useTabActions()
  const { openFolderPicker } = useOpenFolderPicker()

  const folderById = useMemo(
    () => new Map(allFolders.map((f) => [f.id, f])),
    [allFolders]
  )
  // ── Search box ─────────────────────────────────────────────────────────────
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeSearch = useCallback(() => {
    setSearching(false)
    setQuery("")
  }, [])
  const openSearch = useCallback(() => {
    // 面板最大化时上方只有一行，放不下搜索框和结果
    useProjectPanelStore.getState().setMaximized(false)
    setSearching(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])

  useEffect(() => {
    const openProjectList = () => {
      setQuery("")
      openSearch()
    }
    window.addEventListener(OPEN_PROJECT_SWITCHER_EVENT, openProjectList)
    return () =>
      window.removeEventListener(OPEN_PROJECT_SWITCHER_EVENT, openProjectList)
  }, [openSearch])

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

  // ── Devices ────────────────────────────────────────────────────────────────
  const {
    devices,
    loaded: devicesLoaded,
    statusOf,
    reportProblem,
  } = useDevices()
  const { openDeviceTab } = useWorkspaceRuntimeActions()
  useOsFileDropToDevices()
  const [feeds, setFeeds] = useState<Record<number, DeviceFeedState>>({})
  const handleFeed = useCallback(
    (deviceId: number, feed: DeviceFeedState) => {
      reportProblem(deviceId, feed.problem)
      setFeeds((prev) =>
        prev[deviceId]?.overview === feed.overview &&
        prev[deviceId]?.problem === feed.problem
          ? prev
          : { ...prev, [deviceId]: feed }
      )
    },
    [reportProblem]
  )
  const rowDevices = useMemo(
    () =>
      new Map(
        devices.map((device) => [
          device.id,
          { id: device.id, name: device.name, state: statusOf(device).state },
        ])
      ),
    [devices, statusOf]
  )
  // 离线项目「查看原因」：打开该设备的设备页（检查清单写明哪一步不通）
  const handleOfflineReason = useCallback(
    (deviceId: number) => {
      const device = devices.find((item) => item.id === deviceId)
      if (device) openDeviceTab({ deviceId, title: device.name })
    },
    [devices, openDeviceTab]
  )

  // ── Projects of every device, one list ─────────────────────────────────────
  // 对方项目用概览（离线时为缓存）：id 换成本机身份（负数），路径保留对方的原样（工作区归属按它记）。
  const listFolders = useMemo(() => {
    const local: ListFolder[] = folders.map((folder) => ({
      ...folder,
      device: 0,
    }))
    const remote = devices.flatMap((device) =>
      (feeds[device.id]?.overview?.projects ?? []).map(
        (project): ListFolder => ({
          ...project,
          id: deviceFolderId(device.id, project.id),
          parent_id:
            project.parent_id == null
              ? null
              : deviceFolderId(device.id, project.parent_id),
          device: device.id,
        })
      )
    )
    return [...local, ...remote]
  }, [devices, feeds, folders])
  const listFolderById = useMemo(
    () => new Map(listFolders.map((folder) => [folder.id, folder])),
    [listFolders]
  )

  // ── Sessions ───────────────────────────────────────────────────────────────
  const sessions = useMemo(() => {
    const deviceByDir = new Map(devices.map((d) => [d.localDir, d.id]))
    return buildSidebarSessions({
      tabs: allPrimaryTabs,
      panes,
      inventory: terminalInventory,
      folders: listFolders,
      seen,
      // 不属于项目的终端：对方 GUI 的终端按 id 认设备，从设备开的 SSH 终端按起始目录认
      detachedDevice: (descriptor) =>
        parseDeviceRef(descriptor.terminalId)?.deviceId ??
        deviceByDir.get(descriptor.initialCwd) ??
        0,
    })
  }, [allPrimaryTabs, devices, listFolders, panes, seen, terminalInventory])

  // ── Workspace groups ───────────────────────────────────────────────────────
  const storedGroups = useWorkspaceGroupsStore((s) => s.state)
  const loadGroups = useWorkspaceGroupsStore((s) => s.load)
  const updateGroups = useWorkspaceGroupsStore((s) => s.update)
  const defaultName = tGroups("defaultName")
  useEffect(() => {
    if (useWorkspaceGroupsStore.getState().state) return
    loadGroups(defaultName).catch((error) =>
      toast.error(tGroups("loadFailed"), {
        description: toErrorMessage(error),
      })
    )
  }, [defaultName, loadGroups, tGroups])
  // 读不到时（后端出错）按只有「默认」显示，不写文件
  const groups = useMemo(
    () => storedGroups ?? normalizeWorkspaceGroups(null, defaultName),
    [defaultName, storedGroups]
  )
  const changeGroups = useCallback(
    (change: (state: WorkspaceGroupsState) => WorkspaceGroupsState) =>
      updateGroups(change).catch((error) =>
        toast.error(tGroups("saveFailed"), {
          description: toErrorMessage(error),
        })
      ),
    [tGroups, updateGroups]
  )

  const [expanded, setExpanded] = useState(loadExpanded)
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
    } catch {
      // 存不下只影响重启后的展开状态
    }
  }, [expanded])

  // 切到没有项目的工作区：没有当前项目可推导，记下它；选中项目后自动失效
  const [emptyGroup, setEmptyGroup] = useState<string | null>(null)

  const current = useMemo(() => {
    if (activeFolder == null || !listFolderById.has(activeFolder.id))
      return null
    return {
      device: listFolderById.get(activeFolder.id)!.device,
      folderId: activeFolder.id,
    }
  }, [activeFolder, listFolderById])

  const { sections, unassigned } = useMemo(
    () =>
      workspaceSections({
        state: groups,
        devices: [
          { device: 0, folders: listFolders.filter((f) => f.device === 0) },
          ...devices.map((device) => ({
            device: device.id,
            folders: listFolders.filter((f) => f.device === device.id),
          })),
        ],
        sessions,
        current,
        selectedGroup: activeFolder == null ? emptyGroup : null,
        manual: expanded,
      }),
    [
      activeFolder,
      current,
      devices,
      emptyGroup,
      expanded,
      groups,
      listFolders,
      sessions,
    ]
  )
  const currentGroupId = sections.find((section) => section.current)?.group.id

  // 每个工作区上次停留的项目与标签页：切回来时恢复
  const lastByGroup = useRef<Record<string, WorkspaceLast> | null>(null)
  lastByGroup.current ??= loadWorkspaceLast()
  const activeFolderId = activeFolder?.id
  useEffect(() => {
    if (!currentGroupId || activeFolderId == null) return
    lastByGroup.current![currentGroupId] = {
      folderId: activeFolderId,
      tabId: activeTabId,
    }
    try {
      localStorage.setItem(
        WORKSPACE_LAST_KEY,
        JSON.stringify(lastByGroup.current)
      )
    } catch {
      // 存不下只影响重启后切回工作区的落点
    }
  }, [activeFolderId, activeTabId, currentGroupId])

  /** root 项目的（设备, 路径）：worktree 跟着 root，孤儿 worktree 用自己的。 */
  const rootOf = useCallback(
    (folderId: number) => {
      const folder = listFolderById.get(folderId)
      if (!folder) return null
      const root =
        folder.parent_id == null ? folder : listFolderById.get(folder.parent_id)
      return { device: folder.device, path: (root ?? folder).path }
    },
    [listFolderById]
  )

  // 新打开的项目进当前工作区（从某个空工作区点「添加项目」则进那个工作区）。
  // 每台设备第一次读到的项目是已有的，不算新打开。
  const seenRoots = useRef<Map<number, Set<string>>>(new Map())
  const lastGroup = useRef<string | null>(null)
  const addTarget = useRef<string | null>(null)
  useEffect(() => {
    if (!foldersHydrated || !storedGroups) return
    const fresh: { device: number; path: string }[] = []
    const byDevice = new Map<number, string[]>()
    for (const folder of listFolders) {
      if (folder.parent_id != null && listFolderById.has(folder.parent_id))
        continue
      byDevice.set(folder.device, [
        ...(byDevice.get(folder.device) ?? []),
        folder.path,
      ])
    }
    for (const [device, paths] of byDevice) {
      const known = seenRoots.current.get(device)
      if (known)
        for (const path of paths)
          if (!known.has(path)) fresh.push({ device, path })
      seenRoots.current.set(device, new Set(paths))
    }
    const target = addTarget.current ?? lastGroup.current
    if (fresh.length > 0 && target) {
      addTarget.current = null
      void changeGroups((state) =>
        fresh.reduce(
          (next, root) =>
            assignWorkspaceGroup(next, root.device, root.path, target),
          state
        )
      )
    }
    if (currentGroupId) lastGroup.current = currentGroupId
  }, [
    changeGroups,
    currentGroupId,
    foldersHydrated,
    listFolderById,
    listFolders,
    storedGroups,
  ])

  // 丢掉失效的登记：本机项目已移除、设备已移除（设备离线不算）。
  useEffect(() => {
    if (!foldersHydrated || !devicesLoaded || !storedGroups) return
    const localPaths = new Set(
      allFolders.filter((f) => f.id > 0).map((f) => f.path)
    )
    const deviceIds = new Set(devices.map((device) => device.id))
    void changeGroups((state) =>
      pruneWorkspaceMembers(state, localPaths, deviceIds)
    )
  }, [
    allFolders,
    changeGroups,
    devices,
    devicesLoaded,
    foldersHydrated,
    storedGroups,
  ])

  const handleMoveToGroup = useCallback(
    (folderId: number, groupId: string) => {
      const root = rootOf(folderId)
      if (!root) return
      void changeGroups((state) =>
        assignWorkspaceGroup(state, root.device, root.path, groupId)
      )
    },
    [changeGroups, rootOf]
  )
  const startDrag = useSidebarDrag<DragItem>((item, groupId) => {
    if (item.kind === "project") {
      void changeGroups((state) =>
        assignWorkspaceGroup(state, item.device, item.path, groupId)
      )
      return
    }
    if (item.id === groupId) return
    void changeGroups((state) =>
      moveWorkspaceGroup(
        state,
        item.id,
        state.groups.findIndex((group) => group.id === groupId)
      )
    )
  })
  const handleRowDrag = useCallback(
    (folderId: number, event: PointerEvent) => {
      // 行上的按钮（更多、会话）自己处理
      if ((event.target as HTMLElement).closest("[aria-haspopup]")) return
      const root = rootOf(folderId)
      if (root) startDrag({ kind: "project", ...root }, event)
    },
    [rootOf, startDrag]
  )

  // 工作区的新建 / 改名 / 删除
  const [editingGroup, setEditingGroup] = useState<{
    group: WorkspaceGroup | null
  } | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<WorkspaceGroup | null>(
    null
  )
  const saveGroup = (name: string, emoji: string | null) => {
    const group = editingGroup?.group
    setEditingGroup(null)
    void changeGroups((state) =>
      group
        ? renameWorkspaceGroup(state, group.id, name, emoji)
        : createWorkspaceGroup(state, crypto.randomUUID(), name, emoji)
    )
  }

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

  const selectSession = useCallback(
    (session: SidebarSession) => {
      if (session.tabId) switchTab(session.tabId)
      else if (session.descriptor) {
        const descriptor = session.descriptor
        // 未归属的终端不按 cwd 补项目，留下显示路径
        openTerminalTab(
          session.folderId == null
            ? tabFromDescriptor(descriptor, {
                agentType: agentTypeForTool(descriptor.agentId) ?? undefined,
                title: session.title,
                folderId: null,
                detachedFolderPath: descriptor.initialCwd,
              })
            : tabFromDescriptor(descriptor),
          true
        )
      }
      // 点的是 Agent / 终端：辅助面板显示终端，不停在项目群组页
      useAppUiStore.getState().showAuxView("terminals")
    },
    [openTerminalTab, switchTab]
  )

  const listViewport = useRef<HTMLElement | null>(null)
  const switchWorkspace = useCallback(
    (groupId: string) => {
      if (groupId === currentGroupId) return
      const section = sections.find((item) => item.group.id === groupId)
      if (!section) return
      // 切换后两个工作区回到自动收放，列表回到顶部
      setExpanded((prev) => {
        const next = { ...prev }
        delete next[groupId]
        if (currentGroupId) delete next[currentGroupId]
        return next
      })
      if (listViewport.current) listViewport.current.scrollTop = 0
      const target = workspaceSwitchTarget(
        section,
        lastByGroup.current?.[groupId]
      )
      if (target.kind === "session") selectSession(target.session)
      else if (target.kind === "folder") handleSelectFolder(target.folderId)
      else {
        setEmptyGroup(groupId)
        leaveFolderWorkspace()
      }
    },
    [
      currentGroupId,
      handleSelectFolder,
      leaveFolderWorkspace,
      sections,
      selectSession,
    ]
  )

  // 所有工作区（含收起的）与未归属的会话，按列表顺序
  const listedSessions = useMemo(
    () => [
      ...sections.flatMap((section) =>
        section.rows.flatMap((row) => row.sessions)
      ),
      ...unassigned,
    ],
    [sections, unassigned]
  )
  // 需关注：点一次跳到当前之后的下一个
  const attention = useMemo(
    () => listedSessions.filter((session) => session.dot === "attention"),
    [listedSessions]
  )
  const jumpToAttention = useCallback(() => {
    const at = attention.findIndex((session) => session.tabId === activeTabId)
    const next = attention[(at + 1) % attention.length]
    if (next) selectSession(next)
  }, [activeTabId, attention, selectSession])

  // 会话切换器：最近用过的顺序随打开事件带来，开着时不跳动；null 为关闭
  const [switcherRecent, setSwitcherRecent] = useState<
    readonly string[] | null
  >(null)
  useEffect(() => {
    const openSwitcher = (event: Event) =>
      setSwitcherRecent((event as CustomEvent<readonly string[]>).detail)
    const nextAttention = () => {
      if (attention.length === 0) toast.info(tGroups("noAttention"))
      else jumpToAttention()
    }
    window.addEventListener(OPEN_SESSION_SWITCHER_EVENT, openSwitcher)
    window.addEventListener(NEXT_ATTENTION_EVENT, nextAttention)
    return () => {
      window.removeEventListener(OPEN_SESSION_SWITCHER_EVENT, openSwitcher)
      window.removeEventListener(NEXT_ATTENTION_EVENT, nextAttention)
    }
  }, [attention.length, jumpToAttention, tGroups])

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

  // ── Search ─────────────────────────────────────────────────────────────────
  const q = query.trim().toLocaleLowerCase()
  const matches = useCallback(
    (folder: ListFolder) =>
      [folder.name, folder.alias, folder.path, folder.git_branch]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(q)),
    [q]
  )
  const searchHits = useMemo(
    () =>
      q
        ? sections.flatMap((section) =>
            section.rows.filter((row) =>
              matches(listFolderById.get(row.slot.folderId)!)
            )
          )
        : [],
    [listFolderById, matches, q, sections]
  )
  const sessionHits = useMemo(
    () =>
      q
        ? listedSessions.filter((session) =>
            session.title.toLocaleLowerCase().includes(q)
          )
        : [],
    [listedSessions, q]
  )
  const pickSearchedFolder = useCallback(
    (folderId: number) => {
      handleSelectFolder(folderId)
      closeSearch()
    },
    [closeSearch, handleSelectFolder]
  )

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

  /** 项目所在项目名（「项目 ⎇ 分支」）：只看运行中、未归属的会话行右侧用。 */
  const projectLabel = (folderId: number | null) => {
    const folder = folderId == null ? null : listFolderById.get(folderId)
    if (!folder) return null
    const root =
      folder.parent_id == null ? null : listFolderById.get(folder.parent_id)
    const name = (root ?? folder).alias || (root ?? folder).name
    return root ? `${name} ⎇ ${folder.git_branch ?? folder.name}` : name
  }

  const switcherEntries = (() => {
    if (!switcherRecent) return []
    const groupOf = new Map(
      sections.flatMap((section) =>
        section.rows.flatMap((row) =>
          row.sessions.map(
            (session) => [session.id, section.group.name] as const
          )
        )
      )
    )
    return switcherOrder(listedSessions, switcherRecent, activeTabId).map(
      (session) => ({
        session,
        project: projectLabel(session.folderId),
        group: groupOf.get(session.id) ?? tGroups("unassigned"),
      })
    )
  })()

  const renderSession = (
    session: SidebarSession,
    indent: string,
    trailing?: string | null,
    afterSelect?: () => void
  ) => (
    <SessionRow
      key={session.id}
      title={session.title}
      notification={session.notification}
      agentType={session.agentType}
      dot={session.dot}
      active={session.tabId != null && session.tabId === activeTabId}
      indent={indent}
      trailing={trailing}
      onSelect={() => {
        selectSession(session)
        afterSelect?.()
      }}
    />
  )

  const renderRow = (
    row: (typeof sections)[number]["rows"][number],
    groupId: string,
    withSessions: boolean,
    onSelect = handleSelectFolder
  ) => {
    const folder = listFolderById.get(row.slot.folderId)!
    return (
      <div key={folder.id}>
        <ProjectRow
          folderId={folder.id}
          folderName={folder.name}
          folderAlias={folder.alias}
          folderPath={folder.path}
          pinned={folder.pinned_at != null}
          selected={activeFolder?.id === folder.id}
          worktree={row.slot.worktree}
          nested={row.slot.nested}
          worktreeBranch={folder.git_branch}
          device={rowDevices.get(row.device) ?? null}
          idle={row.sessions.length === 0}
          groups={row.slot.worktree ? null : groups.groups}
          groupId={groupId}
          onSelect={onSelect}
          onNewWorktree={handleNewWorktree}
          onRemoveFromWorkspace={handleRemoveFromWorkspace}
          onDeleteWorktree={handleDeleteWorktree}
          onSetAlias={handleSetFolderAlias}
          onRenameWorktree={handleRenameWorktree}
          onSetPinned={handleSetFolderPinned}
          onOpenInSystemExplorer={handleOpenInSystemExplorer}
          onMoveToGroup={handleMoveToGroup}
          onDragStart={handleRowDrag}
          onOfflineReason={handleOfflineReason}
        />
        {withSessions
          ? row.sessions.map((session) =>
              renderSession(session, sessionIndent(row.slot.nested))
            )
          : null}
      </div>
    )
  }

  const sectionSummary = (section: (typeof sections)[number]) =>
    section.attention + section.working > 0
      ? [
          section.attention > 0
            ? tGroups("attentionCount", { count: section.attention })
            : null,
          section.working > 0
            ? tGroups("workingCount", { count: section.working })
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : tGroups("projectCount", { count: section.projectCount })

  const runningIndent = sessionIndent(false)
  let body: React.ReactNode
  if (
    listFolders.length === 0 &&
    sessions.length === 0 &&
    devices.length === 0
  ) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 text-xs text-muted-foreground">
        <span>{t("noProjects")}</span>
        {openFolderButton}
      </div>
    )
  } else if (q) {
    // 搜索：跨工作区平铺匹配的项目与会话，点结果后收起
    body = (
      <ScrollArea className="min-h-0 flex-1 px-1.5 pb-1.5">
        <div className="flex flex-col pt-1">
          {searchHits.map((row) =>
            renderRow(row, "", false, pickSearchedFolder)
          )}
          {sessionHits.map((session) =>
            renderSession(
              session,
              runningIndent,
              projectLabel(session.folderId),
              closeSearch
            )
          )}
          {searchHits.length + sessionHits.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              {t("noProjectsFound")}
            </div>
          ) : null}
        </div>
      </ScrollArea>
    )
  } else {
    body = (
      <ScrollArea
        className="min-h-0 flex-1 px-1.5 pb-1.5"
        onViewportRef={(element) => {
          listViewport.current = element
        }}
      >
        <div className="flex flex-col">
          {sections.map((section) => {
            const { group } = section
            return (
              <section key={group.id} aria-label={group.name}>
                <WorkspaceGroupHeader
                  group={group}
                  current={section.current}
                  full={section.full}
                  summary={sectionSummary(section)}
                  onSwitch={() => switchWorkspace(group.id)}
                  onToggle={() =>
                    setExpanded((prev) => ({
                      ...prev,
                      [group.id]: !section.full,
                    }))
                  }
                  onDragStart={(event) =>
                    startDrag({ kind: "group", id: group.id }, event)
                  }
                  onRename={() => setEditingGroup({ group })}
                  onCreate={() => setEditingGroup({ group: null })}
                  onDelete={() => setDeletingGroup(group)}
                />
                {section.full ? (
                  section.rows.length > 0 ? (
                    section.rows.map((row) => renderRow(row, group.id, true))
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                      <span className="min-w-0 truncate">
                        {tGroups("noProjects")}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-primary hover:underline"
                        onClick={() => {
                          addTarget.current = group.id
                          void openFolderPicker()
                        }}
                      >
                        {t("addProject")}
                      </button>
                    </div>
                  )
                ) : (
                  section.running.map((session) =>
                    renderSession(
                      session,
                      runningIndent,
                      projectLabel(session.folderId)
                    )
                  )
                )}
              </section>
            )
          })}
          {unassigned.length > 0 ? (
            <section aria-label={tGroups("unassigned")}>
              <div className="mt-1 flex h-7 items-center px-1.5 text-xs font-medium text-muted-foreground">
                {tGroups("unassigned")}
              </div>
              {unassigned.map((session) =>
                renderSession(
                  session,
                  runningIndent,
                  session.device === 0
                    ? null
                    : rowDevices.get(session.device)?.name
                )
              )}
            </section>
          ) : null}
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
      {devices.map((device) =>
        device.node ? (
          <DeviceFeed
            key={device.id}
            deviceId={device.id}
            live={statusOf(device).state === "online"}
            onUpdate={handleFeed}
          />
        ) : null
      )}
      {summaryOnly ? (
        <button
          type="button"
          onClick={() => useProjectPanelStore.getState().setMaximized(false)}
          title={tGroups("restoreList")}
          className="absolute inset-0 z-10 flex items-start gap-1.5 truncate bg-sidebar px-3 pt-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {(() => {
            const section = sections.find((item) => item.current)
            return [
              section
                ? `${section.group.emoji ?? ""} ${section.group.name}`.trim()
                : null,
              tGroups("workingCount", {
                count: sections.reduce((n, item) => n + item.working, 0),
              }),
              tGroups("attentionCount", { count: attention.length }),
            ]
              .filter(Boolean)
              .join(" · ")
          })()}
        </button>
      ) : null}
      <SidebarHeaderTitle>
        <WorkspaceSwitcher
          items={sections.map((section) => ({
            group: section.group,
            current: section.current,
            summary: sectionSummary(section),
          }))}
          onSwitch={switchWorkspace}
          onCreate={() => setEditingGroup({ group: null })}
        />
      </SidebarHeaderTitle>
      <SidebarHeaderActions>
        {attention.length > 0 ? (
          <button
            type="button"
            onClick={jumpToAttention}
            title={tGroups("nextAttention")}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.6875rem] font-medium text-amber-600 hover:bg-accent dark:text-amber-400"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
            {tGroups("attentionCount", { count: attention.length })}
          </button>
        ) : null}
        {activeFolder && activeIsRepo ? (
          <SidebarHeaderButton
            icon={FolderGit2}
            label={t("newWorktreeForActive")}
            onClick={() => handleNewWorktree(activeFolder.id)}
          />
        ) : null}
        <SidebarHeaderButton
          icon={Search}
          label={t("searchProjectsPlaceholder")}
          onClick={searching ? closeSearch : openSearch}
        />
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

      {searching && !summaryOnly ? (
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
                if (event.key === "Escape") {
                  event.stopPropagation()
                  closeSearch()
                  return
                }
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return
                // 回车切项目：有搜索词取第一条匹配，空搜索回到上一个项目
                const { recentFolderIds } = useAppWorkspaceStore.getState()
                const target = q
                  ? searchHits[0]?.slot.folderId
                  : recentFolderIds.find(
                      (id) => id !== activeFolder?.id && folderById.has(id)
                    )
                if (target == null) {
                  if (!sessionHits[0]) return
                  selectSession(sessionHits[0])
                } else handleSelectFolder(target)
                event.preventDefault()
                closeSearch()
              }}
              placeholder={t("searchProjectsPlaceholder")}
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
      ) : null}

      {body}

      <AddDeviceDialog
        // 每次打开重新挂载，表单从空白开始。
        key={addDeviceOpen ? "add-device-open" : "add-device-closed"}
        open={addDeviceOpen}
        onOpenChange={setAddDeviceOpen}
        onAdded={notifyDevicesChanged}
      />
      <SessionSwitcher
        open={switcherRecent != null}
        onOpenChange={(open) => {
          if (!open) setSwitcherRecent(null)
        }}
        entries={switcherEntries}
        onSelect={selectSession}
      />

      {editingGroup ? (
        <WorkspaceGroupDialog
          state={groups}
          editing={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSave={saveGroup}
        />
      ) : null}

      <AlertDialog
        open={deletingGroup !== null}
        onOpenChange={(open) => !open && setDeletingGroup(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tGroups("deleteTitle", { name: deletingGroup?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tGroups("deleteDescription", {
                name:
                  groups.groups.find(
                    (group) => group.id === defaultGroupId(groups)
                  )?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = deletingGroup?.id
                setDeletingGroup(null)
                if (id)
                  void changeGroups((state) => removeWorkspaceGroup(state, id))
              }}
            >
              {tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <NewWorktreeDialog
        source={worktreeSource}
        onClose={() => setWorktreeSource(null)}
        onCreated={(detail) => activateFolderWorkspace(detail.id)}
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
