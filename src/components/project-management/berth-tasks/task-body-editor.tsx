"use client"

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useMarkdownLivePreview } from "@/components/files/use-markdown-live-preview"
import { viewerFallback } from "@/components/files/viewers/viewer-states"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useEditorFont, useZoomLevel } from "@/hooks/use-appearance"
import { saveTask } from "@/lib/agent/berth-tasks"
import { findOwningFolder, splitAbsPath } from "@/lib/files/file-open-target"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

// 与文件编辑器同一 CodeMirror，打开任务页才加载。
const LazyCodeEditor = lazy(() =>
  import("@/components/editor/code-editor").then((m) => ({
    default: m.CodeEditor,
  }))
)

const SAVE_DELAY_MS = 1500

/**
 * 任务正文（frontmatter 之外）的编辑器：步骤与状态在 frontmatter，由步骤栏和命令写，这里不碰。
 * 保存带上加载时的正文，磁盘上已被 Agent 改过就拒绝，提示重新加载，不覆盖它写的记录。
 */
export function TaskBodyEditor({
  folderId,
  task,
  path,
  body,
}: {
  folderId: number
  task: string
  /** 任务文件绝对路径（链接、图片的解析基准）。 */
  path: string
  /** 磁盘上的正文（轮询刷新）。 */
  body: string
}) {
  const t = useTranslations("BerthTasks.group")
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const owningFolder = useMemo(
    () => findOwningFolder(path, allFolders),
    [path, allFolders]
  )
  const docDir = useMemo(() => splitAbsPath(path)?.rootPath ?? null, [path])
  const livePreview = useMarkdownLivePreview({
    enabled: true,
    path,
    docDir,
    previewRoot: owningFolder?.rootPath ?? docDir,
    owningFolder,
    revision: body,
    openFilePreview,
  })
  const { zoomLevel } = useZoomLevel()
  const { editorFontStack, editorFontSize, editorLigatures } = useEditorFont()

  const [value, setValue] = useState(body)
  const [error, setError] = useState<string | null>(null)
  // base：最近一次与磁盘一致的正文；value 与它不同即有未保存修改。
  const latest = useRef({ base: body, value: body, saving: false })

  // 磁盘正文变了（Agent 写了记录）且本地没改：跟上。
  useEffect(() => {
    const current = latest.current
    if (current.value === current.base && body !== current.base) {
      current.base = body
      current.value = body
      setValue(body)
    }
  }, [body])

  const save = useCallback(async () => {
    const current = latest.current
    if (current.saving || current.value === current.base) return
    current.saving = true
    const next = current.value
    try {
      const response = await saveTask(folderId, task, {
        body: next,
        baseBody: current.base,
      })
      if (response.ok) {
        current.base = next
        setError(null)
      } else setError(response.error.message)
    } catch (cause) {
      setError(String(cause))
    } finally {
      current.saving = false
    }
  }, [folderId, task])

  useEffect(() => {
    if (value === latest.current.base || error) return
    const timer = setTimeout(() => void save(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [value, error, save])

  // 离开任务页时把没保存的改动写掉。
  useEffect(() => () => void save(), [save])

  const reload = () => {
    latest.current.base = body
    latest.current.value = body
    setValue(body)
    setError(null)
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate" title={error}>
            {t("saveFailed", { message: error })}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={reload}
          >
            {t("reload")}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={viewerFallback}>
          <LazyCodeEditor
            documentId={`task:${folderId}:${task}`}
            value={value}
            appearance={{
              fontFamily: editorFontStack,
              fontSize: (editorFontSize * zoomLevel) / 100,
              fontLigatures: editorLigatures,
              wordWrap: true,
            }}
            capabilities={{ readOnly: false, search: true, lineNumbers: false }}
            languageExtension={livePreview.extension ?? []}
            onChange={(next) => {
              latest.current.value = next
              setValue(next)
            }}
            className="h-full min-h-0 overflow-hidden"
          />
        </Suspense>
        {livePreview.overlays}
      </div>
    </div>
  )
}
