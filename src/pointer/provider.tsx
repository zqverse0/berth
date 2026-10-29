"use client"

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import { toast } from "@/lib/notify"
import { useTranslations } from "next-intl"
import {
  Copy,
  Sparkles,
  Languages,
  ExternalLink,
  FileCode2,
  FolderOpen,
} from "lucide-react"

import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import { toErrorMessage } from "@/lib/app-error"
import { isTranslateProviderId, translateText } from "@/lib/translate"
import { normalizeWebReaderUrl } from "@/lib/web-document"
import { cn } from "@/lib/utils"

import {
  isPointerOwnedTarget,
  readDomExcerpt,
  resolveContextMenuSelection,
  selectionTouchesTarget,
  shouldInterceptContextMenu,
} from "./capture"
import { copyPlainToClipboard, copySourceToClipboard } from "./clipboard"
import {
  looksLikeFileReference,
  parseFileReference,
} from "./file-open-resolver"
import { pointerMenuItems } from "./menu"
import {
  computeMenuPosition,
  type MenuAnchor,
  type MenuPosition,
} from "./position"
import { normalizeSourceRef } from "./serialize"
import { TranslatePanel, type TranslatePanelState } from "./translate-panel"
import type {
  PointerSelection,
  PointerSelectionAction,
  PointerSelectionActionContext,
  SourceRef,
} from "./types"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { resolveWorkspaceReference } from "@/lib/api"
import { openUrl } from "@/lib/platform"

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

type PointerMenuState = {
  anchor: MenuAnchor
  selection: PointerSelection
  translate: TranslatePanelState | null
  forcePlacement?: "above" | "below"
  minTop?: number
}

interface PointerContextValue {
  reportSelection: (selection: PointerSelection | null) => void
  copySource: (ref: SourceRef) => Promise<boolean>
  /** 在父页面弹出菜单（给没有 DOM 右键的原生 WebView 用）。 */
  showMenu: (
    selection: PointerSelection,
    position: { x: number; y: number },
    options?: { forcePlacement?: "above" | "below"; minTop?: number }
  ) => void
  /** 注册通用选区动作（如 PDF 高亮）；返回注销函数。 */
  registerSelectionAction: (action: PointerSelectionAction) => () => void
  /** 原生 WebView 菜单打开时需要锁住子视图命中。 */
  isMenuOpen: boolean
}

const PointerContext = createContext<PointerContextValue | null>(null)

function isInsideComposer(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".berth-composer"))
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA"
}

/**
 * 动作面板体：把业务面板组件作为 prop 传入并以 JSX 渲染。
 * 不直接调 `activeAction.panel(...)`，避免 React Compiler 对渲染期
 * 方法调用的 refs 误判。
 */
function PanelBody({
  PanelComponent,
  selection,
  actionId,
  setActionPanel,
  closeMenu,
}: {
  PanelComponent: ComponentType<PointerSelectionActionContext>
  selection: PointerSelection
  actionId: string
  setActionPanel: (id: string | null) => void
  closeMenu: () => void
}) {
  return (
    <PanelComponent
      selection={selection}
      openPanel={() => setActionPanel(actionId)}
      closeMenu={closeMenu}
      backToMenu={() => setActionPanel(null)}
    />
  )
}

export function PointerProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("Pointer")
  const tProvider = useTranslations("TranslateSettings.providers")
  const { openSettings } = useSettingsWorkspace()
  const { openFilePreview } = useWorkspaceRuntimeActions()

  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const activeFolder = useMemo(
    () => allFolders.find((f) => f.id === activeFolderId) ?? null,
    [allFolders, activeFolderId]
  )

  const reportedRef = useRef<PointerSelection | null>(null)
  const translateGenRef = useRef(0)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<PointerMenuState | null>(null)
  const [pos, setPos] = useState<MenuPosition | null>(null)
  const [actions, setActions] = useState<PointerSelectionAction[]>([])
  const [actionPanel, setActionPanel] = useState<string | null>(null)
  const actionPanelRef = useRef<string | null>(null)
  useEffect(() => {
    actionPanelRef.current = actionPanel
  }, [actionPanel])

  // 胶囊菜单打开目标：URL 同步判定；文件/目录引用交给后端按磁盘实况
  // 解析（无内存索引，天然覆盖 gitignored 与新建文件）。异步到达，晚于
  // 菜单渲染一瞬属预期——按钮在结果返回时出现。
  const syncOpenTarget = useMemo(() => {
    if (!menu) return null
    const url = normalizeWebReaderUrl(menu.selection.excerpt)
    return url ? { kind: "url" as const, url } : null
  }, [menu])

  const excerpt = menu?.selection.excerpt ?? null
  const [resolvedOpenTarget, setResolvedOpenTarget] = useState<
    | {
        kind: "file" | "dir"
        absPath: string
        relPath: string
        line: number | undefined
      }
    | { kind: "file-search"; query: string }
    | null
  >(null)
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (excerpt == null || !looksLikeFileReference(excerpt)) {
      setResolvedOpenTarget(null)
      return
    }
    const parsed = parseFileReference(excerpt)
    if (!parsed) {
      setResolvedOpenTarget(null)
      return
    }

    // 相对路径没有工作区根就无法拼出绝对路径，交由文件树搜索兜底。
    if (!parsed.isAbsolute && !activeFolder?.path) {
      setResolvedOpenTarget(null)
      return
    }

    let canceled = false
    ;(async () => {
      try {
        const matches = await resolveWorkspaceReference(
          parsed.isAbsolute ? "" : (activeFolder?.path ?? ""),
          parsed.path
        )
        if (canceled) return

        if (matches.length === 1) {
          const [match] = matches
          setResolvedOpenTarget({
            kind: match.kind === "dir" ? "dir" : "file",
            absPath: match.abs_path,
            relPath: match.rel_path,
            line: parsed.line,
          })
        } else if (matches.length > 1) {
          // 歧义不猜：交给文件树搜索框展示全部候选。
          setResolvedOpenTarget({ kind: "file-search", query: parsed.path })
        } else {
          setResolvedOpenTarget(null)
        }
      } catch {
        if (!canceled) setResolvedOpenTarget(null)
      }
    })()

    return () => {
      canceled = true
    }
  }, [excerpt, activeFolder?.path])
  /* eslint-enable react-hooks/set-state-in-effect */

  const reportSelection = useCallback((selection: PointerSelection | null) => {
    reportedRef.current = selection
  }, [])

  const registerSelectionAction = useCallback(
    (action: PointerSelectionAction) => {
      setActions((prev) =>
        prev.some((a) => a.id === action.id) ? prev : [...prev, action]
      )
      let removed = false
      return () => {
        if (removed) return
        removed = true
        setActions((prev) => prev.filter((a) => a.id !== action.id))
      }
    },
    []
  )

  const copySource = useCallback(
    async (ref: SourceRef) => {
      const normalized = normalizeSourceRef(ref)
      if (!normalized) return false
      const ok = await copySourceToClipboard(normalized)
      if (!ok) toast.error(t("copyFailed"))
      return ok
    },
    [t]
  )

  const showMenu = useCallback(
    (
      selection: PointerSelection,
      position: { x: number; y: number },
      options?: { forcePlacement?: "above" | "below"; minTop?: number }
    ) => {
      if (!shouldInterceptContextMenu(selection)) return
      setMenu({
        anchor: {
          left: position.x,
          top: position.y,
          right: position.x,
          bottom: position.y,
        },
        selection,
        translate: null,
        forcePlacement: options?.forcePlacement,
        minTop: options?.minTop,
      })
    },
    []
  )

  const closeMenu = useCallback(() => {
    translateGenRef.current += 1
    setActionPanel(null)
    setMenu(null)
    setPos(null)
    // 菜单关闭即清空解析目标，避免下次选区短暂复用旧结果。
    setResolvedOpenTarget(null)
  }, [])

  const isPointerDownRef = useRef(false)

  const syncMenuWithSelection = useCallback(
    (target?: EventTarget | null) => {
      if (typeof window === "undefined") return
      if (
        (menuRef.current &&
          document.activeElement &&
          menuRef.current.contains(document.activeElement)) ||
        isEditableTarget(document.activeElement) ||
        actionPanelRef.current
      ) {
        return
      }
      const domSelection = window.getSelection()
      if (
        !domSelection ||
        domSelection.isCollapsed ||
        domSelection.rangeCount === 0
      ) {
        if (menu) {
          if (reportedRef.current?.excerpt.trim()) return
          closeMenu()
        }
        return
      }

      const text = domSelection.toString().trim()
      if (!text) {
        if (menu) {
          if (reportedRef.current?.excerpt.trim()) return
          closeMenu()
        }
        return
      }

      if (isPointerDownRef.current) return

      try {
        const range = domSelection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return

        const checkTarget =
          target instanceof Element
            ? target
            : range.commonAncestorContainer instanceof Element
              ? range.commonAncestorContainer
              : range.commonAncestorContainer.parentElement

        if (isInsideComposer(checkTarget) || isEditableTarget(checkTarget)) {
          return
        }

        const resolved = resolveContextMenuSelection({
          liveExcerpt: text,
          liveTouchesTarget: true,
          reported: reportedRef.current,
          onOwnedSurface: isPointerOwnedTarget(checkTarget),
        }) || {
          excerpt: text,
          editable: false,
          source: null,
        }

        setMenu({
          anchor: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          },
          selection: resolved,
          translate: null,
        })
      } catch {
        // ignore getBoundingClientRect errors
      }
    },
    [closeMenu, menu]
  )

  useEffect(() => {
    const onPointerDown = (event: MouseEvent | PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) {
        return
      }
      isPointerDownRef.current = true
      if (menu) {
        closeMenu()
      }
    }

    const onPointerUp = (event: MouseEvent | PointerEvent) => {
      isPointerDownRef.current = false
      if (menuRef.current && menuRef.current.contains(event.target as Node)) {
        return
      }
      if (event.button !== 0 || event.ctrlKey) {
        return
      }
      setTimeout(() => {
        syncMenuWithSelection(event.target)
      }, 10)
    }

    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      if (isInsideComposer(event.target)) return

      const selection = resolveContextMenuSelection({
        liveExcerpt: readDomExcerpt(),
        liveTouchesTarget: selectionTouchesTarget(event.target),
        reported: reportedRef.current,
        onOwnedSurface: isPointerOwnedTarget(event.target),
      })
      if (!shouldInterceptContextMenu(selection)) return
      if (!selection) return
      if (selection && isEditableTarget(event.target)) {
        selection.editable = true
      }

      event.preventDefault()
      event.stopPropagation()
      setMenu({
        anchor: {
          left: event.clientX,
          top: event.clientY,
          right: event.clientX,
          bottom: event.clientY,
        },
        selection,
        translate: null,
      })
    }

    const onSelectionChange = () => {
      if (
        (menuRef.current &&
          document.activeElement &&
          menuRef.current.contains(document.activeElement)) ||
        isEditableTarget(document.activeElement) ||
        actionPanelRef.current
      ) {
        return
      }
      const excerpt = readDomExcerpt().trim()
      if (!excerpt) {
        if (isPointerOwnedTarget(document.activeElement)) return
        if (reportedRef.current?.excerpt.trim()) return
        reportedRef.current = null
        if (menu) {
          closeMenu()
        }
        return
      }
      if (!isPointerDownRef.current) {
        syncMenuWithSelection()
      }
    }

    const onScroll = () => {
      if (menu) {
        closeMenu()
      }
    }

    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("pointerup", onPointerUp)
    document.addEventListener("mouseup", onPointerUp)
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("contextmenu", onContextMenu, true)
    document.addEventListener("selectionchange", onSelectionChange)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("mouseup", onPointerUp)
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("contextmenu", onContextMenu, true)
      document.removeEventListener("selectionchange", onSelectionChange)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [closeMenu, menu, syncMenuWithSelection])

  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [menu, closeMenu])

  const handleCopyContent = useCallback(() => {
    if (!menu) return
    const text = menu.selection.excerpt
    void copyPlainToClipboard(text).then((ok) => {
      if (!ok) toast.error(t("copyFailed"))
    })
    closeMenu()
  }, [menu, closeMenu, t])

  const handleCopySource = useCallback(() => {
    if (!menu?.selection.source) return
    void copySource({
      ...menu.selection.source,
      excerpt: menu.selection.source.excerpt || menu.selection.excerpt,
    })
    closeMenu()
  }, [menu, copySource, closeMenu])

  const handleTranslate = useCallback(() => {
    if (!menu) return
    const text = menu.selection.excerpt
    const gen = translateGenRef.current + 1
    translateGenRef.current = gen
    setMenu((prev) =>
      prev ? { ...prev, translate: { status: "loading" } } : prev
    )
    void translateText({ text })
      .then((result) => {
        if (translateGenRef.current !== gen) return
        setMenu((prev) =>
          prev
            ? {
                ...prev,
                translate: {
                  status: "done",
                  result: result.text,
                  provider: result.provider,
                },
              }
            : prev
        )
      })
      .catch((error) => {
        if (translateGenRef.current !== gen) return
        const message = toErrorMessage(error) || t("translateFailed")
        setMenu((prev) =>
          prev ? { ...prev, translate: { status: "error", message } } : prev
        )
      })
  }, [menu, t])

  const handleCopyTranslation = useCallback(() => {
    if (menu?.translate?.status !== "done") return
    const text = menu.translate.result
    void copyPlainToClipboard(text).then((ok) => {
      if (!ok) toast.error(t("copyFailed"))
    })
    closeMenu()
  }, [menu, t, closeMenu])

  const handleOpenTranslateSettings = useCallback(() => {
    closeMenu()
    openSettings("advanced")
  }, [closeMenu, openSettings])

  const translateProviderLabel = (() => {
    if (menu?.translate?.status !== "done" || !menu.translate.provider) {
      return null
    }
    const id = menu.translate.provider
    return isTranslateProviderId(id) ? tProvider(id) : id
  })()

  const value = useMemo(
    () => ({
      reportSelection,
      copySource,
      showMenu,
      registerSelectionAction,
      isMenuOpen: Boolean(menu),
    }),
    [copySource, menu, registerSelectionAction, reportSelection, showMenu]
  )

  const items = menu ? pointerMenuItems(menu.selection) : null

  const matchedActions = useMemo(() => {
    if (!menu) return []
    return actions.filter((action) => action.matches(menu.selection))
  }, [actions, menu])

  const activeAction = useMemo(() => {
    if (!menu || !actionPanel) return null
    return (
      actions.find(
        (action) => action.id === actionPanel && action.matches(menu.selection)
      ) ?? null
    )
  }, [actions, actionPanel, menu])

  // 打开按钮渲染条件：同步 URL 目标，或后端已解析出的唯一/歧义目标。
  const openTarget = syncOpenTarget ?? resolvedOpenTarget ?? null

  // 同步测量与定位计算：保证在浏览器绘制前精确按 DOM 尺寸定位，碰到边界时向内平移避免变形
  useIsomorphicLayoutEffect(() => {
    if (!menu || typeof window === "undefined") {
      setPos(null)
      return
    }

    const reposition = () => {
      const el = menuRef.current
      const width =
        el?.offsetWidth || (menu.translate ? 340 : activeAction ? 280 : 360)
      const height =
        el?.offsetHeight || (menu.translate ? 200 : activeAction ? 60 : 36)

      const calculated = computeMenuPosition(
        menu.anchor,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        {
          forcePlacement: menu.forcePlacement,
          minTop: menu.minTop,
        }
      )
      setPos(calculated)
    }

    reposition()
    window.addEventListener("resize", reposition)
    return () => {
      window.removeEventListener("resize", reposition)
    }
  }, [
    menu?.anchor.left,
    menu?.anchor.top,
    menu?.anchor.right,
    menu?.anchor.bottom,
    menu?.forcePlacement,
    menu?.minTop,
    menu?.translate,
    actionPanel,
    items?.copySource,
    items?.translate,
    openTarget,
    activeAction,
  ])

  const effectivePos = useMemo(() => {
    if (!menu || typeof window === "undefined") return null
    if (pos) return pos
    const estimatedWidth = menu.translate ? 340 : activeAction ? 280 : 360
    const estimatedHeight = menu.translate ? 200 : activeAction ? 60 : 36
    return computeMenuPosition(
      menu.anchor,
      { width: estimatedWidth, height: estimatedHeight },
      { width: window.innerWidth, height: window.innerHeight },
      {
        forcePlacement: menu.forcePlacement,
        minTop: menu.minTop,
      }
    )
  }, [menu, pos, activeAction])

  const handleOpenTargetClick = useCallback(() => {
    if (!openTarget) return
    closeMenu()
    if (openTarget.kind === "url") {
      void openUrl(openTarget.url).catch((error) => {
        toast.error(t("openFailed"), { description: toErrorMessage(error) })
      })
      return
    }
    if (openTarget.kind === "file-search") {
      useAppUiStore.getState().focusProjectFileSearch(openTarget.query)
      return
    }
    if (openTarget.kind === "dir") {
      // 文件树用工作区相对路径展开定位（树外路径 relPath 即 absPath，
      // 展不开但不报错）。
      useAppUiStore.getState().revealInFileTree(openTarget.relPath)
      return
    }
    void openFilePreview(openTarget.absPath, { line: openTarget.line }).catch(
      (error) => {
        toast.error(t("openFailed"), { description: toErrorMessage(error) })
      }
    )
  }, [closeMenu, openFilePreview, openTarget, t])

  const isPanelOpen = Boolean(
    menu?.translate || (activeAction && activeAction.panel)
  )

  const renderToolbarPills = () => (
    <>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={handleCopyContent}
        title={t("copyContent")}
      >
        <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 whitespace-nowrap">{t("copyContent")}</span>
      </button>

      {items?.copySource ? (
        <>
          <span className="h-3 w-px shrink-0 bg-border/60 mx-0.5" aria-hidden />
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={handleCopySource}
            title={t("copyContentAndSource")}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="shrink-0 whitespace-nowrap">
              {t("copyContentAndSource")}
            </span>
          </button>
        </>
      ) : null}

      {items?.translate ? (
        <>
          <span className="h-3 w-px shrink-0 bg-border/60 mx-0.5" aria-hidden />
          <button
            type="button"
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring",
              menu?.translate
                ? "bg-primary/15 text-primary font-semibold"
                : "text-popover-foreground hover:bg-accent hover:text-accent-foreground"
            )}
            onClick={() => {
              if (menu?.translate) {
                translateGenRef.current += 1
                setMenu((prev) => (prev ? { ...prev, translate: null } : prev))
              } else {
                setActionPanel(null)
                handleTranslate()
              }
            }}
            title={t("translate")}
          >
            <Languages className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="shrink-0 whitespace-nowrap">{t("translate")}</span>
          </button>
        </>
      ) : null}

      {openTarget ? (
        <>
          <span className="h-3 w-px shrink-0 bg-border/60 mx-0.5" aria-hidden />
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={handleOpenTargetClick}
            title={openTarget.kind === "url" ? t("openLink") : t("openFile")}
          >
            {openTarget.kind === "url" ? (
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : openTarget.kind === "dir" ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            )}
            <span className="shrink-0 whitespace-nowrap">
              {openTarget.kind === "url" ? t("openLink") : t("openFile")}
            </span>
          </button>
        </>
      ) : null}

      {matchedActions.map((action) => {
        const isActive = actionPanel === action.id
        return (
          <Fragment key={action.id}>
            <span
              className="h-3 w-px shrink-0 bg-border/60 mx-0.5"
              aria-hidden
            />
            <button
              type="button"
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold"
                  : "text-popover-foreground hover:bg-accent hover:text-accent-foreground"
              )}
              onClick={() => {
                if (action.panel) {
                  if (isActive) {
                    setActionPanel(null)
                  } else {
                    translateGenRef.current += 1
                    setMenu((prev) =>
                      prev ? { ...prev, translate: null } : prev
                    )
                    setActionPanel(action.id)
                  }
                } else {
                  action.onActivate?.({
                    selection: menu!.selection,
                    openPanel: () => setActionPanel(action.id),
                    closeMenu,
                    backToMenu: () => setActionPanel(null),
                  })
                }
              }}
              title={action.label}
            >
              {action.icon}
              <span className="shrink-0 whitespace-nowrap">{action.label}</span>
            </button>
          </Fragment>
        )
      })}
    </>
  )

  return (
    <PointerContext.Provider value={value}>
      {children}
      {menu ? (
        <div
          ref={menuRef}
          className="fixed z-[85] flex flex-col items-center gap-0 max-w-[calc(100vw-24px)] select-none animate-in fade-in-0 zoom-in-95 duration-100"
          style={{
            left: effectivePos?.left ?? 0,
            top: effectivePos?.top ?? 0,
          }}
          onMouseDown={(e) => {
            if (
              (e.target as HTMLElement)?.closest(
                ".select-text, input, textarea, [contenteditable='true']"
              )
            ) {
              return
            }
            e.preventDefault()
          }}
        >
          {/* 上方：始终保持完整的独立胶囊菜单栏（rounded-full） */}
          <div
            role="toolbar"
            aria-label="Selection Actions"
            className="flex flex-nowrap shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-border/80 bg-popover/95 backdrop-blur-xl px-1.5 py-1 text-popover-foreground shadow-xl ring-1 ring-black/5 dark:ring-white/10 select-none max-w-full overflow-x-auto z-10"
          >
            {renderToolbarPills()}
          </div>

          {/* 下方：中垂线对齐、无缝紧随胶囊下方的方形内容面板（rounded-xl） */}
          {isPanelOpen ? (
            <div
              role="region"
              aria-label="Selection Actions and Details"
              className="flex flex-col shrink-0 rounded-xl border border-border/80 bg-popover/95 backdrop-blur-xl text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 select-none max-w-full overflow-hidden -mt-px"
            >
              {menu.translate ? (
                <TranslatePanel
                  state={menu.translate}
                  providerLabel={translateProviderLabel}
                  onCopy={handleCopyTranslation}
                  onOpenSettings={handleOpenTranslateSettings}
                />
              ) : activeAction && activeAction.panel ? (
                <PanelBody
                  PanelComponent={activeAction.panel}
                  selection={menu.selection}
                  actionId={activeAction.id}
                  setActionPanel={setActionPanel}
                  closeMenu={closeMenu}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </PointerContext.Provider>
  )
}

export function usePointer(): PointerContextValue {
  const value = useContext(PointerContext)
  if (!value) {
    throw new Error("usePointer must be used inside PointerProvider")
  }
  return value
}

export function useOptionalPointer(): PointerContextValue | null {
  return useContext(PointerContext)
}
