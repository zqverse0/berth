"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import {
  FolderOpenDot,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Server,
  X,
} from "lucide-react"
import { createAndOpenFolderTerminal } from "@/lib/terminal/create-and-open-primary-terminal"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useOpenFolderPicker } from "@/hooks/workspace/use-open-folder-picker"
import {
  NEXT_ATTENTION_EVENT,
  OPEN_PROJECT_SWITCHER_EVENT,
  OPEN_SESSION_SWITCHER_EVENT,
} from "@/components/layout/commands/commands"
import { tabFromDescriptor } from "@/lib/terminal/create-and-open-primary-terminal"
import { useTerminalInventorySnapshot } from "@/lib/terminal/terminal-inventory-query"
import { useAgentPaneStore, useAllAgentPanes } from "@/lib/terminal/agent-panes"
import { parseDeviceRef } from "@/lib/transport/device"
import { useDeviceSnapshotStore, useDeviceTransfers } from "@/lib/devices"
import { updateFolderAlias } from "@/lib/api"
import { revealItemInDir } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { agentTypeForTool } from "@/hooks/use-agent-profiles"
import {
  SidebarHeaderActions,
  SidebarHeaderButton,
} from "@/components/layout/sidebar/sidebar-header"
import { useProjectPanelStore } from "@/components/layout/sidebar/views"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { sessionIndent } from "./project-row-face"
import { ProjectRow } from "./project-row"
import { useRemoveProject } from "./remove-project-dialog"
import { useRenameWorktree } from "./rename-worktree-dialog"
import { projectMemberOp } from "./untracked-checkouts"
import { AgentIcons } from "./agent-icons"
import {
  ProjectMembers,
  type MemberFolder,
  type MemberHandlers,
} from "./project-members"
import {
  DeviceFeed,
  DeviceTransfers,
  shownDeviceFolders,
  useOsFileDropToDevices,
  type DeviceFeedState,
} from "./device-projects"
import {
  STATUS_DOT,
  openDevicesPanel,
  useDeviceErrorText,
  useDevices,
  useDevicesPanelView,
} from "@/components/devices/devices"
import { SessionRow } from "./session-row"
import {
  buildSidebarSessions,
  switcherOrder,
  type SidebarSession,
} from "./sidebar-sessions"
import { SessionSwitcher } from "./session-switcher"
import { sidebarRows, type RowFolder } from "./sidebar-rows"
import {
  isMainMember,
  mainFolderId,
  projectName,
} from "@/lib/workspace/projects"

const RECONCILE_AFTER_SLIDE_MS = 300

export interface SidebarProjectListProps {
  /**
   * When false the list stays mounted (preserving local state); the root is
   * hidden + inert and the terminal inventory projection is paused.
   */
  visible?: boolean
  /** 下方面板最大化：列表保持挂载（滚动位置不丢），上面盖一行当前项目摘要，点击还原。 */
  summaryOnly?: boolean
}

/** 列表里一个项目（本机或对方）：显示用的字段与所在设备。 */
interface ListFolder extends RowFolder {
  git_branch: string | null
  device: number
}

/**
 * 侧栏项目视图：项目 → worktree → 会话；本机与设备项目在同一张列表里；
 * 不属于任何项目的会话在「未归属会话」。
 */
const COLLAPSED_DEVICES_KEY = "berth.sidebar.collapsedDevices"

export function SidebarProjectList({
  visible = true,
  summaryOnly = false,
}: SidebarProjectListProps) {
  const t = useTranslations("Folder.sidebar")
  const tDevices = useTranslations("Folder.sidebar.devices")
  const tFolderDropdown = useTranslations("Folder.folderNameDropdown")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const tTerminal = useTranslations("Folder.terminal")
  const tSessions = useTranslations("SidebarSessions")
  const tMembers = useTranslations("ProjectMembers")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const memberFlags = useAppWorkspaceStore((s) => s.memberFlags)
  const refreshFolder = useAppWorkspaceStore((s) => s.refreshFolder)
  const { activeFolder } = useActiveFolder()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const allPrimaryTabs = useTabStore((s) => s.tabs)
  // The shared inventory store refreshes at explicit boundaries only (no poll);
  // it is the only source for terminals the GUI did not open itself.
  const terminalInventory = useTerminalInventorySnapshot(visible)
  const panes = useAllAgentPanes(visible)
  const seen = useAgentPaneStore((s) => s.seen)
  const { activateFolderWorkspace, openTerminalTab, switchTab } =
    useTabActions()
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

  // 项目视图每次变为可见，现读全部项目的成员一次：worktree 以 git 为准，
  // 非活动项目没有 HEAD 轮询，靠这里补齐。不依赖列表内容，避免结果回灌再触发。
  const hasProjects = folders.length > 0
  // 每个 root 起一个 git 进程；等侧栏滑入动画（240ms）结束再发，不跟动画抢主线程。
  // 动画期间又关上则取消。
  useEffect(() => {
    if (!visible || !hasProjects) return
    const timer = window.setTimeout(() => {
      const { folders: openFolders, refreshProjectMembers } =
        useAppWorkspaceStore.getState()
      const mainIds = openFolders.filter(isMainMember).map((f) => f.id)
      void refreshProjectMembers(...mainIds)
    }, RECONCILE_AFTER_SLIDE_MS)
    return () => window.clearTimeout(timer)
  }, [hasProjects, visible])

  // ── Devices ────────────────────────────────────────────────────────────────
  const { devices, statusOf } = useDevices()
  const errorText = useDeviceErrorText()
  useOsFileDropToDevices()
  // 拖到设备的文件：进度显示在所在设备的分组下
  const { transfers, dismiss: dismissTransfer } = useDeviceTransfers(
    null,
    (dest) =>
      toast.success(
        tDevices("remote.transferDone", { name: dest.split("/").pop() ?? dest })
      )
  )
  const [feeds, setFeeds] = useState<Record<number, DeviceFeedState>>({})
  const handleFeed = useCallback(
    (deviceId: number, feed: DeviceFeedState) =>
      setFeeds((prev) =>
        prev[deviceId]?.overview === feed.overview &&
        prev[deviceId]?.problem === feed.problem
          ? prev
          : { ...prev, [deviceId]: feed }
      ),
    []
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
  // 设备面板（`devices` 插件）：概览、检查清单（离线时写明哪一步不通）、挑选显示的项目；没装插件不给入口
  const devicesPanel = useDevicesPanelView()

  // ── Projects of every device, one list ─────────────────────────────────────
  // 对方项目用概览（离线时为缓存）：id 换成本机身份（负数），路径保留对方的原样（工作区归属按它记）。
  const listFolders = useMemo(() => {
    const local: ListFolder[] = folders.map((folder) => ({
      ...folder,
      device: 0,
    }))
    const remote = devices.flatMap((device) =>
      shownDeviceFolders(
        device.id,
        feeds[device.id]?.overview,
        device.shown
      ).map((project): ListFolder => ({ ...project, device: device.id }))
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
      // 不属于项目的终端：对方 GUI 的终端属于没勾选显示的项目，不列出；从设备开的 SSH 终端按起始目录认
      detachedDevice: (descriptor) =>
        parseDeviceRef(descriptor.terminalId)
          ? null
          : (deviceByDir.get(descriptor.initialCwd) ?? 0),
    })
  }, [allPrimaryTabs, devices, listFolders, panes, seen, terminalInventory])

  const { rows, unassigned } = useMemo(
    () =>
      sidebarRows(
        [
          { device: 0, folders: listFolders.filter((f) => f.device === 0) },
          ...devices.map((device) => ({
            device: device.id,
            folders: listFolders.filter((f) => f.device === device.id),
          })),
        ],
        sessions
      ),
    [devices, listFolders, sessions]
  )

  // 项目列表按设备分组：本机在前，与其他设备一样可折叠、可打开设备面板
  const local = useDeviceSnapshotStore((state) => state.local)
  const deviceGroups = useMemo(
    () => [
      {
        id: 0,
        name: local?.host || tDevices("local"),
        state: "online" as const,
        title: local?.host || tDevices("local"),
      },
      ...devices.map((device) => {
        const { state, message, keyMissing } = statusOf(device)
        const problem = feeds[device.id]?.problem
        return {
          id: device.id,
          name: device.name,
          state,
          title: [
            `${device.name} · ${tDevices(keyMissing ? "status.needsKey" : `status.${state}`)}`,
            state === "offline" ? errorText(message) : null,
            problem ? tDevices(problem) : null,
          ]
            .filter(Boolean)
            .join("\n"),
        }
      }),
    ],
    [devices, errorText, feeds, local, statusOf, tDevices]
  )

  // ── Row actions ────────────────────────────────────────────────────────────
  const handleSelectFolder = useCallback(
    (folderId: number) => {
      const folder = folderById.get(folderId)
      if (!folder) return
      activateFolderWorkspace(folderId)
    },
    [activateFolderWorkspace, folderById]
  )
  // 点项目行：回到这个项目上次停留的成员，没有就是主成员。
  const handleSelectProject = useCallback(
    (folderId: number) => {
      const folder = folderById.get(folderId)
      if (!folder) return
      const main = mainFolderId(folder)
      const { recentFolderIds } = useAppWorkspaceStore.getState()
      const last = recentFolderIds.find((id) => {
        const recent = folderById.get(id)
        return recent != null && mainFolderId(recent) === main
      })
      handleSelectFolder(last ?? folderId)
    },
    [folderById, handleSelectFolder]
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
      // 点的是 Agent / 终端：展开辅助面板显示终端
      useAppUiStore.getState().setAuxPanelOpen(true)
    },
    [openTerminalTab, switchTab]
  )

  // 各项目与未归属的会话，按列表顺序
  const listedSessions = useMemo(
    () => [...rows.flatMap((row) => row.sessions), ...unassigned],
    [rows, unassigned]
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
      if (attention.length === 0) toast.info(tSessions("noAttention"))
      else jumpToAttention()
    }
    window.addEventListener(OPEN_SESSION_SWITCHER_EVENT, openSwitcher)
    window.addEventListener(NEXT_ATTENTION_EVENT, nextAttention)
    return () => {
      window.removeEventListener(OPEN_SESSION_SWITCHER_EVENT, openSwitcher)
      window.removeEventListener(NEXT_ATTENTION_EVENT, nextAttention)
    }
  }, [attention.length, jumpToAttention, tSessions])

  // 项目名记在项目记录上（接口沿用旧名 alias），与目录名无关。
  const handleRenameProject = useCallback(
    async (folderId: number, name: string) => {
      try {
        await updateFolderAlias(folderId, name)
        await refreshFolder(folderId)
      } catch (err) {
        toast.error(
          t("toasts.renameProjectFailed", { message: toErrorMessage(err) })
        )
      }
    },
    [refreshFolder, t]
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

  // 手动展开 / 收起过的项目（键 `设备:主成员`）；没动过的按「当前成员在不在里面」。
  const [openOverride, setOpenOverride] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map())

  // 折叠的设备分组，跨重启记住。
  const [collapsedDevices, setCollapsedDevices] = useState<ReadonlySet<number>>(
    () => {
      try {
        return new Set(
          JSON.parse(localStorage.getItem(COLLAPSED_DEVICES_KEY) ?? "[]")
        )
      } catch {
        return new Set()
      }
    }
  )
  const toggleDevice = useCallback((deviceId: number) => {
    setCollapsedDevices((prev) => {
      const next = new Set(prev)
      if (!next.delete(deviceId)) next.add(deviceId)
      localStorage.setItem(COLLAPSED_DEVICES_KEY, JSON.stringify([...next]))
      return next
    })
  }, [])

  const { requestRemove, removeDialog } = useRemoveProject()
  const handleRemoveFromWorkspace = useCallback(
    (folderId: number) => requestRemove(folderId, "remove"),
    [requestRemove]
  )
  const { requestRename, renameDialog } = useRenameWorktree()

  // 成员归属的改动（设主成员、改挂）：完成后重读涉及的项目（`also` 是目标项目里的成员）。
  const memberOp = useCallback(
    async (
      folderId: number,
      action: "main" | "move",
      params?: Record<string, unknown>,
      also?: number
    ) => {
      try {
        await projectMemberOp(folderId, action, params)
      } catch (err) {
        toast.error(
          tMembers("memberOpFailed", { message: toErrorMessage(err) })
        )
      }
      await useAppWorkspaceStore
        .getState()
        .refreshProjectMembers(folderId, ...(also == null ? [] : [also]))
    },
    [tMembers]
  )

  // 成员行的操作：开终端，看改动，设主成员 / 改挂 / 移出，改名 / 删除 / 清理。
  const memberHandlers = useMemo<MemberHandlers>(
    () => ({
      onSelect: handleSelectFolder,
      onReveal: handleOpenInSystemExplorer,
      onOpenSession: selectSession,
      onOpenTerminal: (folder: MemberFolder) =>
        void createAndOpenFolderTerminal(
          { cwd: folder.path, folderId: folder.id },
          tTerminal
        ),
      onViewChanges: (folderId: number) => {
        handleSelectFolder(folderId)
        useProjectPanelStore.getState().showPanel("changes")
      },
      onRename: requestRename,
      onDelete: (folderId: number) => requestRemove(folderId, "delete"),
      onPrune: (folderId: number) => requestRemove(folderId, "prune"),
      onDetach: (folderId: number) => requestRemove(folderId, "detach"),
      onSetMain: (folderId: number) => void memberOp(folderId, "main"),
      onMove: (folderId: number, projectId: number) => {
        const target = useAppWorkspaceStore
          .getState()
          .allFolders.find((f) => f.project_id === projectId)
        void memberOp(folderId, "move", { project: projectId }, target?.id)
      },
      onJoined: (mainId: number) =>
        void useAppWorkspaceStore.getState().refreshProjectMembers(mainId),
    }),
    [
      handleOpenInSystemExplorer,
      handleSelectFolder,
      memberOp,
      requestRemove,
      requestRename,
      selectSession,
      tTerminal,
    ]
  )

  // ── Search ─────────────────────────────────────────────────────────────────
  const q = query.trim().toLocaleLowerCase()
  const matches = useCallback(
    (folder: ListFolder) =>
      [projectName(folder), folder.name, folder.path, folder.git_branch]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(q)),
    [q]
  )
  const searchHits = useMemo(
    () =>
      q
        ? rows.filter((row) =>
            row.members.some((member) =>
              matches(listFolderById.get(member.folderId)!)
            )
          )
        : [],
    [listFolderById, matches, q, rows]
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
      handleSelectProject(folderId)
      closeSearch()
    },
    [closeSearch, handleSelectProject]
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

  /** 会话所在「项目 ⎇ 成员」（主成员只写项目名）：搜索结果、折叠项目的会话行与会话切换器用。 */
  const projectLabel = (folderId: number | null) => {
    const folder = folderId == null ? null : listFolderById.get(folderId)
    if (!folder) return null
    const name = projectName(folder)
    return isMainMember(folder) ? name : `${name} ⎇ ${folder.name}`
  }
  const switcherEntries = switcherRecent
    ? switcherOrder(listedSessions, switcherRecent, activeTabId).map(
        (session) => ({
          session,
          project:
            projectLabel(session.folderId) ??
            (session.device === 0
              ? tSessions("unassigned")
              : (rowDevices.get(session.device)?.name ?? "")),
        })
      )
    : []

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

  // 「移到项目」的候选：本机的项目（设备项目的成员不能改挂到本机）。
  const moveTargets = rows.flatMap((row) => {
    const head = row.device === 0 ? folderById.get(row.mainId) : undefined
    return head?.project_id != null
      ? [{ projectId: head.project_id, name: projectName(head) }]
      : []
  })

  /**
   * 一个项目：项目行 + 展开的成员行；收起时行尾汇总各成员的 Agent 图标。
   * 项目没有目录、不能选中：点项目行只展开 / 收起（默认展开当前成员所在的项目）；
   * 搜索结果里点它则跳到它上次停留的成员。
   */
  const renderRow = (
    row: (typeof rows)[number],
    onPick?: (folderId: number) => void
  ) => {
    const head =
      listFolderById.get(row.mainId) ??
      listFolderById.get(row.members[0].folderId)!
    const current = row.members.some(
      (member) => member.folderId === activeFolder?.id
    )
    const key = `${row.device}:${row.mainId}`
    const expanded = openOverride.get(key) ?? current
    return (
      <div
        key={key}
        // 当前成员所在的项目：整组淡底，一眼看出成员属于哪个项目
        className={cn(current && expanded && "rounded-xl bg-sidebar-accent/40")}
      >
        <ProjectRow
          folderId={head.id}
          folderName={projectName(head)}
          pinned={head.project?.pinned_at != null}
          selected={current && !expanded}
          device={rowDevices.get(row.device) ?? null}
          idle={row.sessions.length === 0}
          current={current}
          expanded={expanded}
          trailing={
            expanded ? null : (
              <AgentIcons sessions={row.sessions} onOpen={selectSession} />
            )
          }
          onToggle={
            onPick
              ? () => onPick(head.id)
              : () =>
                  setOpenOverride((prev) => new Map(prev).set(key, !expanded))
          }
          onRemoveFromWorkspace={handleRemoveFromWorkspace}
          onRename={handleRenameProject}
          onSetPinned={handleSetFolderPinned}
        />
        {expanded ? (
          <ProjectMembers
            row={row}
            device={rowDevices.get(row.device) ?? null}
            moveTargets={moveTargets.filter(
              (target) =>
                target.projectId !== folderById.get(head.id)?.project_id
            )}
            folderOf={(id) => listFolderById.get(id)}
            activeFolderId={activeFolder?.id ?? null}
            flags={memberFlags}
            visible={visible}
            handlers={memberHandlers}
          />
        ) : null}
      </div>
    )
  }

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
          {searchHits.map((row) => renderRow(row, pickSearchedFolder))}
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
      <ScrollArea className="min-h-0 flex-1 px-1.5 pb-1.5">
        <div className="flex flex-col">
          {deviceGroups.map((group) => {
            const collapsed = collapsedDevices.has(group.id)
            const Chevron = collapsed ? ChevronRight : ChevronDown
            const sessionsHere = unassigned.filter(
              (session) => session.device === group.id
            )
            return (
              <section key={group.id} aria-label={group.name}>
                <div className="group mt-1 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/50">
                  <button
                    type="button"
                    onClick={() => toggleDevice(group.id)}
                    aria-expanded={!collapsed}
                    title={group.title}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <Chevron aria-hidden className="size-3.5 shrink-0" />
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        STATUS_DOT[group.state]
                      )}
                    />
                    <span className="truncate">{group.name}</span>
                  </button>
                  {devicesPanel ? (
                    <button
                      type="button"
                      onClick={() => openDevicesPanel(group.id)}
                      title={tDevices("openPage")}
                      aria-label={tDevices("openPage")}
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded hover:text-sidebar-foreground",
                        group.state !== "offline" &&
                          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      )}
                    >
                      <Server className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <DeviceTransfers
                  transfers={transfers.filter(
                    (item) => item.deviceId === group.id
                  )}
                  dismiss={dismissTransfer}
                />
                {collapsed ? null : (
                  <>
                    {rows
                      .filter((row) => row.device === group.id)
                      .map((row) => renderRow(row))}
                    {/* 本机的未归属终端单列一小节；对方的直接列在设备下 */}
                    {group.id === 0 && sessionsHere.length > 0 ? (
                      <div className="mt-1 flex h-7 items-center px-1.5 text-xs font-medium text-muted-foreground">
                        {tSessions("unassigned")}
                      </div>
                    ) : null}
                    {sessionsHere.map((session) =>
                      renderSession(session, runningIndent)
                    )}
                  </>
                )}
              </section>
            )
          })}
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
            shown={device.shown}
            onUpdate={handleFeed}
          />
        ) : null
      )}
      {summaryOnly ? (
        <button
          type="button"
          onClick={() => useProjectPanelStore.getState().setMaximized(false)}
          title={tSessions("restoreList")}
          className="absolute inset-0 z-10 flex items-start gap-1.5 truncate bg-sidebar px-3 pt-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {[
            activeFolder ? projectLabel(activeFolder.id) : null,
            tSessions("workingCount", {
              count: listedSessions.filter((item) => item.dot === "working")
                .length,
            }),
            tSessions("attentionCount", { count: attention.length }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </button>
      ) : null}
      <SidebarHeaderActions>
        {attention.length > 0 ? (
          <button
            type="button"
            onClick={jumpToAttention}
            title={tSessions("nextAttention")}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.6875rem] font-medium text-amber-600 hover:bg-accent dark:text-amber-400"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
            {tSessions("attentionCount", { count: attention.length })}
          </button>
        ) : null}
        <SidebarHeaderButton
          icon={Search}
          label={t("searchProjectsPlaceholder")}
          onClick={searching ? closeSearch : openSearch}
        />
        <SidebarHeaderButton
          icon={Plus}
          label={t("addProject")}
          onClick={() => void openFolderPicker()}
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
                const here = activeFolder ? mainFolderId(activeFolder) : null
                const target = q
                  ? searchHits[0]?.members[0].folderId
                  : recentFolderIds.find((id) => {
                      const recent = folderById.get(id)
                      return recent != null && mainFolderId(recent) !== here
                    })
                if (target == null) {
                  if (!sessionHits[0]) return
                  selectSession(sessionHits[0])
                } else handleSelectProject(target)
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

      <SessionSwitcher
        open={switcherRecent != null}
        onOpenChange={(open) => {
          if (!open) setSwitcherRecent(null)
        }}
        entries={switcherEntries}
        onSelect={selectSession}
      />

      {removeDialog}
      {renameDialog}
    </div>
  )
}
