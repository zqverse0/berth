"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Extension } from "@codemirror/state"
import {
  isUncPath,
  isVirtualPreviewPath,
  joinRootRel,
  splitAbsPath,
} from "@/lib/files/file-open-target"
import { fileViewerKindFromPath } from "@/lib/files/file-viewer-definition"
import { readFileForEdit } from "@/lib/api"
import { loadLocalImageDataUrl } from "@/lib/files/local-image"
import { openUrl } from "@/lib/platform"
import { useOpenLinkOrFile } from "@/components/ai-elements/link-safety"
import {
  inlineCodePathUrl,
  projectPathHref,
} from "@/components/ai-elements/remark-inline-code-paths"
import { getKnowledgeSnapshot } from "@/knowledge/api/knowledge-client"
import { buildLinkTable, isVaultNotePath } from "@/knowledge/lib/vault"
import type { KnowledgeSnapshot } from "@/knowledge/model/types"
import {
  VaultPropertyBar,
  VaultRelations,
} from "@/knowledge/preview/vault-note"

function safeDecodeUri(value: string) {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

const isRemote = (url: string) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)

interface MarkdownLivePreviewInput {
  enabled: boolean
  /** 文档绝对路径 */
  path: string | null
  /** 文档所在目录（相对引用的基准） */
  docDir: string | null
  /** "/x" 引用的基准：所属文件夹根，文件夹外的文件取文档目录 */
  previewRoot: string | null
  owningFolder: { folderId: number; rootPath: string; relPath: string } | null
  /** 文件 etag：保存 / 重载后刷新知识库快照 */
  revision: string | null
  openFilePreview: (path: string) => unknown
}

/**
 * 文件编辑器的 markdown live preview：按需加载扩展，处理本地链接 / 图片、知识库双链，
 * 并把知识库笔记的属性栏与关系区 portal 进文档首尾。扩展只建一次，回调经 ref 读最新上下文。
 */
export function useMarkdownLivePreview({
  enabled,
  path,
  docDir,
  previewRoot,
  owningFolder,
  revision,
  openFilePreview,
}: MarkdownLivePreviewInput): {
  extension: Extension | null
  overlays: ReactNode
} {
  const vault = useMemo(
    () =>
      owningFolder && isVaultNotePath(owningFolder.relPath)
        ? owningFolder
        : null,
    [owningFolder]
  )

  // 知识库快照：打开 / 保存（revision 变）时拉一次，供双链、属性栏与关系区共用
  const snapshotRequest = useMemo(
    () =>
      enabled && vault
        ? getKnowledgeSnapshot(vault.folderId).catch(() => null)
        : null,
    // revision 只作重新拉取的信号
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, vault, revision]
  )
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    void snapshotRequest?.then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [snapshotRequest])
  const linkTable = useMemo(
    () =>
      snapshotRequest?.then((next) =>
        next ? buildLinkTable(next.documents) : null
      ) ?? null,
    [snapshotRequest]
  )

  // 行内代码路径与会话里同一口径：相对项目解析，只写文件名时在项目里找
  const openLinkOrFile = useOpenLinkOrFile()
  const latest = {
    openLinkOrFile,
    path,
    docDir,
    previewRoot,
    openFilePreview,
    vault,
    linkTable,
    projectRoot: owningFolder?.rootPath ?? null,
  }
  const context = useRef(latest)
  useEffect(() => {
    context.current = latest
  })

  // 属性栏 / 关系区的稳定宿主元素，由扩展挂在文档首尾
  const [slots] = useState(() =>
    typeof document === "undefined"
      ? undefined
      : {
          top: document.createElement("div"),
          bottom: document.createElement("div"),
        }
  )

  const [extension, setExtension] = useState<Extension | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // 本地引用解析口径：相对文档目录，"/x" 相对预览根
    const resolveLocal = (url: string): string | null => {
      const { path, docDir, previewRoot } = context.current
      const target = url.replace(/[#?].*$/, "")
      const base = target.startsWith("/") ? previewRoot : docDir
      // 虚拟只读文档没有真实目录；UNC 文档的相对路径无法安全还原
      if (!target || !base || isUncPath(base) || isVirtualPreviewPath(path))
        return null
      if (target.startsWith(`${base}/`)) return target
      return safeDecodeUri(
        new URL(
          target.startsWith("/") ? `.${target}` : target,
          `file://${base.replace(/\/+$/, "")}/`
        ).pathname
      )
    }
    // 本地画板文件渲染成 SVG（引擎按需加载）；读不到 → null
    const renderDrawing = async (absPath: string) => {
      const split = splitAbsPath(absPath)
      if (!split) return null
      try {
        const [{ content }, assets] = await Promise.all([
          readFileForEdit(split.rootPath, split.ioPath),
          import("@/lib/files/excalidraw-assets"),
        ])
        return await assets.excalidrawSvgDataUrl(
          absPath,
          content,
          context.current.projectRoot
        )
      } catch {
        return null
      }
    }
    const findNote = async (target: string) =>
      (await context.current.linkTable)?.get(
        target.split("#")[0].trim().toLowerCase()
      )
    void import("@/lib/editor/markdown-live-preview").then((m) => {
      if (cancelled) return
      setExtension(
        m.markdownLivePreview({
          onLinkClick: (url) => {
            if (isRemote(url)) {
              void openUrl(url.startsWith("//") ? `https:${url}` : url)
              return
            }
            const target = resolveLocal(url)
            if (target) context.current.openFilePreview(target)
          },
          openCodePath: (code) => {
            const url = inlineCodePathUrl(code)
            if (!url) return null
            const href = projectPathHref(url) ?? url
            return () => void context.current.openLinkOrFile(href)
          },
          resolveImage: async (src) => {
            if (/^(https?:|data:|blob:)/i.test(src)) return src
            if (isRemote(src)) return null
            const target = resolveLocal(src)
            if (!target) return null
            return fileViewerKindFromPath(target) === "excalidraw"
              ? renderDrawing(target)
              : loadLocalImageDataUrl(target)
          },
          // `![[x]]`：图片或画板；Obsidian 习惯省略画板后缀，相对文档目录找不到再相对项目根
          wikiEmbed: {
            load: async (target) => {
              const kind = fileViewerKindFromPath(target)
              const names =
                kind === "image" || kind === "excalidraw"
                  ? [target]
                  : [`${target}.excalidraw.md`, `${target}.excalidraw`]
              const root = context.current.projectRoot
              for (const name of names) {
                for (const abs of [
                  resolveLocal(name),
                  root ? joinRootRel(root, name) : null,
                ]) {
                  if (!abs) continue
                  if (kind === "image") {
                    const url = await loadLocalImageDataUrl(abs)
                    if (url) return { url }
                    continue
                  }
                  const url = await renderDrawing(abs)
                  if (url) return { url, openPath: abs }
                }
              }
              return null
            },
            open: (path) => {
              void context.current.openFilePreview(path)
            },
          },
          wikiLinks: {
            shouldResolve: () => context.current.vault !== null,
            resolve: async (target) => ({
              target,
              label: target,
              status: (await findNote(target)) ? "resolved" : "missing",
            }),
            suggest: async (query) => {
              const table = await context.current.linkTable
              const q = query.trim().toLowerCase()
              return [...new Set(table?.values() ?? [])]
                .filter((note) => note.title.toLowerCase().includes(q))
                .map((note) => ({
                  target: note.title,
                  label: note.title,
                  detail: note.noteType,
                }))
            },
            onOpen: (target) => {
              void findNote(target).then((note) => {
                const { vault: current, openFilePreview: open } =
                  context.current
                if (note && current)
                  open(`${current.rootPath.replace(/\/+$/, "")}/${note.path}`)
              })
            },
          },
          slots,
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [enabled, slots])

  const document_ = vault
    ? snapshot?.documents.find((d) => d.path === vault.relPath)
    : undefined
  const overlays =
    enabled && slots && vault && snapshot && document_ ? (
      <>
        {createPortal(
          <VaultPropertyBar
            folderId={vault.folderId}
            document={document_}
            folderPath={vault.rootPath}
            openFilePreview={openFilePreview}
          />,
          slots.top
        )}
        {createPortal(
          <VaultRelations
            snapshot={snapshot}
            document={document_}
            folderPath={vault.rootPath}
            openFilePreview={openFilePreview}
          />,
          slots.bottom
        )}
      </>
    ) : null

  return { extension: enabled ? extension : null, overlays }
}
