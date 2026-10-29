"use client"

import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { FolderTitleBar } from "@/components/layout/chrome/folder-title-bar"
import { Sidebar } from "@/components/layout/sidebar/sidebar"
import { StatusBar } from "@/components/layout/status-bar/status-bar"
import { AppWorkspaceProvider } from "@/contexts/app-workspace-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { AppUiRuntime } from "@/components/runtime/app-ui-runtime"
import { useAppUiStore } from "@/stores/app-ui-store"
import { TabProvider } from "@/contexts/tab-context"
import { PointerProvider } from "@/pointer"
import { GitCredentialProvider } from "@/contexts/git-credential-context"
import { WorkspaceRuntimeHost } from "@/components/runtime/workspace-runtime-host"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { UpdateProvider } from "@/components/providers/update-provider"
import { useWorkspaceBackground, useZoomLevel } from "@/hooks/use-appearance"
import { FILL_MODE_STYLE } from "@/lib/workspace/workspace-background"
import { AuxPanel } from "@/components/layout/aux-panel/aux-panel"
import { WorkspacePaneContent } from "@/components/workspace/workspace-pane-content"
import { WorkspacePaneDropArea } from "@/components/workspace/workspace-pane-drop-area"
import { WorkspaceTabStrip } from "@/components/tabs/workspace-tab-strip"
import {
  ActivityBar,
  useSettingsViewSync,
} from "@/components/layout/sidebar/activity-bar"
import { RightEdgeChrome } from "@/components/layout/chrome/right-edge-chrome"
import { WorkspaceCommandController } from "@/components/layout/commands/command-controller"
import { WindowControls } from "@/components/layout/chrome/window-controls"
import { FileWorkspaceTabBar } from "@/components/files/file-workspace-tab-bar"
import { ExternalConflictDialog } from "@/components/files/external-conflict-dialog"
import { DeepLinkBootstrap } from "@/components/workspace/deep-link-bootstrap"
import { WorkspaceOpenFolderListener } from "@/components/workspace/workspace-open-folder-listener"
import { WorkspaceOpenFileListener } from "@/components/workspace/workspace-open-file-listener"
import { WorkspaceCurrentSelection } from "@/components/workspace/workspace-current-selection"
import { HeavyPluginsWarmup } from "@/components/ai-elements/heavy-plugins-warmup"
import {
  SplitHandle,
  SplitPane,
  SplitView,
  type SplitViewHandle,
} from "@/components/ui/split-view"
import { PerfProfiler } from "@/lib/perf/profiler"
import {
  createSplitLayoutTransaction,
  type SplitLayoutTransaction,
} from "@/lib/workspace/split-layout-transaction"
import {
  SplitLayoutTransactionProvider,
  useSplitLayoutTransaction,
} from "@/lib/workspace/split-layout-transaction-context"
import {
  WINDOW_CAPTION_WIDTH,
  hasNativeWindowChrome,
  leftChromeReserve,
  rightChromeReserve,
} from "@/lib/window-chrome"
import { useIsMobile } from "@/hooks/use-mobile"
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets"
import { usePlatform } from "@/hooks/use-platform"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { SETTINGS_GLOBAL_TAB_ID } from "@/lib/workspace/settings-tab"

const LazySettingsWorkspaceView = lazy(() =>
  import("@/components/settings/settings-workspace-view").then((m) => ({
    default: m.SettingsWorkspaceView,
  }))
)

function WorkspaceDocumentTitle() {
  const { activeFolder } = useActiveFolder()

  useEffect(() => {
    document.title = activeFolder ? `${activeFolder.name} - berth` : "berth"
  }, [activeFolder])

  return null
}

const FOLDER_SHELL_GROUP_ID = "folder-shell-group"
const FOLDER_SHELL_LEFT_PANEL_ID = "folder-shell-left-panel"
const FOLDER_SHELL_MAIN_PANEL_ID = "folder-shell-main-panel"
const FOLDER_SHELL_RIGHT_PANEL_ID = "folder-shell-right-panel"
const MIN_CENTER_WIDTH_PX = 420
const MAIN_SPLIT_GROUP_ID = "workspace-main-split"
const MAIN_SPLIT_LEFT_PANEL_ID = "workspace-main-left"
const MAIN_SPLIT_RIGHT_PANEL_ID = "workspace-main-right"
const MIN_GROUP_WIDTH_PX = 200
// Keep the transition class a touch past the CSS grid animation so the
// final committed track is painted before the class is removed.
const PANEL_SLIDE_MS = 240
const PANEL_SLIDE_CLEANUP_MS = PANEL_SLIDE_MS + 60

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Returns `true` for a brief window after `open` flips, so the caller can add
 * the `.panel-slide-animating` class that animates the panel resize (a "push"
 * slide) on explicit show/hide toggles only — never on the initial mount, on
 * localStorage hydration, or during resize-handle drags. The first settled
 * `open` value (once `ready`) establishes a baseline without animating.
 *
 * The toggle is detected during render (React's sanctioned "adjust state when a
 * prop changes" pattern) rather than in an effect: turning the class on in the
 * render that observes the flip lands it in the same commit as the grid
 * template update. Turn-off is deferred to a timer keyed on a per-toggle
 * sequence, so a
 * fresh toggle mid-slide re-arms the timer instead of inheriting the old one.
 */
function usePanelSlideOnToggle(
  open: boolean,
  ready: boolean,
  transaction: SplitLayoutTransaction
): boolean {
  const [animating, setAnimating] = useState(false)
  const [slideSeq, setSlideSeq] = useState(0)
  const [prevOpen, setPrevOpen] = useState<boolean | null>(null)

  if (ready) {
    if (prevOpen === null) {
      // Adopt the hydrated value as the baseline without animating.
      setPrevOpen(open)
    } else if (prevOpen !== open) {
      setPrevOpen(open)
      setAnimating(true)
      setSlideSeq((seq) => seq + 1)
    }
  }

  // Hold terminal PTY resizes for the whole slide (same channel as a divider
  // drag) so they see one final geometry instead of every animation frame.
  useLayoutEffect(() => {
    if (slideSeq === 0) return
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      transaction.commit({ geometry: [], reason: "external-resize" })
    }
    transaction.beginPreview()
    const timer = setTimeout(() => {
      settle()
      setAnimating(false)
    }, PANEL_SLIDE_CLEANUP_MS)
    return () => {
      clearTimeout(timer)
      settle()
    }
  }, [slideSeq, transaction])

  return animating
}

/**
 * tab 条贴窗口边时，给固定的窗口角按钮留白；该侧面板展开时不留。
 * 自己订阅面板开关，折叠侧栏 / 辅助面板只重渲染这一小块，不连带整个编辑区。
 */
function EdgeReserve({ side }: { side: "left" | "right" }) {
  const panelOpen = useAppUiStore((state) =>
    side === "left" ? state.sidebarOpen : state.auxPanelOpen
  )
  const { isMac, isWindows, isLinux } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  if (panelOpen) return null
  const width =
    side === "left"
      ? leftChromeReserve(isMac && hasNativeWindowChrome(), zoomLevel)
      : rightChromeReserve(
          hasNativeWindowChrome() && (isWindows || isLinux),
          zoomLevel
        )
  return (
    <div
      data-tauri-drag-region
      className="h-full shrink-0 ws-strip-line"
      style={{ width }}
    />
  )
}

/** One main-area tab group: its tab strip over its content. */
function MainGroupColumn({
  strip,
  reserveLeft,
  reserveRight,
  children,
}: {
  strip: React.ReactNode
  /** 该列贴着窗口左 / 右边缘。 */
  reserveLeft: boolean
  reserveRight: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Tab strip + edge reserves for the fixed window-corner overlays */}
      <div className="flex h-10 shrink-0 items-stretch border-b border-border/50 bg-muted ws-transparent-bg">
        {reserveLeft && <EdgeReserve side="left" />}
        <div className="flex min-w-0 flex-1 items-stretch">{strip}</div>
        {reserveRight && <EdgeReserve side="right" />}
      </div>
      {children}
    </div>
  )
}

// 中间左栏的内容：激活 tab 的内容；设置激活时盖在上面（设置是模式，不占 tab 条）。桌面与手机共用。
function FilesPaneContent() {
  const { isOpen: settingsOpen, selectSettings } = useSettingsWorkspace()
  const settingsInFiles = useWorkspaceLayoutProjection(
    ({ activeTabByPane, globalTabs }) =>
      globalTabs.some((tab) => tab.id === SETTINGS_GLOBAL_TAB_ID) &&
      activeTabByPane.files?.kind === "global" &&
      activeTabByPane.files.id === SETTINGS_GLOBAL_TAB_ID
  )
  const isSettingsActive = settingsOpen && settingsInFiles
  return (
    <>
      <WorkspacePaneContent pane="files" hidden={isSettingsActive} />
      {isSettingsActive && (
        <div
          data-workspace-primary-pane="files"
          data-workspace-global-tab-id={SETTINGS_GLOBAL_TAB_ID}
          className="pointer-events-auto absolute inset-0 overflow-hidden"
          onPointerDownCapture={selectSettings}
          onFocusCapture={selectSettings}
        >
          <Suspense
            fallback={
              <div
                className="h-full w-full animate-pulse bg-card/40"
                aria-hidden="true"
              />
            }
          >
            <LazySettingsWorkspaceView />
          </Suspense>
        </div>
      )}
    </>
  )
}

const WorkspaceContent = memo(function WorkspaceContent() {
  const splitActive = useWorkspaceLayoutProjection(
    ({ splitActive }) => splitActive
  )
  // 与外层 shell 共用一个事务：拖侧栏时 PDF / 终端等也要等松手再适配，
  // 否则 PDF 每帧重算缩放、重绘页面。
  const shellTransaction = useSplitLayoutTransaction()
  const splitTransaction = useMemo(
    () => shellTransaction ?? createSplitLayoutTransaction(),
    [shellTransaction]
  )

  // The right group pane stays in the tree (collapsed when unsplit) so the
  // left group's editors and terminals keep their identity across splits.
  return (
    <div
      data-workspace-root
      className="relative h-full min-h-0 overflow-hidden bg-card ws-transparent-bg"
    >
      <SplitLayoutTransactionProvider transaction={splitTransaction}>
        <SplitView
          id={MAIN_SPLIT_GROUP_ID}
          direction="horizontal"
          transaction={splitTransaction}
          className="h-full"
        >
          <SplitPane
            id={MAIN_SPLIT_LEFT_PANEL_ID}
            order={1}
            defaultSize={50}
            minSizePx={MIN_GROUP_WIDTH_PX}
          >
            <MainGroupColumn
              strip={
                <PerfProfiler id="file-tabs">
                  <FileWorkspaceTabBar />
                </PerfProfiler>
              }
              reserveLeft
              reserveRight={!splitActive}
            >
              <WorkspacePaneDropArea
                pane="files"
                splitZone={!splitActive}
                className="min-h-0 flex-1 overflow-hidden"
              >
                <FilesPaneContent />
              </WorkspacePaneDropArea>
            </MainGroupColumn>
          </SplitPane>

          <SplitHandle
            disabled={!splitActive}
            className={
              splitActive ? "" : "pointer-events-none w-0 opacity-0 -mx-0"
            }
          />

          <SplitPane
            id={MAIN_SPLIT_RIGHT_PANEL_ID}
            order={2}
            defaultSize={50}
            collapsed={!splitActive}
            minSizePx={splitActive ? MIN_GROUP_WIDTH_PX : 0}
            maxSizePx={splitActive ? undefined : 0}
          >
            {splitActive && (
              <MainGroupColumn
                strip={
                  <WorkspaceTabStrip pane="files-split" className="w-full" />
                }
                reserveLeft={false}
                reserveRight
              >
                <WorkspacePaneDropArea
                  pane="files-split"
                  className="min-h-0 flex-1 overflow-hidden"
                >
                  <WorkspacePaneContent pane="files-split" />
                </WorkspacePaneDropArea>
              </MainGroupColumn>
            )}
          </SplitPane>
        </SplitView>
      </SplitLayoutTransactionProvider>
    </div>
  )
})

// 手机：主区与桌面中间左栏同一个内容宿主与 tab 条（没有 tab 时是项目首页，设置盖在上面）；群组、终端等
// 辅助面板 tab 只在全屏的辅助面板里，不能在主区再渲染一份（同一终端挂两次，主区那份空白却仍收输入）。
function MobileWorkspaceContent() {
  return (
    <MainGroupColumn
      strip={<FileWorkspaceTabBar />}
      reserveLeft={false}
      reserveRight={false}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <FilesPaneContent />
      </div>
    </MainGroupColumn>
  )
}

function MobileFolderWorkspaceShell() {
  useSettingsViewSync()
  const sidebarOpen = useAppUiStore((state) => state.sidebarOpen)
  const sidebarRestored = useAppUiStore((state) => state.sidebarRestored)
  const toggleSidebar = useAppUiStore((state) => state.toggleSidebar)
  const auxOpen = useAppUiStore((state) => state.auxPanelOpen)
  const auxRestored = useAppUiStore((state) => state.auxPanelRestored)
  const toggleAux = useAppUiStore((state) => state.toggleAuxPanel)
  // 手机上侧栏与辅助面板互斥：后打开的关掉另一个。否则从侧栏打开 Agent 时侧栏还压在面板底下，
  // 面板从标题栏下沿画起，顶上露出侧栏头和它的黑色遮罩。
  useEffect(
    () =>
      useAppUiStore.subscribe((state, prev) => {
        if (state.auxPanelOpen && !prev.auxPanelOpen && state.sidebarOpen)
          useAppUiStore.setState({ sidebarOpen: false })
        else if (state.sidebarOpen && !prev.sidebarOpen && state.auxPanelOpen)
          useAppUiStore.setState({ auxPanelOpen: false })
      }),
    []
  )

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <Sheet open={sidebarRestored && sidebarOpen} onOpenChange={toggleSidebar}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[85%] max-w-[360px] p-0"
        >
          <SheetTitle className="sr-only">Sidebar</SheetTitle>
          <Sidebar />
        </SheetContent>
      </Sheet>

      <main className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <MobileWorkspaceContent />
      </main>

      {/* 辅助面板（群组、终端）在手机上是主要工作区：铺满标题栏以下。非模态、点外面不关，
          标题栏的「切换辅助面板」同一个按钮开和关。 */}
      <Sheet
        open={auxRestored && auxOpen}
        onOpenChange={toggleAux}
        modal={false}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          className="p-0 pb-[env(safe-area-inset-bottom)] data-[side=right]:top-[calc(var(--vv-top,0px)+env(safe-area-inset-top)+2.5rem)] data-[side=right]:h-auto data-[side=right]:bottom-[var(--vv-gap,0px)] data-[side=right]:w-full data-[side=right]:sm:max-w-none"
        >
          <SheetTitle className="sr-only">Panel</SheetTitle>
          <AuxPanel />
        </SheetContent>
      </Sheet>
    </div>
  )
}

function FolderWorkspaceShell() {
  const sidebarOpen = useAppUiStore((state) => state.sidebarOpen)
  const sidebarRestored = useAppUiStore((state) => state.sidebarRestored)
  const sidebarWidth = useAppUiStore((state) => state.sidebarWidth)
  const sidebarMinWidth = useAppUiStore((state) => state.sidebarMinWidth)
  const sidebarMaxWidth = useAppUiStore((state) => state.sidebarMaxWidth)
  const setSidebarWidth = useAppUiStore((state) => state.setSidebarWidth)
  const auxOpen = useAppUiStore((state) => state.auxPanelOpen)
  const auxRestored = useAppUiStore((state) => state.auxPanelRestored)
  const auxWidth = useAppUiStore((state) => state.auxPanelWidth)
  const auxMinWidth = useAppUiStore((state) => state.auxPanelMinWidth)
  const auxMaxWidth = useAppUiStore((state) => state.auxPanelMaxWidth)
  const setAuxWidth = useAppUiStore((state) => state.setAuxPanelWidth)

  // The shell and its nested workspace share one scoped transaction. A sidebar
  // drag therefore defers terminal/native geometry until the committed track,
  // just like the files/conversation divider.
  const layoutTransaction = useMemo(() => createSplitLayoutTransaction(), [])
  const sidebarAnimating = usePanelSlideOnToggle(
    sidebarOpen,
    sidebarRestored,
    layoutTransaction
  )
  const auxAnimating = usePanelSlideOnToggle(
    auxOpen,
    auxRestored,
    layoutTransaction
  )
  const shellSlideAnimating = sidebarAnimating || auxAnimating

  const shellGroupRef = useRef<SplitViewHandle | null>(null)
  const shellContainerRef = useRef<HTMLDivElement | null>(null)
  const shellOuterRef = useRef<HTMLDivElement | null>(null)
  const [shellWidth, setShellWidth] = useState(0)

  useEffect(() => {
    const container = shellContainerRef.current
    if (!container) return

    const updateWidth = (next: number) => {
      setShellWidth((previous) =>
        Math.abs(previous - next) < 1 ? previous : next
      )
    }

    updateWidth(container.clientWidth)
    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? container.clientWidth)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [])

  const buildShellLayout = useCallback((): [number, number, number] => {
    const requestedLeft = sidebarOpen
      ? clamp(sidebarWidth, sidebarMinWidth, sidebarMaxWidth)
      : 0
    const requestedRight = auxOpen
      ? clamp(auxWidth, auxMinWidth, auxMaxWidth)
      : 0
    const totalWidth =
      shellWidth > 0 ? shellWidth : requestedLeft + requestedRight + 960

    let left = requestedLeft
    let right = requestedRight
    const maxSideTotal = Math.max(0, totalWidth - MIN_CENTER_WIDTH_PX)
    const sideTotal = left + right
    if (sideTotal > maxSideTotal && sideTotal > 0) {
      const scale = maxSideTotal / sideTotal
      left *= scale
      right *= scale
    }

    const center = Math.max(1, totalWidth - left - right)
    const total = left + center + right
    return [(left / total) * 100, (center / total) * 100, (right / total) * 100]
  }, [
    auxMaxWidth,
    auxMinWidth,
    auxOpen,
    auxWidth,
    shellWidth,
    sidebarMaxWidth,
    sidebarMinWidth,
    sidebarOpen,
    sidebarWidth,
  ])

  useEffect(() => {
    shellGroupRef.current?.setLayout(buildShellLayout())
  }, [buildShellLayout])

  // Align the status bar's segments with the side panes. Written straight to
  // CSS variables so pane drags/slides never re-render the status bar.
  // 变量写在状态栏自己身上：写在外层会让整个 shell 每帧重算继承样式。
  useEffect(() => {
    const shell = shellContainerRef.current
    const statusBar = shellOuterRef.current?.querySelector<HTMLElement>(
      '[data-slot="status-bar"]'
    )
    if (!shell || !statusBar) return
    const left = shell.querySelector<HTMLElement>(
      `[data-split-pane-id="${FOLDER_SHELL_LEFT_PANEL_ID}"]`
    )
    const right = shell.querySelector<HTMLElement>(
      `[data-split-pane-id="${FOLDER_SHELL_RIGHT_PANEL_ID}"]`
    )
    if (!left || !right) return
    const measure = () => {
      const box = shell.getBoundingClientRect()
      statusBar.style.setProperty(
        "--status-left",
        sidebarOpen
          ? `${left.getBoundingClientRect().right - box.left}px`
          : "auto"
      )
      statusBar.style.setProperty(
        "--status-right",
        auxOpen ? `${box.right - right.getBoundingClientRect().left}px` : "auto"
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    observer.observe(left)
    observer.observe(right)
    return () => observer.disconnect()
  }, [auxOpen, sidebarOpen])

  const handleShellLayout = useCallback(
    (layout: number[]) => {
      if (shellWidth <= 0 || layout.length !== 3) return
      if (sidebarOpen) {
        const nextSidebarWidth = clamp(
          ((layout[0] ?? 0) * shellWidth) / 100,
          sidebarMinWidth,
          sidebarMaxWidth
        )
        if (Math.abs(nextSidebarWidth - sidebarWidth) >= 1) {
          setSidebarWidth(nextSidebarWidth)
        }
      }
      if (auxOpen) {
        const nextAuxWidth = clamp(
          ((layout[2] ?? 0) * shellWidth) / 100,
          auxMinWidth,
          auxMaxWidth
        )
        if (Math.abs(nextAuxWidth - auxWidth) >= 1) {
          setAuxWidth(nextAuxWidth)
        }
      }
    },
    [
      auxMaxWidth,
      auxMinWidth,
      auxOpen,
      auxWidth,
      setAuxWidth,
      setSidebarWidth,
      shellWidth,
      sidebarMaxWidth,
      sidebarMinWidth,
      sidebarOpen,
      sidebarWidth,
    ]
  )

  return (
    <div
      ref={shellOuterRef}
      className="flex flex-1 min-h-0 flex-col overflow-hidden"
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar />
        <div
          ref={shellContainerRef}
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          <SplitLayoutTransactionProvider transaction={layoutTransaction}>
            <div className="flex-1 min-h-0 min-w-0 w-full h-full">
              <SplitView
                id={FOLDER_SHELL_GROUP_ID}
                ref={shellGroupRef}
                direction="horizontal"
                onLayout={handleShellLayout}
                transaction={layoutTransaction}
                className={
                  shellSlideAnimating ? "panel-slide-animating" : undefined
                }
              >
                <SplitPane
                  id={FOLDER_SHELL_LEFT_PANEL_ID}
                  order={1}
                  defaultSize={14}
                  collapsed={!sidebarOpen}
                  minSizePx={sidebarOpen ? sidebarMinWidth : 0}
                  maxSizePx={sidebarOpen ? sidebarMaxWidth : 0}
                >
                  {/* `bg-sidebar` on the wrapper (not just the Sidebar surface) so the
                  collapse never flashes white while the shell track animates. */}
                  <div className="h-full min-h-0 overflow-hidden ws-surface-sidebar">
                    <PerfProfiler id="sidebar">
                      <Sidebar />
                    </PerfProfiler>
                  </div>
                </SplitPane>

                <SplitHandle
                  disabled={!sidebarOpen}
                  className={
                    sidebarOpen ? "" : "pointer-events-none w-0 opacity-0 -mx-0"
                  }
                />

                <SplitPane
                  id={FOLDER_SHELL_MAIN_PANEL_ID}
                  order={2}
                  defaultSize={64}
                  minSizePx={MIN_CENTER_WIDTH_PX}
                >
                  <main className="flex h-full min-h-0 flex-col overflow-hidden">
                    <WorkspaceContent />
                  </main>
                </SplitPane>

                <SplitHandle
                  disabled={!auxOpen}
                  className={
                    auxOpen ? "" : "pointer-events-none w-0 opacity-0 -mx-0"
                  }
                />

                <SplitPane
                  id={FOLDER_SHELL_RIGHT_PANEL_ID}
                  order={3}
                  defaultSize={18}
                  collapsed={!auxOpen}
                  minSizePx={auxOpen ? auxMinWidth : 0}
                  maxSizePx={auxOpen ? auxMaxWidth : 0}
                >
                  {/* Keep the backing surface during the collapse animation so the
                  auxiliary panel never reveals a white gap. */}
                  <div className="h-full min-h-0 overflow-hidden bg-background ws-transparent-bg">
                    <PerfProfiler id="aux-panel">
                      <AuxPanel present={auxOpen || auxAnimating} />
                    </PerfProfiler>
                  </div>
                </SplitPane>
              </SplitView>
            </div>
          </SplitLayoutTransactionProvider>
        </div>
      </div>
      <PerfProfiler id="status-bar">
        <StatusBar />
      </PerfProfiler>
    </div>
  )
}

function FolderLayoutShell() {
  const isMobile = useIsMobile()
  useVisualViewportInsets(isMobile)
  const { isWindows, isLinux } = usePlatform()
  const winLinuxControls = hasNativeWindowChrome() && (isWindows || isLinux)
  const {
    workspaceBgEnabled,
    workspaceBgImageUrl,
    workspaceBgMaskOpacity,
    workspaceBgImageBlur,
    workspaceBgFillMode,
  } = useWorkspaceBackground()
  const showBackground = workspaceBgEnabled && workspaceBgImageUrl !== null
  const fillStyle = FILL_MODE_STYLE[workspaceBgFillMode]

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
      // 手机软键盘弹出时贴着键盘上沿（见 useVisualViewportInsets）；桌面变量未设，等同 inset-0。
      style={{ top: "var(--vv-top, 0px)", bottom: "var(--vv-gap, 0px)" }}
    >
      {/* 用户背景图片：铺在整个工作区底层。根 div 是 fixed，已建立层叠上下文，故
          -z-10 绘于自身 bg-background 之上、所有流内容之下。遮罩是朝 --background 的
          面纱（明暗自适配），保证内容可读；结构性面板的半透明由 globals.css 的
          [data-workspace-bg] 规则处理，不在此。 */}
      {showBackground && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-center"
            style={{
              backgroundImage: `url("${workspaceBgImageUrl}")`,
              backgroundSize: fillStyle.size,
              backgroundRepeat: fillStyle.repeat,
              filter: workspaceBgImageBlur
                ? `blur(${workspaceBgImageBlur}px)`
                : undefined,
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              backgroundColor: `color-mix(in oklch, var(--background) ${Math.round(
                workspaceBgMaskOpacity * 100
              )}%, transparent)`,
            }}
          />
        </>
      )}
      {/* Global shortcut control (formerly owned by the full-width
          FolderTitleBar). Mounted on both platforms. */}
      <WorkspaceCommandController />
      {isMobile ? (
        <>
          {/* Mobile keeps the visible full-width bar; desktop moved its buttons
              into the ActivityBar and the fixed RightEdgeChrome overlay. */}
          <FolderTitleBar />
          <MobileFolderWorkspaceShell />
          <StatusBar />
        </>
      ) : (
        <PerfProfiler id="shell">
          <FolderWorkspaceShell />
        </PerfProfiler>
      )}
      {/* Desktop window chrome, pinned to the window corners so it never moves —
          or re-mounts — when the side panels open/close (that re-parenting is
          what made the old in-header clusters flicker). The left edge belongs to
          the in-flow ActivityBar; right = aux/terminal, sitting to the LEFT of the
          Windows/Linux caption buttons; then the caption buttons themselves
          (self-null on macOS/web). Each edge column reserves the matching width
          beneath these (see leftChromeReserve / rightChromeReserve). */}
      {!isMobile && (
        <>
          <div
            className="absolute top-0 z-50 h-10"
            style={{ right: winLinuxControls ? WINDOW_CAPTION_WIDTH : 0 }}
          >
            <RightEdgeChrome />
          </div>
          <div className="absolute right-0 top-0 z-50 h-10">
            <WindowControls />
          </div>
        </>
      )}
    </div>
  )
}

function WorkspaceLayoutInner() {
  return (
    <AppWorkspaceProvider>
      <AppUiRuntime />
      <GitCredentialProvider>
        <WorkspaceRuntimeHost />
        <TabProvider>
          <WorkspaceDocumentTitle />
          <HeavyPluginsWarmup />
          <DeepLinkBootstrap />
          {/* Always mounted: external-change conflicts must be
                            resolvable even with the aux file tree closed. */}
          <ExternalConflictDialog />
          <WorkspaceOpenFolderListener />
          {/* CLI control socket 的 `berth open` 请求：main 窗口打开文件。 */}
          <WorkspaceOpenFileListener />
          <WorkspaceCurrentSelection />
          <PointerProvider>
            <FolderLayoutShell />
          </PointerProvider>
        </TabProvider>
      </GitCredentialProvider>
    </AppWorkspaceProvider>
  )
}

// 页面内容全由布局按 tab 组渲染，路由页本身为空（见 page.tsx）。
export default function WorkspaceLayout() {
  return (
    <Suspense>
      <UpdateProvider>
        <WorkspaceLayoutInner />
      </UpdateProvider>
    </Suspense>
  )
}
