"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { Code } from "lucide-react"
import { readWorkspaceFileBase64 } from "@/lib/api"
import {
  annotateSourceLines,
  inlineHtmlResources,
  SOURCE_LINE_ATTR,
  withSandboxCsp,
} from "@/lib/files/html-preview-inline"
import type { FileViewerToolbarState } from "@/lib/files/file-viewer-definition"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { SandboxedHtmlDocument } from "@/components/files/sandboxed-html-document"
import { useFileViewerController } from "@/components/files/file-viewer-runtime"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useOptionalPointer, type PointerSelectionAction } from "@/pointer"

// Element picking over source-line anchors; off until the header toggles it.
const PICK_HOST_SCRIPT = `window.__BERTH_ELEMENT_PICK__=${JSON.stringify({
  attr: SOURCE_LINE_ATTR,
  lines: true,
  toggle: true,
})};`

export function HtmlPreview({
  tab,
  rootPath,
  revealLine = null,
}: {
  tab: TextFileWorkspaceTab
  // Sub-resource resolution root: the owning workspace folder when the
  // file sits inside one (so ../-style and root-relative references keep
  // working), else the file's own directory — a natural sandbox for
  // outside-workspace files. The tab path itself is absolute.
  rootPath: string | null
  /** Editor cursor line of this file; revealed once when the preview opens. */
  revealLine?: number | null
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const [inlined, setInlined] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trusted, setTrusted] = useState(true)
  const [picking, setPicking] = useState(false)
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null)

  const content = tab.content
  const path = tab.path

  const toggleTrusted = useCallback(() => setTrusted((v) => !v), [])
  const togglePicking = useCallback(() => setPicking((v) => !v), [])
  const toolbarController = useMemo<FileViewerToolbarState>(
    () => ({
      kind: "html",
      scriptsTrust: { active: trusted, toggle: toggleTrusted },
      elementGrab: { active: picking, toggle: togglePicking },
    }),
    [picking, togglePicking, trusted, toggleTrusted]
  )
  useFileViewerController(toolbarController)

  // Reveal only on the first load: later reloads (file edits) keep the view.
  const pendingRevealRef = useRef(revealLine)

  // Each srcdoc (re)load starts with picking off; resend the current state.
  // Opaque-origin frame, hence "*"; the bridge only trusts its parent.
  // Layout effect: the listener must be attached before the srcdoc "load"
  // task can run, or the one-shot reveal is lost.
  useLayoutEffect(() => {
    if (!frame) return
    const post = (message: { pick?: boolean; revealLine?: number }) =>
      frame.contentWindow?.postMessage(
        { type: "berth:preview-view", ...message },
        "*"
      )
    const onLoad = () => {
      post({ pick: picking })
      const line = pendingRevealRef.current
      if (line != null) {
        pendingRevealRef.current = null
        post({ revealLine: line })
      }
    }
    post({ pick: picking })
    frame.addEventListener("load", onLoad)
    return () => frame.removeEventListener("load", onLoad)
  }, [frame, picking])

  const pointer = useOptionalPointer()
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const showInSourceAction = useMemo<PointerSelectionAction>(
    () => ({
      id: "html-show-in-source",
      label: t("htmlShowInSource"),
      icon: <Code className="h-3.5 w-3.5 shrink-0" />,
      matches: ({ editable, source }) =>
        !editable &&
        source?.identity.type === "file" &&
        source.identity.path === path &&
        source.span?.unit === "lines",
      onActivate: ({ selection, closeMenu }) => {
        const span = selection.source?.span
        if (span?.unit !== "lines") return
        closeMenu()
        void openFilePreview(path, { line: span.start })
      },
    }),
    [openFilePreview, path, t]
  )
  useEffect(
    () => pointer?.registerSelectionAction(showInSourceAction),
    [pointer, showInSourceAction]
  )

  useEffect(() => {
    let cancelled = false
    const root = rootPath ?? ""
    // The tab path IS the absolute file location; its directory anchors
    // relative references, while `root` anchors root-relative ones and
    // confines every read.
    const absFilePath = path || null
    const fileDir = absFilePath ? absFilePath.replace(/\/[^/]*$/, "") : root
    inlineHtmlResources(annotateSourceLines(content), {
      fileDir,
      folderPath: root,
      // The inliner hands us absolute, lexically in-root paths; convert to a
      // root-relative path and read through the symlink-safe, confined
      // backend command (defense-in-depth over the lexical check).
      readFileBase64: (absPath) => {
        const r = root.replace(/\\/g, "/").replace(/\/+$/, "")
        const a = absPath.replace(/\\/g, "/")
        const rel =
          a === r ? "" : a.startsWith(r + "/") ? a.slice(r.length + 1) : a
        return readWorkspaceFileBase64(root, rel)
      },
    })
      .then((html) => {
        if (!cancelled) {
          setInlined(html)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setInlined(null)
          setError(String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [content, path, rootPath])

  const srcDoc = useMemo(
    () =>
      inlined != null
        ? withSandboxCsp(inlined, {
            trusted,
            documentContextBridge: true,
            extraScript: PICK_HOST_SCRIPT,
          })
        : "",
    [inlined, trusted]
  )
  const loading = inlined == null && error == null

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
        {error ? (
          <div className="h-full flex items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {error}
          </div>
        ) : (
          inlined != null && (
            <SandboxedHtmlDocument
              srcDoc={srcDoc}
              title={t("htmlPreviewTitle")}
              trusted={trusted}
              onFrame={setFrame}
            />
          )
        )}
      </div>
    </div>
  )
}
