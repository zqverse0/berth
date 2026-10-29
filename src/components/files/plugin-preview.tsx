"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FileWarning, Loader2 } from "lucide-react"

import {
  installPreviewTool,
  refreshPreviewWatchHtml,
  startPreviewWatch,
  stopPreviewWatch,
  type PreviewMark,
} from "@/lib/api"
import type { PreviewInstallEvent } from "@/lib/types"
import { getTransport, isDesktop } from "@/lib/transport"
import { openPath } from "@/lib/platform"
import { withSandboxCsp } from "@/lib/files/html-preview-inline"
import { toast } from "@/lib/notify"
import { extractAppCommandError } from "@/lib/app-error"
import { useWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import { SandboxedHtmlDocument } from "@/components/files/sandboxed-html-document"
import type { FileViewerToolbarState } from "@/lib/files/file-viewer-definition"
import { useFileViewerController } from "@/components/files/file-viewer-runtime"

// Machine codes the backend stamps into `i18n_params.watchCode` (mirrors
// `WatchError::code()` in preview_watch/mod.rs): the providing plugin's program
// is missing, or no enabled plugin previews this file type.
const NOT_INSTALLED = "NOT_INSTALLED"
const NO_PROVIDER = "NO_PROVIDER"

function watchCodeOf(err: unknown): string | null {
  return extractAppCommandError(err)?.i18n_params?.watchCode ?? null
}

/** NOT_INSTALLED 时后端带上提供预览的插件名。 */
function watchToolOf(err: unknown): string | null {
  return extractAppCommandError(err)?.i18n_params?.tool ?? null
}

// Keep the watch alive briefly after unmount: switching tabs remounts this
// component, and a respawned preview server takes seconds to come up.
const STOP_GRACE_MS = 60_000

// Last snapshot per file so a remount paints instantly while the watch
// restarts/refetches in the background. ponytail: tiny LRU by insertion order.
const SNAPSHOT_CACHE_MAX = 8
const snapshotCache = new Map<string, { html: string; script: string }>()
function cacheSnapshot(key: string, html: string, script: string) {
  snapshotCache.delete(key)
  snapshotCache.set(key, { html, script })
  if (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    snapshotCache.delete(snapshotCache.keys().next().value!)
  }
}

function releaseWatchLater(root: string, path: string) {
  setTimeout(() => {
    void stopPreviewWatch(root, path).catch(() => {})
  }, STOP_GRACE_MS)
}

// The bridge's element picking is host behaviour; anything that adapts the
// renderer's own HTML (layout, tabs, scroll restore) is the plugin's
// `org.berth.preview.script`, returned by `start_preview_watch`.
const PICK_SCRIPT = "window.__BERTH_ELEMENT_PICK__=true;"

type PreviewWatchPush =
  | { port: number; kind?: "content" }
  | { port: number; kind: "closed" }
  | { port: number; kind: "marks"; marks?: PreviewMark[] | null }
  | { port: number; kind: "scroll"; target: string }

function markKey(mark: PreviewMark): string {
  return mark.id ?? mark.path
}

// The preview frame is an opaque-origin srcdoc, hence the "*" target; the
// bridge only accepts this message from its parent window.
function postToFrame(
  frame: HTMLIFrameElement | null,
  message: {
    marks?: PreviewMark[]
    revealPath?: string
    revealAnchor?: string
  }
) {
  frame?.contentWindow?.postMessage(
    { type: "berth:preview-view", ...message },
    "*"
  )
}

function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * Preview a file through the enabled preview plugin's local server
 * (`org.berth.preview`, protocol watch/1) for Berth's document formats.
 *
 * The watch process keeps the file-lock-safe conversion pipeline alive; Berth
 * pulls its preview HTML snapshot (server-side loopback GET) and renders it in
 * the shared sandboxed srcdoc document — the same display seam as local HTML
 * previews and web reader documents. No visible child WebView is mounted, so
 * selection capsules anchor next to the text like Markdown/PDF.
 *
 * Refresh: the workspace file-watch envelope stream bumps `refreshSeq` when
 * the underlying file changes on disk; each bump re-fetches the snapshot and
 * swaps the srcdoc without remounting the tab.
 */
export function PluginPreview({
  rootPath,
  relPath,
  absolutePath,
  title,
  visible = true,
}: {
  // Backend watch target as a (directory, relative file) pair — the file
  // tab's absolute path split by the panel. No workspace folder needed.
  rootPath: string | null
  relPath: string | null
  absolutePath?: string | null
  title?: string | null
  visible?: boolean
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const translateRef = useRef(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])
  const cacheKey = `${rootPath ?? ""}\0${relPath ?? ""}`
  const [port, setPort] = useState<number | null>(null)
  // Agent 的标注（watch/1 mark-update）：随 watch 推送更新，经 postMessage 交给预览帧绘制。
  const [marks, setMarks] = useState<PreviewMark[]>([])
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const marksRef = useRef<PreviewMark[]>([])
  const seenMarksRef = useRef(new Set<string>())
  const [html, setHtml] = useState<string | null>(
    () => snapshotCache.get(cacheKey)?.html ?? null
  )
  const [script, setScript] = useState(
    () => snapshotCache.get(cacheKey)?.script ?? ""
  )
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [errorTool, setErrorTool] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const path = relPath ?? ""

  const desktop = isDesktop()

  useEffect(() => {
    if (html != null) cacheSnapshot(cacheKey, html, script)
  }, [cacheKey, html, script])

  // 文件变更驱动刷新：共享的 per-root workspace-state store（refcounted），
  // 不新增文件 watcher。rootPath 即 watch 目标所在目录。
  const { subscribeEnvelopes } = useWorkspaceStateStore(rootPath)
  useEffect(() => {
    if (!rootPath || !path) return
    const target = normalizeComparePath(path)
    return subscribeEnvelopes(({ changed_paths }) => {
      if (!changed_paths || changed_paths.length === 0) return
      if (changed_paths.some((p) => normalizeComparePath(p) === target)) {
        setRefreshSeq((s) => s + 1)
      }
    })
  }, [subscribeEnvelopes, rootPath, path])

  const retry = useCallback(() => {
    setErrorCode(null)
    setErrorMessage(null)
    setPort(null)
    setHtml(null)
    setRetryKey((k) => k + 1)
  }, [])

  // 提供者改文档时 watch 可能先改内存、晚落盘（officecli 2–10s）；跟 watch 自己的推送
  // 刷新，不等文件事件。批量编辑合并成一次快照拉取。标注 / goto 推送转给
  // 预览帧；新出现的标注自动滚到视野内（提供者的 scroll 未必覆盖所有格式）。
  useEffect(() => {
    if (port == null) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = getTransport()
      .subscribe<PreviewWatchPush>("app://preview-watch-update", (payload) => {
        if (payload.port !== port) return
        // 预览进程退出（插件停用回收、崩溃）：重启，停用时会得到 NO_PROVIDER。
        if (payload.kind === "closed") {
          retry()
          return
        }
        if (payload.kind === "marks") {
          const next = Array.isArray(payload.marks) ? payload.marks : []
          const fresh = next.filter(
            (mark) => !seenMarksRef.current.has(markKey(mark))
          )
          seenMarksRef.current = new Set(next.map(markKey))
          setMarks(next)
          const reveal = fresh[fresh.length - 1]
          if (reveal) postToFrame(frameRef.current, { revealPath: reveal.path })
          return
        }
        if (payload.kind === "scroll") {
          postToFrame(frameRef.current, { revealAnchor: payload.target })
          return
        }
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          setRefreshSeq((seq) => seq + 1)
        }, 150)
      })
      .catch(() => null)
    return () => {
      if (timer) clearTimeout(timer)
      void unsubscribe.then((off) => off?.())
    }
  }, [port, retry])

  // 标注变化即下发；每次 srcdoc 刷新（帧重新 load）后重发当前标注。
  useEffect(() => {
    marksRef.current = marks
    postToFrame(frame, { marks })
  }, [frame, marks])
  useEffect(() => {
    frameRef.current = frame
    if (!frame) return
    const onLoad = () => postToFrame(frame, { marks: marksRef.current })
    frame.addEventListener("load", onLoad)
    return () => frame.removeEventListener("load", onLoad)
  }, [frame])

  // Start the watch server on mount (and on retry); release it after a grace
  // period on unmount. The component is keyed by tab id upstream, so a
  // different file remounts fresh.
  // State is only set inside the async callbacks, never synchronously in the
  // effect body (the repo lints against that).
  useEffect(() => {
    let cancelled = false
    // Whether *our* start committed a ref-count. Drives exactly-one release so
    // an unmount-before-start race neither leaks a ref (we release once the
    // start resolves) nor over-releases a watch another tab still shares (we
    // never release a ref we didn't acquire).
    let acquired = false
    const root = rootPath ?? ""
    if (!desktop || !root || !path) return
    startPreviewWatch(root, path)
      .then((res) => {
        acquired = true
        if (cancelled) {
          // Unmounted before start resolved — release the ref we just took.
          releaseWatchLater(root, path)
          return
        }
        setPort(res.port)
        setScript(res.script ?? "")
        const initialMarks = Array.isArray(res.marks) ? res.marks : []
        seenMarksRef.current = new Set(initialMarks.map(markKey))
        setMarks(initialMarks)
        setErrorCode(null)
        setErrorMessage(null)
        // 首帧快照：command 已在服务端预取（GET 失败则前端再拉一次）。
        if (res.html) {
          setHtml(res.html)
        } else {
          void refreshPreviewWatchHtml(res.port)
            .then((snapshot) => {
              if (!cancelled) setHtml(snapshot)
            })
            .catch(() => {
              // 快照失败但 watch 存活：显示 loading，刷新时再试
            })
        }
      })
      .catch((err) => {
        if (cancelled) return
        setErrorCode(watchCodeOf(err) ?? "START_FAILED")
        setErrorTool(watchToolOf(err))
        setErrorMessage(extractAppCommandError(err)?.message ?? String(err))
      })
    return () => {
      cancelled = true
      if (acquired) releaseWatchLater(root, path)
    }
  }, [desktop, path, rootPath, retryKey])

  // Refresh: re-fetch the snapshot whenever the file changes (refreshSeq) or
  // the user hits retry (retryKey). Skipped until the first snapshot landed so
  // an early envelope can't race the initial start.
  // 只看「有没有首帧」：依赖 html 本身会让每次刷新成功后再拉一次。
  const hasSnapshot = html != null
  useEffect(() => {
    if (port == null || refreshSeq === 0 || !hasSnapshot) return
    let cancelled = false
    void refreshPreviewWatchHtml(port)
      .then((snapshot) => {
        if (!cancelled) setHtml(snapshot)
      })
      .catch(() => {
        // 静默失败：保留旧快照，下一次文件事件再试
      })
    return () => {
      cancelled = true
    }
  }, [port, refreshSeq, retryKey, hasSnapshot])

  // 预览服务的 HTML 是自包含快照，但可能带相对引用；CSP + opaque-origin
  // 沙箱下相对路径解析到 about:srcdoc 失效即可接受（图片等已内联为 data:）。
  const srcDoc = useMemo(
    () =>
      html != null
        ? withSandboxCsp(html, {
            documentContextBridge: true,
            extraScript: PICK_SCRIPT + script,
          })
        : "",
    [html, script]
  )

  const handleOpenExternal = useCallback(async () => {
    if (!absolutePath) return
    try {
      await openPath(absolutePath)
    } catch (caught) {
      toast.error(translateRef.current("previewOpenExternalFailed"), {
        description: caught instanceof Error ? caught.message : String(caught),
      })
    }
  }, [absolutePath])
  const toolbarController = useMemo<FileViewerToolbarState | null>(() => {
    if (!desktop) return null
    return {
      kind: "office",
      ...(rootPath && path ? { refresh: retry } : {}),
      ...(absolutePath ? { openExternal: handleOpenExternal } : {}),
    }
  }, [absolutePath, desktop, handleOpenExternal, path, retry, rootPath])
  useFileViewerController(toolbarController)

  // 标题透传给沙箱 iframe（无障碍）；正文无文件名 Header——Tab 栏已显示。
  const frameTitle = title ?? absolutePath ?? t("previewTitle")

  if (!desktop) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="h-8 w-8 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {t("previewTitle")}
        </div>
        <div className="max-w-sm text-xs text-muted-foreground">
          {t("previewDesktopOnly")}
        </div>
      </div>
    )
  }

  if (errorCode === NOT_INSTALLED) {
    return (
      <PreviewInstallPrompt
        path={path}
        tool={errorTool ?? t("previewTool")}
        onInstalled={retry}
      />
    )
  }

  if (errorCode === NO_PROVIDER) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="h-8 w-8 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {t("previewNoProvider")}
        </div>
        <div className="max-w-sm text-xs text-muted-foreground">
          {t("previewNoProviderHint")}
        </div>
      </div>
    )
  }

  if (errorCode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="h-8 w-8 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">
          {t("previewWatchFailed")}
        </div>
        {errorMessage && (
          <div className="max-w-sm break-words text-xs text-muted-foreground">
            {errorMessage}
          </div>
        )}
      </div>
    )
  }

  // 快照为空 = watch 已就绪但首帧未取到：loading（visible=false 的后台 Tab
  // 不预取首帧，切回时由 retryKey/refreshSeq 效果补拉）。
  return (
    <div className="relative h-full min-h-0">
      {html == null ? (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : (
        visible && (
          <SandboxedHtmlDocument
            srcDoc={srcDoc}
            title={frameTitle}
            trusted={false}
            onFrame={setFrame}
          />
        )
      )}
    </div>
  )
}

/**
 * One-click install of the preview plugin's program (its package `install.sh|ps1`)
 * for the missing-binary state; shows the streamed log tail.
 */
function PreviewInstallPrompt({
  path,
  tool,
  onInstalled,
}: {
  path: string
  tool: string
  onInstalled: () => void
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const install = useCallback(async () => {
    const taskId = crypto.randomUUID()
    setInstalling(true)
    setError(null)
    setLog(null)
    const unsubscribe = await getTransport()
      .subscribe<PreviewInstallEvent>("app://preview-tool-install", (event) => {
        if (event.task_id === taskId && event.payload) setLog(event.payload)
      })
      .catch(() => null)
    try {
      const info = await installPreviewTool(taskId, path)
      if (info.installed && !info.runtimeError) {
        onInstalled()
        return
      }
      setError(info.runtimeError ?? t("previewInstallFailed"))
    } catch (caught) {
      setError(extractAppCommandError(caught)?.message ?? String(caught))
    } finally {
      unsubscribe?.()
      setInstalling(false)
    }
  }, [onInstalled, path, t])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileWarning className="h-8 w-8 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground">
        {t("previewNotInstalled", { tool })}
      </div>
      <div className="max-w-sm text-xs text-muted-foreground">
        {t("previewNotInstalledHint", { tool })}
      </div>
      <button
        type="button"
        disabled={installing}
        onClick={() => void install()}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-primary/8 disabled:opacity-60"
      >
        {installing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {installing ? t("previewInstalling") : t("previewInstall", { tool })}
      </button>
      {installing && log && (
        <div className="max-w-sm truncate font-mono text-[11px] text-muted-foreground">
          {log}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="max-w-sm break-words text-xs text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  )
}
