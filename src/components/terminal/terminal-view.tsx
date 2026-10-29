"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { isDesktop } from "@/lib/platform"
import { useMarkAttentionSeen } from "@/lib/terminal/agent-panes"
import { bindLinuxWebKitTerminalIme } from "@/lib/terminal/linux-webkit-ime"
import type { TerminalSnapshot } from "@/lib/terminal/terminal-stream"
import {
  recordTerminalDroppedBytes,
  recordTerminalResize,
  recordTerminalResync,
  recordTerminalTransportFrame,
  recordTerminalWrite,
  recordTermResizeLatency,
} from "@/lib/terminal/terminal-performance-metrics"
import {
  skipUnchangedXtermStyleWrites,
  waitForTerminalFont,
} from "@/lib/terminal/terminal-surface"
import { DEFAULT_TERMINAL_SCROLLBACK } from "@/lib/terminal/terminal-constants"
import {
  createTerminalWriteAdapter,
  invokeTerminalWriteCallback,
} from "@/lib/terminal/terminal-write-adapter"
import {
  createTerminalSnapshotPainter,
  type TerminalSnapshotPainter,
} from "@/lib/terminal/terminal-snapshot-painter"
import { ZED_TERMINAL_THEMES } from "@/lib/visual-tokens"
import {
  createTerminalResizeCoordinator,
  type TerminalGridSize,
  type TerminalResizeCoordinator,
} from "@/lib/terminal/terminal-resize-coordinator"
import { useSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction-context"
import { useZoomLevel, useTerminalFont } from "@/hooks/use-appearance"
import { detectPlatform } from "@/hooks/use-platform"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  MOBILE_TERMINAL_KEYS_HEIGHT,
  MobileTerminalKeys,
} from "@/components/terminal/mobile-terminal-keys"
import { TerminalBackgroundOverlay } from "@/components/terminal/terminal-background-overlay"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  getTerminalRuntimeActions,
  selectTerminalSession,
  type TerminalOutputSink,
  useTerminalRuntimeStore,
} from "@/stores/terminal-runtime-store"
import { useTabStore } from "@/stores/tab-store"
import {
  bindTerminalPointer,
  readTerminalSourceIdentity,
  useOptionalPointer,
} from "@/pointer"
import type {
  ITerminalAddon,
  ITheme,
  Terminal as XTermTerminal,
} from "@xterm/xterm"

function computeTerminalFontSize(base: number, zoomLevel: number): number {
  return Math.round((base * zoomLevel) / 100)
}

type DisposableAddon = ITerminalAddon & { dispose: () => void }

// Fetch the xterm chunks in parallel as soon as this module evaluates, so the
// first terminal mount does not pay three sequential chunk loads.
let xtermModules: ReturnType<typeof importXtermModules> | null = null
function importXtermModules() {
  return Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-unicode11"),
  ])
}
function loadXtermModules() {
  xtermModules ??= importXtermModules().catch((error) => {
    xtermModules = null // let the next mount retry a failed chunk load
    throw error
  })
  return xtermModules
}
if (typeof window !== "undefined") void loadXtermModules().catch(() => {})

/** 惰性加载 @xterm/addon-ligatures（仅终端连字需要，且对系统字体可能无效）。 */
async function enableTerminalLigatures(
  term: XTermTerminal,
  ref: { current: DisposableAddon | null },
  isCurrent: () => boolean
) {
  if (ref.current) return
  try {
    const { LigaturesAddon } = await import("@xterm/addon-ligatures")
    // 动态 import resolve 后重新校验三件事，否则会有竞态：
    // 1) isCurrent()：终端仍是当前实例且连字仍需开启（覆盖「import 期间被销毁/重建」
    //    以及「import 期间用户又关掉连字」两种情况）；
    // 2) ref.current 仍为空：覆盖「并发两次 enable 都通过了 await 前检查」——
    //    校验到赋值之间无 await，先到者占位后，后到者在此返回，避免重复挂载。
    if (!isCurrent() || ref.current) return
    const addon = new LigaturesAddon() as unknown as DisposableAddon
    term.loadAddon(addon)
    ref.current = addon
  } catch (error) {
    // 连字是可选增强；失败时保留诊断并继续使用普通字体。
    console.warn("[TerminalView] ligatures unavailable", error)
  }
}

function disableTerminalLigatures(ref: { current: DisposableAddon | null }) {
  try {
    ref.current?.dispose()
  } catch (error) {
    console.warn("[TerminalView] failed to dispose ligatures", error)
  }
  ref.current = null
}

const DARK_THEME = ZED_TERMINAL_THEMES.dark
const LIGHT_THEME = ZED_TERMINAL_THEMES.light

function isDarkMode() {
  return document.documentElement.classList.contains("dark")
}

type ProjectThemeToken = "--card" | "--foreground" | "--selection"

function resolveCssColor(property: ProjectThemeToken): string | null {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(property)
    .trim()
  if (!raw) return null

  // xterm's canvas parser accepts RGB reliably across the WebKit versions we
  // support. Convert the project's modern CSS color token through the same
  // browser canvas instead of passing an oklch/color-mix string directly.
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) return null
  const sentinel = "rgb(1, 2, 3)"
  context.fillStyle = sentinel
  const initial = context.fillStyle
  context.fillStyle = raw
  if (context.fillStyle === initial) return null

  context.fillStyle = raw
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  if (alpha === 0) return null
  return alpha === 255
    ? `rgb(${red}, ${green}, ${blue})`
    : `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
}

function getTerminalTheme(): ITheme {
  const dark = isDarkMode()
  const baseTheme = dark ? DARK_THEME : LIGHT_THEME
  const color = (property: ProjectThemeToken, fallback: string) =>
    resolveCssColor(property) ?? fallback

  // 底色、正文、光标、选区取 Berth 主题；ANSI 色板保持标准终端配色，
  // 命令行与 TUI 的「蓝 / 青 / 绿」语义不被主题色改写。底色保持不透明（WebKitGTK 稳定性）。
  return {
    ...baseTheme,
    background: color("--card", baseTheme.background),
    foreground: color("--foreground", baseTheme.foreground),
    cursor: color("--foreground", baseTheme.cursor),
    cursorAccent: color("--card", baseTheme.cursorAccent),
    selectionBackground: color(
      "--selection",
      baseTheme.selectionBackground ?? baseTheme.background
    ),
  }
}

interface TerminalViewProps {
  terminalId: string
  isActive: boolean
  isVisible: boolean
  onProcessExited?: (terminalId: string, exitCode: number | null) => void
  onReopen?: () => void | Promise<void>
}

export function TerminalView({
  terminalId,
  isActive,
  isVisible,
  onProcessExited,
  onReopen,
}: TerminalViewProps) {
  const performanceMode = "attach" as const
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTermTerminal | null>(null)
  const paintSnapshotRef = useRef<
    TerminalSnapshotPainter["paintSnapshot"] | null
  >(null)
  const liveOutputRef = useRef<TerminalSnapshotPainter["writeLive"] | null>(
    null
  )
  const resizeCoordinatorRef = useRef<TerminalResizeCoordinator | null>(null)
  useMarkAttentionSeen(terminalId, isVisible)
  const isActiveRef = useRef(isActive)
  const isVisibleRef = useRef(isVisible)
  const onProcessExitedRef = useRef(onProcessExited)
  const { zoomLevel } = useZoomLevel()
  const { terminalFontStack, terminalFontSize, terminalLigatures } =
    useTerminalFont()
  const zoomLevelRef = useRef(zoomLevel)
  const terminalFontRef = useRef(terminalFontStack)
  const terminalSizeRef = useRef(terminalFontSize)
  const terminalLigaturesRef = useRef(terminalLigatures)
  const ligaturesAddonRef = useRef<DisposableAddon | null>(null)
  const [loading, setLoading] = useState(true)
  const pointer = useOptionalPointer()
  const layoutTransaction = useSplitLayoutTransaction()
  const requestResizeNow = useCallback(
    () => resizeCoordinatorRef.current?.request(),
    []
  )
  const requestResizeStable = useCallback(
    () => resizeCoordinatorRef.current?.requestStable(),
    []
  )
  const requestResize = useCallback(() => {
    if (layoutTransaction) layoutTransaction.schedule(requestResizeNow)
    else requestResizeNow()
  }, [layoutTransaction, requestResizeNow])
  const pointerRef = useRef(pointer)
  pointerRef.current = pointer

  // The terminal surface is always an attachment to the Berth runtime.
  const attachSession = useTerminalRuntimeStore(
    selectTerminalSession(terminalId)
  )
  const snapshotRevision = attachSession?.snapshotRevision ?? 0
  const attachmentGeneration = attachSession?.attachmentGeneration ?? 0
  const attachStatus = attachSession?.status
  const lastKnownCwd = attachSession?.lastKnownCwd
  const attachErrorMessage = attachSession?.errorMessage ?? null
  const lastResyncReason = attachSession?.lastResyncReason ?? null
  const isMobile = useIsMobile()
  // 手机额外键行的 Ctrl：按下后软键盘打的下一个字母按 Ctrl 组合键发送。
  const [mobileCtrl, setMobileCtrl] = useState(false)
  const mobileCtrlRef = useRef(false)
  useEffect(() => {
    mobileCtrlRef.current = mobileCtrl
  }, [mobileCtrl])
  const tTerminal = useTranslations("Folder.terminal")
  /** Local attach failure when runtime store has no structured status yet. */
  const [localAttachError, setLocalAttachError] = useState<string | null>(null)
  const paintedSnapshotRevisionRef = useRef<number | null>(null)
  const surfaceDirtyRef = useRef(false)
  const dirtyRecoveryPendingRef = useRef(false)
  const requestDirtyRecoveryRef = useRef<(() => void) | null>(null)
  const exitReportedRef = useRef(false)
  const overlayViewportRef = useRef<HTMLElement | null>(null)
  const scrollDummyRef = useRef<HTMLDivElement | null>(null)
  const isScrollSyncingRef = useRef(false)
  /** 权威 reflow 窗口内暂停 scroll/布局同步,结束后同步终态一次。 */
  const reflowSuppressingScrollRef = useRef(false)

  const syncScrollFromTerm = useCallback(() => {
    const term = termRef.current
    const viewport = overlayViewportRef.current
    const dummy = scrollDummyRef.current
    const container = containerRef.current
    if (!term || !viewport || !dummy || !container) return

    const buffer = term.buffer.active
    const baseY = buffer.baseY
    const rows = term.rows
    const viewportY = buffer.viewportY
    const containerHeight = container.clientHeight
    if (containerHeight <= 0 || rows <= 0) return

    const lineHeight = containerHeight / rows
    const totalLines = baseY + rows
    const totalHeight = baseY > 0 ? totalLines * lineHeight : containerHeight
    const scrollTop = baseY > 0 ? viewportY * lineHeight : 0

    const currentHeightPx = `${Math.ceil(totalHeight)}px`
    if (dummy.style.height !== currentHeightPx) {
      dummy.style.height = currentHeightPx
    }

    if (!isScrollSyncingRef.current) {
      isScrollSyncingRef.current = true
      viewport.scrollTop = scrollTop
      requestAnimationFrame(() => {
        isScrollSyncingRef.current = false
      })
    }
  }, [])

  const handleOverlayScroll = useCallback((event: Event) => {
    if (isScrollSyncingRef.current) return
    const target = event.target as HTMLElement
    if (!target) return
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return

    const rows = term.rows
    const containerHeight = container.clientHeight
    if (containerHeight <= 0 || rows <= 0) return

    const lineHeight = containerHeight / rows
    const targetLine = Math.round(target.scrollTop / lineHeight)

    isScrollSyncingRef.current = true
    term.scrollToLine(targetLine)
    requestAnimationFrame(() => {
      isScrollSyncingRef.current = false
    })
  }, [])

  useEffect(() => {
    if (!lastKnownCwd) return
    useTabStore.getState().updateTerminalLastKnownCwd(terminalId, lastKnownCwd)
  }, [lastKnownCwd, terminalId])

  useEffect(() => {
    isActiveRef.current = isActive
    isVisibleRef.current = isVisible
  }, [isActive, isVisible])

  useEffect(() => {
    onProcessExitedRef.current = onProcessExited
  }, [onProcessExited])

  useEffect(() => {
    if (attachStatus !== "exited") return
    if (exitReportedRef.current) return
    exitReportedRef.current = true
    const code = attachSession?.exitCode
    const suffix = code == null ? "" : ` (code ${code})`
    liveOutputRef.current?.(`\r\n\x1b[90m[Process exited${suffix}]\x1b[0m\r\n`)
    onProcessExitedRef.current?.(terminalId, code ?? null)
  }, [attachSession?.exitCode, attachStatus, terminalId])

  useEffect(() => {
    if (lastResyncReason) recordTerminalResync(terminalId, performanceMode)
  }, [lastResyncReason, terminalId])

  // Every authoritative snapshot enters xterm through the same paint path.
  useEffect(() => {
    if (!paintSnapshotRef.current) return
    if (paintedSnapshotRevisionRef.current === snapshotRevision) return
    const currentSnapshot =
      useTerminalRuntimeStore.getState().sessions[terminalId]?.snapshot
    if (!currentSnapshot) return
    paintedSnapshotRevisionRef.current = snapshotRevision
    void paintSnapshotRef.current(currentSnapshot, {
      sourceGeneration: attachmentGeneration,
    })
  }, [attachmentGeneration, snapshotRevision, terminalId])

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | undefined
    let disposeOutputSink: (() => void) | undefined

    async function init() {
      // A reused component can switch terminal ids or modes without losing
      // the React instance. The revision counter belongs to the xterm instance,
      // so never let the previous surface suppress the first paint here.
      paintedSnapshotRevisionRef.current = null
      surfaceDirtyRef.current = false
      dirtyRecoveryPendingRef.current = false
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
      ] = await loadXtermModules()

      if (cancelled || !containerRef.current) return
      await waitForTerminalFont(terminalFontRef.current)
      if (cancelled || !containerRef.current) return

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon()
      const term = new Terminal({
        cursorBlink: false,
        scrollback: DEFAULT_TERMINAL_SCROLLBACK,
        scrollSensitivity: 1,
        fastScrollSensitivity: 5,
        fontSize: computeTerminalFontSize(
          terminalSizeRef.current,
          zoomLevelRef.current
        ),
        fontFamily: terminalFontRef.current,
        theme: getTerminalTheme(),
        // Keep the framebuffer opaque to avoid Linux WebKitGTK transparency
        // artifacts. The color is still the shared workspace surface color.
        allowTransparency: false,
        // 按深色背景设计的 TUI（灰字、dim）在浅色底上会发虚：对比度不足时由 xterm 自动加深/提亮前景（WCAG AA）。
        minimumContrastRatio: 4.5,
        allowProposedApi: true,
        // Agent 输出里的非法转义序列 xterm 会跳过并 console.error，dev 下被 Next 弹成错误浮层；
        // 解析本身不受影响，关掉 xterm 自身日志。
        logLevel: "off",
      })

      term.loadAddon(fitAddon)
      term.loadAddon(webLinksAddon)
      // xterm 默认 Unicode 6 把 emoji 算 1 列，Agent CLI 与 daemon 按新表算 2 列；
      // 宽度表不一致会让同一行后续字符整体错位。
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = "11"
      term.open(containerRef.current)
      skipUnchangedXtermStyleWrites(containerRef.current)
      const disposePointer = bindTerminalPointer({
        host: containerRef.current,
        term,
        getIdentity: () => readTerminalSourceIdentity(terminalId),
        getPointer: () => pointerRef.current,
      })
      const focusWhenReady = () => {
        requestAnimationFrame(() => {
          if (
            !cancelled &&
            isActiveRef.current &&
            isVisibleRef.current &&
            termRef.current === term
          ) {
            term.focus()
          }
        })
      }
      const disposeLinuxWebKitIme = bindLinuxWebKitTerminalIme(term, {
        isLinux: detectPlatform() === "linux",
        isTauri: isDesktop(),
      })

      // WebKitGTK 下 xterm 内建滚轮有时滚不动 scrollback。
      // 在容器捕获阶段强制 scrollLines；alternate-screen 或应用启用 mouse
      // tracking 时不拦截，滚轮必须作为终端输入交给应用（例如 less、vim、htop）。
      // 不用 capture+stopPropagation 全盘抢事件，避免与滚动条拖动互相打架；
      // 仅在有 scrollback、normal screen 且没有 mouse tracking 时自己滚。
      const hostEl = containerRef.current
      termRef.current = term
      const snapshotHooks: {
        onSnapshotStart?: (sourceGeneration: number) => void
        onSnapshotReady?: (
          snapshot: TerminalSnapshot,
          sourceGeneration: number
        ) => boolean | void
        onLiveOverflow?: (sourceGeneration: number) => void
        onHiddenLiveOverflow?: (
          sourceGeneration: number,
          droppedBytes: number
        ) => void
      } = {}

      const onHostWheel = (event: WheelEvent) => {
        if (termRef.current !== term) return
        if (term.buffer.active.type === "alternate") return
        if (term.modes.mouseTrackingMode !== "none") return
        const buffer = term.buffer.active
        if (buffer.baseY <= 0) return
        const atTop = buffer.viewportY <= 0
        const atBottom = buffer.viewportY >= buffer.baseY
        if (atTop && event.deltaY < 0) return
        if (atBottom && event.deltaY > 0) return

        event.preventDefault()

        let lineDelta: number
        // 0 = pixel, 1 = line, 2 = page (DOM_DELTA_*)
        if (event.deltaMode === 1) {
          lineDelta = event.deltaY
        } else if (event.deltaMode === 2) {
          lineDelta = event.deltaY * term.rows
        } else {
          const cell = Math.max(term.options.fontSize ?? 14, 8)
          lineDelta = event.deltaY / cell
        }
        // Prefer integer steps; avoid sub-line trunc→0 chatter that feels like
        // oscillation when agent output is also adjusting the buffer.
        const lines =
          Math.round(lineDelta) ||
          (event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0)
        if (lines !== 0) term.scrollLines(lines)
      }
      hostEl.addEventListener("wheel", onHostWheel, { passive: false })
      // 触屏：xterm 没有触摸滚动，这里按行高换算成行数，照 xterm 对滚轮的处理分三路：
      // 应用开了 mouse tracking → 逐行合成滚轮事件交给 xterm 编码成鼠标滚轮报告；
      // 普通屏滚 scrollback（手指下移看更早的行）；其余全屏应用发上下方向键。
      let touchY: number | null = null
      let touchMoved = false
      let touchRemainder = 0
      const onHostTouchStart = (event: TouchEvent) => {
        touchY = event.touches.length === 1 ? event.touches[0].clientY : null
        touchMoved = false
        touchRemainder = 0
      }
      const onHostTouchMove = (event: TouchEvent) => {
        if (touchY === null || event.touches.length !== 1) return
        const y = event.touches[0].clientY
        // 小于几像素当作点按（聚焦终端、弹键盘），不滚
        if (!touchMoved && Math.abs(y - touchY) < 6) return
        touchMoved = true
        event.preventDefault()
        const rowHeight = hostEl.clientHeight / Math.max(term.rows, 1)
        touchRemainder += (touchY - y) / rowHeight
        touchY = y
        const lines = Math.trunc(touchRemainder)
        if (lines === 0) return
        touchRemainder -= lines
        if (term.modes.mouseTrackingMode !== "none" && term.element) {
          const touch = event.touches[0]
          for (let i = 0; i < Math.abs(lines); i++)
            term.element.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                clientX: touch.clientX,
                clientY: touch.clientY,
                deltaMode: WheelEvent.DOM_DELTA_LINE,
                deltaY: Math.sign(lines),
              })
            )
          return
        }
        if (term.buffer.active.type === "normal") {
          term.scrollLines(lines)
          return
        }
        const arrow = term.modes.applicationCursorKeysMode
          ? lines < 0
            ? "\u001bOA"
            : "\u001bOB"
          : lines < 0
            ? "\u001b[A"
            : "\u001b[B"
        getTerminalRuntimeActions().sendInput(
          terminalId,
          arrow.repeat(Math.abs(lines))
        )
      }
      hostEl.addEventListener("touchstart", onHostTouchStart, { passive: true })
      hostEl.addEventListener("touchmove", onHostTouchMove, { passive: false })
      const disposeHostWheel = () => {
        hostEl.removeEventListener("wheel", onHostWheel)
        hostEl.removeEventListener("touchstart", onHostTouchStart)
        hostEl.removeEventListener("touchmove", onHostTouchMove)
      }

      const outputWriter = createTerminalWriteAdapter({
        write: (data, callback) => term.write(data, callback),
      })
      const snapshotPainter = createTerminalSnapshotPainter(
        term,
        outputWriter,
        {
          onSnapshotStart: (sourceGeneration) =>
            snapshotHooks.onSnapshotStart?.(sourceGeneration),
          onSnapshotReady: (snapshot, sourceGeneration) =>
            snapshotHooks.onSnapshotReady?.(snapshot, sourceGeneration),
          onLiveOverflow: (sourceGeneration) =>
            snapshotHooks.onLiveOverflow?.(sourceGeneration),
          onHiddenLiveOverflow: (sourceGeneration, droppedBytes) =>
            snapshotHooks.onHiddenLiveOverflow?.(
              sourceGeneration,
              droppedBytes
            ),
          isVisible: () => isVisibleRef.current,
          onTermResizeLatency: (durationMs) =>
            recordTermResizeLatency(terminalId, performanceMode, durationMs),
          onTermReflowStart: () => {
            reflowSuppressingScrollRef.current = true
          },
          onTermReflowEnd: () => {
            // reflow 中间态不渲染;终态在下一帧统一同步一次。
            requestAnimationFrame(() => {
              reflowSuppressingScrollRef.current = false
              if (!cancelled && termRef.current === term) {
                syncScrollFromTerm()
              }
            })
          },
        }
      )
      const writeLiveOutput = snapshotPainter.writeLive
      const paintSnapshot = snapshotPainter.paintSnapshot
      liveOutputRef.current = writeLiveOutput
      let resizeEnabled = false
      let resizeAwaitingSnapshot = false
      let snapshotLiveOverflowed = false
      let previewFrame: ReturnType<typeof requestAnimationFrame> | null = null
      let cancelRestoreFrame: ReturnType<typeof requestAnimationFrame> | null =
        null
      let cancelRestoreReleaseFrame: ReturnType<
        typeof requestAnimationFrame
      > | null = null
      let cancelRestorePending = false
      let lastPreviewGrid: TerminalGridSize | null = null
      let previewCandidate: TerminalGridSize | null = null
      let previewCandidateFrames = 0
      let lastPreviewDirection = { cols: 0, rows: 0 }

      const sameGrid = (left: TerminalGridSize, right: TerminalGridSize) =>
        left.cols === right.cols && left.rows === right.rows

      const measureGrid = (): TerminalGridSize | null => {
        const el = containerRef.current
        if (
          !resizeEnabled ||
          !el ||
          !isVisibleRef.current ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return null
        }
        const dimensions = fitAddon.proposeDimensions()
        if (
          !dimensions ||
          !Number.isFinite(dimensions.cols) ||
          !Number.isFinite(dimensions.rows) ||
          dimensions.cols < 1 ||
          dimensions.rows < 1
        ) {
          return null
        }
        return { cols: dimensions.cols, rows: dimensions.rows }
      }

      const resetPreviewHysteresis = () => {
        previewCandidate = null
        previewCandidateFrames = 0
        lastPreviewDirection = { cols: 0, rows: 0 }
      }

      const shouldApplyPreviewGrid = (next: TerminalGridSize): boolean => {
        if (!lastPreviewGrid) {
          const currentGrid =
            typeof term.cols === "number" && typeof term.rows === "number"
              ? { cols: term.cols, rows: term.rows }
              : null
          lastPreviewGrid = currentGrid
        }
        if (!lastPreviewGrid) {
          resetPreviewHysteresis()
          return true
        }
        if (sameGrid(lastPreviewGrid, next)) {
          resetPreviewHysteresis()
          return false
        }

        const colsDelta = next.cols - lastPreviewGrid.cols
        const rowsDelta = next.rows - lastPreviewGrid.rows
        const smallChange = Math.abs(colsDelta) <= 1 && Math.abs(rowsDelta) <= 1
        const reversesRecentMovement =
          (colsDelta !== 0 &&
            lastPreviewDirection.cols !== 0 &&
            Math.sign(colsDelta) !== lastPreviewDirection.cols) ||
          (rowsDelta !== 0 &&
            lastPreviewDirection.rows !== 0 &&
            Math.sign(rowsDelta) !== lastPreviewDirection.rows)

        if (!smallChange || !reversesRecentMovement) {
          previewCandidate = null
          previewCandidateFrames = 0
          return true
        }

        if (previewCandidate && sameGrid(previewCandidate, next)) {
          previewCandidateFrames += 1
        } else {
          previewCandidate = { ...next }
          previewCandidateFrames = 1
        }
        if (previewCandidateFrames < 2) return false
        previewCandidate = null
        previewCandidateFrames = 0
        return true
      }

      const applyLocalGrid = (
        next: TerminalGridSize,
        precise: boolean
      ): void => {
        if (!precise && !shouldApplyPreviewGrid(next)) return
        if (precise) resetPreviewHysteresis()
        const previous = lastPreviewGrid
        lastPreviewGrid = { ...next }
        if (previous) {
          lastPreviewDirection = {
            cols: Math.sign(next.cols - previous.cols),
            rows: Math.sign(next.rows - previous.rows),
          }
        }
        if (precise) {
          // Commit/cancel restore: authoritative grid change, repaint now.
          snapshotPainter.requestLocalResize(next)
        }
        // Preview (non-precise): container CSS already tracks the pointer
        // (layout layer); the xterm grid stays frozen for the drag. Each
        // frozen preview step previously cost a full-buffer reflow
        // (~51ms p50 measured); the final commit performs exactly one.
      }

      const cancelFrame = (
        frame: ReturnType<typeof requestAnimationFrame> | null
      ) => {
        if (frame === null) return
        cancelAnimationFrame(frame)
      }

      const schedulePreviewLocalFit = () => {
        if (previewFrame !== null) return
        previewFrame = requestAnimationFrame(() => {
          previewFrame = null
          if (cancelled || !layoutTransaction?.isPreviewing()) return
          const next = measureGrid()
          if (next) applyLocalGrid(next, false)
        })
      }

      const scheduleCancelLocalFit = () => {
        cancelRestorePending = true
        if (cancelRestoreFrame !== null) return
        cancelRestoreFrame = requestAnimationFrame(() => {
          cancelRestoreFrame = null
          if (!cancelled) {
            const next = measureGrid()
            if (next) applyLocalGrid(next, true)
          }
          if (cancelRestoreReleaseFrame === null) {
            cancelRestoreReleaseFrame = requestAnimationFrame(() => {
              cancelRestoreReleaseFrame = null
              cancelRestorePending = false
            })
          }
        })
      }

      const resizeCoordinator = createTerminalResizeCoordinator({
        measure: measureGrid,
        apply: async ({ cols, rows }) => {
          recordTerminalResize(terminalId, performanceMode, "requested")
          // Commit: apply the final grid locally first (measured reflow is
          // a few ms), so the visible surface never lingers in a
          // clipped/letterboxed intermediate state across the PTY round
          // trip — large drags showed that gap as a flash. The confirmed
          // geometry afterwards remains authoritative: resizeTerminal
          // below still runs, and sameGrid makes it a no-op.
          snapshotPainter.requestLocalResize({ cols, rows })
          const applied = await snapshotPainter.resizeTerminal(
            { cols, rows },
            async () => {
              const sourceGeneration =
                useTerminalRuntimeStore.getState().sessions[terminalId]
                  ?.attachmentGeneration ?? 0
              const snapshot = await getTerminalRuntimeActions().resize(
                terminalId,
                rows,
                cols
              )
              if (cancelled || !snapshot) {
                resizeAwaitingSnapshot = true
                return false
              }
              const currentSession =
                useTerminalRuntimeStore.getState().sessions[terminalId]
              if (
                !currentSession ||
                currentSession.attachmentGeneration !== sourceGeneration
              ) {
                resizeAwaitingSnapshot = true
                return false
              }
              resizeAwaitingSnapshot = false
              return true
            }
          )
          if (applied) {
            lastPreviewGrid = { cols, rows }
            resetPreviewHysteresis()
            recordTerminalResize(terminalId, performanceMode, "applied")
          }
          return applied
        },
        onDuplicate: (size) => {
          // A duplicate PTY size still needs to finish a one-cell preview that
          // hysteresis deliberately held back. This remains local-only.
          applyLocalGrid(size, true)
          recordTerminalResize(terminalId, performanceMode, "duplicate")
        },
      })
      resizeCoordinatorRef.current = resizeCoordinator
      if (terminalLigaturesRef.current) {
        enableTerminalLigatures(
          term,
          ligaturesAddonRef,
          () => termRef.current === term && terminalLigaturesRef.current
        )
      }

      const isMac = detectPlatform() === "macos"

      // 明暗切换会改终端配色，原地推新主题而不重建终端。
      const themeObserver = new MutationObserver(() => {
        term.options.theme = getTerminalTheme()
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      })

      // Fit whenever the surface has a real box (including inactive tiles in
      // tile mode). Preview only changes xterm's local grid; PTY resize is
      // reserved for the transaction's final commit or ordinary external
      // geometry changes.
      const onObservedResize = () => {
        if (layoutTransaction?.isPreviewing()) {
          schedulePreviewLocalFit()
        } else if (cancelRestorePending) {
          scheduleCancelLocalFit()
        } else {
          requestResizeNow()
        }
      }
      const disposeLayoutCommit = layoutTransaction?.subscribeCommit(
        (commit) => {
          cancelFrame(previewFrame)
          previewFrame = null
          resetPreviewHysteresis()
          if (commit.reason === "divider") requestResizeStable()
          else requestResizeNow()
        }
      )
      const disposeLayoutCancel = layoutTransaction?.subscribeCancel(() => {
        cancelFrame(previewFrame)
        previewFrame = null
        resetPreviewHysteresis()
        scheduleCancelLocalFit()
      })
      const resizeObserver = new ResizeObserver(onObservedResize)
      resizeObserver.observe(containerRef.current)

      // ── Attach mode: reuse xterm surface, IO via TerminalStream runtime ──
      const actions = getTerminalRuntimeActions()
      snapshotHooks.onSnapshotStart = (sourceGeneration) => {
        snapshotLiveOverflowed = false
        actions.beginSnapshotPaint(terminalId, sourceGeneration)
      }
      snapshotHooks.onSnapshotReady = (snapshot, sourceGeneration) => {
        if (snapshotLiveOverflowed) return false
        const currentSession =
          useTerminalRuntimeStore.getState().sessions[terminalId]
        if (
          !currentSession ||
          currentSession.attachmentGeneration !== sourceGeneration
        ) {
          snapshotLiveOverflowed = true
          actions.beginSnapshotPaint(terminalId, sourceGeneration)
          if (
            currentSession &&
            currentSession.attachmentGeneration < sourceGeneration
          ) {
            void actions.retrySnapshot(terminalId, "stale_snapshot_source")
          }
          return false
        }
        lastPreviewGrid = { cols: snapshot.cols, rows: snapshot.rows }
        resetPreviewHysteresis()
        invokeTerminalWriteCallback(() =>
          actions.acknowledgeOutput(
            terminalId,
            snapshot.sequence,
            sourceGeneration
          )
        )
        surfaceDirtyRef.current = false
        dirtyRecoveryPendingRef.current = false
        invokeTerminalWriteCallback(() =>
          actions.activateOutputSink(terminalId, sourceGeneration)
        )
        if (resizeAwaitingSnapshot) {
          requestResize()
        }
        return true
      }
      snapshotHooks.onLiveOverflow = (sourceGeneration) => {
        const currentSession =
          useTerminalRuntimeStore.getState().sessions[terminalId]
        if (
          !currentSession ||
          currentSession.attachmentGeneration !== sourceGeneration
        ) {
          return
        }
        snapshotLiveOverflowed = true
        // Stop accepting new PTY chunks before starting the reattach. The
        // painter has already dropped its bounded queue, so runtime-side
        // output must remain parked until a fresh snapshot is ready.
        actions.beginSnapshotPaint(terminalId, sourceGeneration)
        void actions.retrySnapshot(terminalId, "snapshot_live_overflow")
      }
      snapshotHooks.onHiddenLiveOverflow = (sourceGeneration, droppedBytes) => {
        const currentSession =
          useTerminalRuntimeStore.getState().sessions[terminalId]
        if (
          !currentSession ||
          currentSession.attachmentGeneration !== sourceGeneration
        ) {
          return
        }
        surfaceDirtyRef.current = true
        recordTerminalDroppedBytes(terminalId, performanceMode, droppedBytes)
      }
      const requestDirtyRecovery = () => {
        if (
          cancelled ||
          !surfaceDirtyRef.current ||
          dirtyRecoveryPendingRef.current ||
          !isVisibleRef.current
        ) {
          return
        }
        dirtyRecoveryPendingRef.current = true
        const generation =
          useTerminalRuntimeStore.getState().sessions[terminalId]
            ?.attachmentGeneration
        actions.beginSnapshotPaint(terminalId, generation)
        void actions
          .retrySnapshot(terminalId, "hidden_output_overflow")
          .catch((error) => {
            dirtyRecoveryPendingRef.current = false
            console.error("[TerminalView] dirty surface recovery failed", error)
          })
      }
      requestDirtyRecoveryRef.current = requestDirtyRecovery
      paintSnapshotRef.current = paintSnapshot
      const disposeSurfacePasteAdapter = actions.setSurfacePasteAdapter(
        terminalId,
        (text) => {
          if (termRef.current !== term) return
          // 未开 bracketed paste 时 xterm 把换行转成回车，多行会被逐行提交
          if (text.includes("\n") && !term.modes.bracketedPasteMode) {
            return false
          }
          term.paste(text)
          // 粘贴后把焦点交给终端，用户接着补充要求再自己回车
          term.focus()
        }
      )

      // Complete the writer callback only after xterm's parser has consumed
      // the batch. Web uses that callback as its transport ACK; local Tauri
      // keeps ordering in the Channel/Rust adapter and does not publish a
      // per-batch ACK into runtime state.
      const outputSink: TerminalOutputSink = (data, onApplied) => {
        if (surfaceDirtyRef.current) requestDirtyRecovery()
        try {
          recordTerminalTransportFrame(
            terminalId,
            performanceMode,
            data.byteLength
          )
        } catch (error) {
          console.error("[TerminalView] transport metrics failed", error)
        }
        if (termRef.current === term) {
          let recordApplied = () => {}
          try {
            recordApplied = recordTerminalWrite(
              terminalId,
              performanceMode,
              data.byteLength
            )
          } catch (error) {
            console.error("[TerminalView] write metrics failed", error)
          }
          writeLiveOutput(data, () => {
            // Metrics are diagnostic only. Keep the transport ACK on its own
            // guarded path so a metrics regression cannot stall output.
            try {
              recordApplied()
            } catch (error) {
              console.error("[TerminalView] write metrics failed", error)
            }
            invokeTerminalWriteCallback(onApplied)
          })
        } else {
          void actions.retrySnapshot(terminalId, "surface_replaced")
        }
      }
      disposeOutputSink = actions.setOutputSink(terminalId, outputSink)

      const writeSeq = (seq: string) => {
        snapshotPainter.markUserInput()
        actions.sendInput(terminalId, seq)
        return true
      }

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true
        if (e.isComposing) return true

        const { code, altKey, metaKey, ctrlKey, shiftKey } = e
        if (altKey && !ctrlKey && !metaKey && !shiftKey) {
          if (code === "ArrowLeft") {
            e.preventDefault()
            return !writeSeq("\x1bb")
          }
          if (code === "ArrowRight") {
            e.preventDefault()
            return !writeSeq("\x1bf")
          }
          if (code === "Backspace") {
            e.preventDefault()
            return !writeSeq("\x1b\x7f")
          }
        }
        if (isMac && metaKey && !altKey && !ctrlKey && !shiftKey) {
          if (code === "ArrowLeft") {
            e.preventDefault()
            return !writeSeq("\x01")
          }
          if (code === "ArrowRight") {
            e.preventDefault()
            return !writeSeq("\x05")
          }
          if (code === "Backspace") {
            e.preventDefault()
            return !writeSeq("\x15")
          }
        }
        return true
      })

      const onDataDisposable = term.onData((typed: string) => {
        let data = typed
        if (data === "\x1b[I" || data === "\x1b[O") return
        snapshotPainter.markUserInput()
        if (mobileCtrlRef.current && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0)
          if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
          mobileCtrlRef.current = false
          setMobileCtrl(false)
        }
        actions.sendInput(terminalId, data)
      })

      const onScrollDisposable = term.onScroll(() => {
        if (reflowSuppressingScrollRef.current) return
        syncScrollFromTerm()
      })
      const onWriteParsedDisposable = term.onWriteParsed(() => {
        if (reflowSuppressingScrollRef.current) return
        syncScrollFromTerm()
      })
      const onResizeDisposable = term.onResize(() => {
        if (reflowSuppressingScrollRef.current) return
        syncScrollFromTerm()
      })

      try {
        setLocalAttachError(null)
        await actions.attachTerminal(terminalId, { freshSnapshot: true })
        const currentSession =
          useTerminalRuntimeStore.getState().sessions[terminalId]
        const currentSnapshot = currentSession?.snapshot
        if (
          currentSnapshot &&
          paintedSnapshotRevisionRef.current !== currentSession.snapshotRevision
        ) {
          paintedSnapshotRevisionRef.current = currentSession.snapshotRevision
          await paintSnapshot(currentSnapshot, {
            sourceGeneration: currentSession.attachmentGeneration,
          })
        }
        // Fit after attach so cols/rows match the pane.
        if (!cancelled) {
          resizeEnabled = true
          requestAnimationFrame(() => {
            if (!cancelled) {
              requestResize()
              syncScrollFromTerm()
            }
          })
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err ?? "attach failed")
        if (!cancelled) setLocalAttachError(msg)
        writeLiveOutput(
          `\r\n\x1b[31m[Failed to attach terminal: ${msg}]\x1b[0m\r\n`
        )
      } finally {
        if (!cancelled) {
          setLoading(false)
          focusWhenReady()
          syncScrollFromTerm()
        }
      }

      if (cancelled) {
        disposeOutputSink?.()
        disposeOutputSink = undefined
        disposeSurfacePasteAdapter()
        snapshotPainter.dispose()
        outputWriter.dispose()
        paintSnapshotRef.current = null
        liveOutputRef.current = null
        themeObserver.disconnect()
        onDataDisposable.dispose()
        onScrollDisposable.dispose()
        onWriteParsedDisposable.dispose()
        onResizeDisposable.dispose()
        resizeObserver.disconnect()
        cancelFrame(previewFrame)
        cancelFrame(cancelRestoreFrame)
        cancelFrame(cancelRestoreReleaseFrame)
        previewFrame = null
        cancelRestoreFrame = null
        cancelRestoreReleaseFrame = null
        disposeLayoutCommit?.()
        disposeLayoutCancel?.()
        resizeCoordinator.dispose()
        requestDirtyRecoveryRef.current = null
        disposeHostWheel()
        disposeLinuxWebKitIme()
        disposePointer()
        term.dispose()
        return
      }

      cleanup = () => {
        paintedSnapshotRevisionRef.current = null
        disposeOutputSink?.()
        disposeOutputSink = undefined
        disposeSurfacePasteAdapter()
        snapshotPainter.dispose()
        outputWriter.dispose()
        paintSnapshotRef.current = null
        liveOutputRef.current = null
        themeObserver.disconnect()
        onDataDisposable.dispose()
        onScrollDisposable.dispose()
        onWriteParsedDisposable.dispose()
        onResizeDisposable.dispose()
        resizeObserver.disconnect()
        cancelFrame(previewFrame)
        cancelFrame(cancelRestoreFrame)
        cancelFrame(cancelRestoreReleaseFrame)
        previewFrame = null
        cancelRestoreFrame = null
        cancelRestoreReleaseFrame = null
        disposeLayoutCommit?.()
        disposeLayoutCancel?.()
        resizeCoordinator.dispose()
        requestDirtyRecoveryRef.current = null
        disposeHostWheel()
        disposeLinuxWebKitIme()
        disposePointer()
        term.dispose()
        termRef.current = null
        ligaturesAddonRef.current = null
        resizeCoordinatorRef.current = null
      }
      return
    }

    init()

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [
    layoutTransaction,
    requestResize,
    requestResizeNow,
    requestResizeStable,
    syncScrollFromTerm,
    terminalId,
  ])

  // 恢复可见时补一次尺寸同步；常规几何变化由 ResizeObserver 负责。
  useEffect(() => {
    if (!isVisible) return
    requestAnimationFrame(() => {
      const surfaceWasDirty = surfaceDirtyRef.current
      if (surfaceWasDirty) requestDirtyRecoveryRef.current?.()
      const el = containerRef.current
      if (!surfaceWasDirty && el && el.clientWidth > 0 && el.clientHeight > 0) {
        requestResize()
      }
      syncScrollFromTerm()
      if (isActive) {
        termRef.current?.focus()
      }
    })
  }, [isActive, isVisible, requestResize, syncScrollFromTerm, terminalId])

  // React to zoom / font-family / font-size changes. Updates refs synchronously so
  // async init() always reads the latest values, then requests one coordinated fit.
  useEffect(() => {
    zoomLevelRef.current = zoomLevel
    terminalFontRef.current = terminalFontStack
    terminalSizeRef.current = terminalFontSize
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack
    term.options.fontSize = computeTerminalFontSize(terminalFontSize, zoomLevel)
    requestAnimationFrame(requestResize)
  }, [requestResize, terminalFontStack, terminalFontSize, zoomLevel])

  // React to the ligature toggle. Lazily loads @xterm/addon-ligatures on enable,
  // disposes it on disable.
  useEffect(() => {
    terminalLigaturesRef.current = terminalLigatures
    const term = termRef.current
    if (!term) return
    if (terminalLigatures) {
      enableTerminalLigatures(
        term,
        ligaturesAddonRef,
        () => termRef.current === term && terminalLigaturesRef.current
      )
    } else {
      disableTerminalLigatures(ligaturesAddonRef)
    }
  }, [terminalLigatures])

  const loadingLabel = "Attaching terminal..."
  const showMobileKeys = isActive && isMobile && !loading

  const statusBanner =
    isActive && !loading
      ? attachStatus === "expired" || attachStatus === "cleared"
        ? tTerminal("statusRestarted")
        : attachStatus === "exited"
          ? tTerminal("statusExited")
          : attachStatus === "degraded" ||
              attachStatus === "disconnected" ||
              localAttachError
            ? attachErrorMessage ||
              localAttachError ||
              tTerminal("statusDisconnected")
            : null
      : null

  return (
    <div
      className="absolute inset-0 h-full w-full bg-card p-2 pb-0"
      style={{
        // isVisible covers active + tiled peers so non-selected tiles still
        // paint; warmed-but-background tabs pass isVisible=false and stay hidden.
        visibility: isVisible ? "visible" : "hidden",
        // Interaction only on the focused tile; others remain viewable.
        pointerEvents: isActive ? "auto" : "none",
      }}
      aria-hidden={!isActive}
      data-terminal-mode="attach"
      data-terminal-surface="true"
      data-terminal-status={attachStatus ?? ""}
    >
      {statusBanner && (
        <div className="absolute inset-x-2 top-2 z-20 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{statusBanner}</span>
          {onReopen &&
          (attachStatus === "expired" ||
            attachStatus === "cleared" ||
            attachStatus === "exited") ? (
            <button
              type="button"
              className="shrink-0 rounded border border-current px-2 py-1 font-medium hover:bg-destructive/10"
              onClick={() => void onReopen()}
            >
              {tTerminal("reopenTerminal")}
            </button>
          ) : null}
        </div>
      )}
      <div
        className="relative min-h-0 w-full min-w-0 overflow-hidden"
        // 手机额外键行在终端下方，不压住最后一行（输入行）。
        style={{
          height: showMobileKeys
            ? `calc(100% - ${MOBILE_TERMINAL_KEYS_HEIGHT})`
            : "100%",
        }}
      >
        <div
          ref={containerRef}
          className="absolute inset-0 h-full min-h-0 w-full min-w-0"
        />
        <TerminalBackgroundOverlay visible={isVisible} />
        <ScrollArea
          onViewportRef={(element) => {
            overlayViewportRef.current = element
            syncScrollFromTerm()
          }}
          onScroll={handleOverlayScroll}
          className="pointer-events-none absolute inset-0 h-full w-full [&_.os-scrollbar]:pointer-events-auto"
        >
          <div
            ref={scrollDummyRef}
            style={{ width: "1px", height: "100%", pointerEvents: "none" }}
          />
        </ScrollArea>
      </div>
      {showMobileKeys && (
        <div className="absolute inset-x-0 bottom-0 z-10">
          <MobileTerminalKeys
            terminalId={terminalId}
            ctrlArmed={mobileCtrl}
            onCtrlArmedChange={setMobileCtrl}
          />
        </div>
      )}
      {loading && isActive && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-card/80">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span>{loadingLabel}</span>
          </div>
        </div>
      )}
    </div>
  )
}
