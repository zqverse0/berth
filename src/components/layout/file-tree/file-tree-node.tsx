"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { revealItemInDir } from "@/lib/platform"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { joinFsPath } from "@/lib/files/path-utils"
import { toErrorMessage } from "@/lib/app-error"
import { cn, copyTextFromMenu } from "@/lib/utils"
import type { FileTreeNode } from "@/lib/types"
import {
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree"
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
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import { readPasteEntries } from "@/hooks/workspace/use-paste-file-tree-entry"
import { parseDeviceRef } from "@/lib/transport/device"
import type { FileTreeClipboardEntry } from "@/stores/file-tree-clipboard-store"
import { parentDir } from "@/components/layout/file-tree/path-utils"
import {
  classifyGitFileState,
  getGitFileDecoration,
  getGitFileStateClassName,
  type GitFileDecoration,
} from "@/components/layout/file-tree/git-file-state"

export async function copyPathToClipboard(
  absolutePath: string,
  failure: string
) {
  // copyTextFromMenu defers the write until this context menu has closed, so
  // the execCommand clipboard fallback works in non-secure web contexts.
  const ok = await copyTextFromMenu(absolutePath)
  if (!ok) toast.error(failure)
}
const GITIGNORE_MUTED_CLASS = "text-muted-foreground/55"

/**
 * 拖动中的放置目录（相对路径；`""` = 项目根），没有合法落点时为 null。由树统一判定后广播给各行：
 * 网页端来自容器的 dragover，桌面端来自 Tauri 的 DRAG_OVER（WebKit 不发目标侧事件）。
 */
export const DropDirContext = createContext<string | null>(null)

export interface FileActionTarget {
  kind: "file" | "dir"
  path: string
  name: string
}

export function applyCompactDragImage(event: React.DragEvent, name: string) {
  if (typeof document === "undefined") return
  const chip = document.createElement("div")
  chip.textContent = name
  chip.setAttribute("aria-hidden", "true")
  chip.className =
    "pointer-events-none max-w-[16rem] truncate rounded-md border bg-background px-2 py-0.5 font-mono text-xs text-foreground"
  chip.style.position = "fixed"
  chip.style.top = "-1000px"
  chip.style.left = "-1000px"
  document.body.appendChild(chip)
  event.dataTransfer.setDragImage(chip, 12, 12)
  // Remove once the browser has snapshotted it for the ghost.
  window.setTimeout(() => {
    chip.remove()
  }, 0)
}

/**
 * 拖动原生图标（系统拖动不走 setDragImage）：与 {@link applyCompactDragImage} 同样的小标签。
 */
export function compactDragImagePng(name: string): string {
  const style = getComputedStyle(document.body)
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) return canvas.toDataURL("image/png")
  const font = "12px ui-monospace, monospace"
  context.font = font
  const width = Math.min(context.measureText(name).width, 256)
  canvas.width = Math.ceil(width + 16)
  canvas.height = 22
  // 改尺寸会重置画布状态：字体要重设。
  context.font = font
  context.fillStyle = style.backgroundColor
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = style.color
  context.textBaseline = "middle"
  context.fillText(name, 8, canvas.height / 2, width)
  return canvas.toDataURL("image/png")
}

/** 每一行的拖动入口；放置由树的容器统一处理（按 `data-tree-drop-dir` 命中）。 */
export interface TreeDndHandlers {
  /** Begin dragging `node`: stash it as the source and write the drag payload
   *  (so the composer can read a file reference off the same drag). */
  onEntryDragStart: (event: React.DragEvent, node: FileTreeNode) => void
  /** Fires continuously while dragging the source row (the DOM `drag` event).
   *  Desktop-only use: WebKit suppresses the target-side dragover, but this
   *  source-side event still fires with the cursor in CSS px, so the drop-target
   *  directory highlight is hit-tested from here. No-op on the web. */
  onEntryDrag: (clientX: number, clientY: number) => void
  /** End the current drag (drop or cancel) — clears the source. */
  onEntryDragEnd: () => void
}

interface RenderNodeProps {
  node: FileTreeNode
  /** 连接线：每层祖先（含自己）后面还有没有兄弟；顶层为空。 */
  guides: readonly boolean[]
  expandedPaths: ReadonlySet<string>
  workspacePath: string
  dnd: TreeDndHandlers
  gitEnabled: boolean
  gitStatusByPath: ReadonlyMap<string, string>
  gitChangedDirPaths: ReadonlySet<string>
  untrackedDirPaths: ReadonlySet<string>
  directoryGitDecorations: ReadonlyMap<string, GitFileDecoration>
  gitSubmodulePaths: ReadonlySet<string>
  ancestorGitignoreIgnored: boolean
  ancestorUntracked: boolean
  onOpenFileDiff: (path: string) => void
  onOpenDirDiff: (path: string) => void
  onRequestCompareWithBranch: (target: FileActionTarget) => void
  onRequestRollback: (target: FileActionTarget) => void
  onOpenDirInTerminal: (dirPath: string, fileName: string) => Promise<void>
  onRequestAddToVcs: (target: FileActionTarget) => void
  onRequestRename: (target: FileActionTarget) => void
  onRequestCreate: (parentPath: string, kind: "file" | "dir") => void
  onRequestDelete: (target: FileActionTarget) => void
  onCopyEntry: (target: FileActionTarget) => void
  /** 粘贴进这个目录（相对路径；`""` = 项目根）。 */
  onPasteInto: (destDir: string) => void
}

export function RenderNode({
  node,
  guides,
  expandedPaths,
  workspacePath,
  dnd,
  gitEnabled,
  gitStatusByPath,
  gitChangedDirPaths,
  untrackedDirPaths,
  directoryGitDecorations,
  gitSubmodulePaths,
  ancestorGitignoreIgnored,
  ancestorUntracked,
  onOpenFileDiff,
  onOpenDirDiff,
  onRequestCompareWithBranch,
  onRequestRollback,
  onOpenDirInTerminal,
  onRequestAddToVcs,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onCopyEntry,
  onPasteInto,
}: RenderNodeProps) {
  const t = useTranslations("Folder.fileTreeTab")
  const tCommon = useTranslations("Folder.common")
  // `dragging` dims this row while it is the drag source.
  const [dragging, setDragging] = useState(false)
  const dropDir = useContext(DropDirContext)
  const isGitignoreIgnored = ancestorGitignoreIgnored || node.ignored === true
  // 对方项目的路径在本机的文件管理器里打不开。
  const isDeviceProject = parseDeviceRef(workspacePath) !== null

  const systemExplorerLabel =
    typeof navigator === "undefined"
      ? t("openInFileManager")
      : (() => {
          const platform =
            `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
          if (platform.includes("mac")) return t("openInFinder")
          if (platform.includes("win")) return t("openInExplorer")
          return t("openInFileManager")
        })()

  if (node.kind === "file") {
    const gitStatusCode =
      gitStatusByPath.get(node.path) ?? (ancestorUntracked ? "??" : undefined)
    const gitDecoration = getGitFileDecoration(gitStatusCode)
    const absolutePath = joinFsPath(workspacePath, node.path)
    const isGitMenuDisabled = !gitEnabled || isGitignoreIgnored

    const handleOpenInSystemExplorer = async () => {
      try {
        await revealItemInDir(absolutePath)
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.openDirectoryFailed"), { description: message })
      }
    }

    const isSymlink = Boolean(node.linkTarget)
    const symlinkTitle = node.linkTarget
      ? t("symlinkTooltip", { target: node.linkTarget })
      : undefined

    return (
      <ContextMenu>
        <ContextMenuTrigger>
          <FileTreeFile
            path={node.path}
            name={node.name}
            depth={0}
            guides={guides}
            symlink={isSymlink}
            title={symlinkTitle}
            className={cn(
              isGitignoreIgnored
                ? GITIGNORE_MUTED_CLASS
                : getGitFileStateClassName(gitStatusCode),
              dragging && "opacity-70"
            )}
            suffix={gitDecoration?.badge}
            suffixClassName={gitDecoration?.className}
            // 放在文件行上 = 放进它所在的目录（放回原位就是同目录，不移动）。
            data-tree-drop-dir={parentDir(node.path)}
            draggable
            onDragStart={(event) => {
              dnd.onEntryDragStart(event, node)
              // 对方文件改走系统拖动：HTML5 拖动已取消，不会有 dragend。
              setDragging(!event.defaultPrevented)
            }}
            onDrag={(event) => dnd.onEntryDrag(event.clientX, event.clientY)}
            onDragEnd={() => {
              setDragging(false)
              dnd.onEntryDragEnd()
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SendToAgentMenuItem
            absolutePath={absolutePath}
            workspacePath={node.path}
            fileName={node.name}
          />
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onCopyEntry(node)}>
            {t("copy")}
          </ContextMenuItem>
          <PasteMenuItem onPaste={() => onPasteInto(parentDir(node.path))} />
          <ContextMenuItem
            onSelect={() =>
              void copyPathToClipboard(absolutePath, t("toasts.copyPathFailed"))
            }
          >
            {t("copyPath")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onRequestRename(node)}>
            {tCommon("rename")}
          </ContextMenuItem>
          {isDeviceProject ? null : (
            <ContextMenuItem onSelect={() => void handleOpenInSystemExplorer()}>
              {systemExplorerLabel}
            </ContextMenuItem>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={isGitMenuDisabled}>
              {t("git")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => onRequestAddToVcs(node)}
                disabled={
                  isGitMenuDisabled ||
                  classifyGitFileState(gitStatusCode ?? "") !== "untracked"
                }
              >
                {t("actions.addToVcs")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onOpenFileDiff(node.path)}
                disabled={isGitMenuDisabled}
              >
                {tCommon("viewDiff")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onRequestCompareWithBranch(node)}
                disabled={isGitMenuDisabled}
              >
                {t("compareWithBranch")}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onRequestRollback(node)}
                disabled={isGitMenuDisabled}
              >
                {t("actions.rollback")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onRequestDelete(node)}
            variant="destructive"
          >
            {tCommon("delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const absolutePath = joinFsPath(workspacePath, node.path)
  const isThisDirUntracked =
    ancestorUntracked || untrackedDirPaths.has(node.path)
  const dirHasChanges =
    !isGitignoreIgnored &&
    (gitChangedDirPaths.has(node.path) ||
      gitStatusByPath.has(node.path) ||
      isThisDirUntracked)
  const directoryDecoration = directoryGitDecorations.get(node.path)
  const isGitSubmodule = gitSubmodulePaths.has(node.path)
  // 嵌套 git 仓库（后端 isRepo 标记：含 .git 的目录，非 submodule 也能识别）。
  const isNestedRepo = node.kind === "dir" && node.isRepo === true
  const isRepoDir = isGitSubmodule || isNestedRepo
  const repoDirLabel = isNestedRepo ? t("nestedRepo") : t("gitSubmodule")
  const isGitMenuDisabled = !gitEnabled || isGitignoreIgnored
  const shouldRenderChildren = expandedPaths.has(node.path)

  const handleOpenDirInSystemExplorer = async () => {
    try {
      await revealItemInDir(absolutePath)
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.openDirectoryFailed"), { description: message })
    }
  }

  const isSymlink = Boolean(node.linkTarget)
  const symlinkTitle = node.linkTarget
    ? t("symlinkTooltip", { target: node.linkTarget })
    : undefined

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <FileTreeFolder
          path={node.path}
          name={node.name}
          symlink={isSymlink}
          nameClassName={
            isGitignoreIgnored
              ? GITIGNORE_MUTED_CLASS
              : dirHasChanges
                ? directoryDecoration?.className
                : undefined
          }
          suffix={directoryDecoration?.badge}
          suffixClassName={directoryDecoration?.className}
          gitSubmodule={isRepoDir}
          title={isRepoDir ? repoDirLabel : symlinkTitle}
          iconClassName={isGitignoreIgnored ? GITIGNORE_MUTED_CLASS : undefined}
          dropActive={dropDir === node.path}
          dropTargetDir={node.path}
          depth={0}
          guides={guides}
          rowProps={{
            draggable: true,
            className: dragging ? "opacity-70" : undefined,
            title: isRepoDir ? repoDirLabel : symlinkTitle,
            onDragStart: (event) => {
              dnd.onEntryDragStart(event, node)
              setDragging(!event.defaultPrevented)
            },
            onDrag: (event) => dnd.onEntryDrag(event.clientX, event.clientY),
            onDragEnd: () => {
              setDragging(false)
              dnd.onEntryDragEnd()
            },
          }}
        >
          {shouldRenderChildren
            ? node.children.map((child, index) => (
                <RenderNode
                  key={child.path}
                  node={child}
                  guides={[...guides, index < node.children.length - 1]}
                  expandedPaths={expandedPaths}
                  workspacePath={workspacePath}
                  dnd={dnd}
                  gitEnabled={gitEnabled}
                  gitStatusByPath={gitStatusByPath}
                  gitChangedDirPaths={gitChangedDirPaths}
                  untrackedDirPaths={untrackedDirPaths}
                  directoryGitDecorations={directoryGitDecorations}
                  gitSubmodulePaths={gitSubmodulePaths}
                  ancestorGitignoreIgnored={isGitignoreIgnored}
                  ancestorUntracked={isThisDirUntracked}
                  onOpenFileDiff={onOpenFileDiff}
                  onOpenDirDiff={onOpenDirDiff}
                  onRequestCompareWithBranch={onRequestCompareWithBranch}
                  onRequestRollback={onRequestRollback}
                  onOpenDirInTerminal={onOpenDirInTerminal}
                  onRequestCreate={onRequestCreate}
                  onRequestAddToVcs={onRequestAddToVcs}
                  onRequestRename={onRequestRename}
                  onRequestDelete={onRequestDelete}
                  onCopyEntry={onCopyEntry}
                  onPasteInto={onPasteInto}
                />
              ))
            : null}
        </FileTreeFolder>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SendToAgentMenuItem
          absolutePath={absolutePath}
          workspacePath={node.path}
          fileName={node.name}
        />
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t("new")}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => onRequestCreate(node.path, "file")}
            >
              {t("newFile")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onRequestCreate(node.path, "dir")}>
              {t("newDirectory")}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyEntry(node)}>
          {t("copy")}
        </ContextMenuItem>
        <PasteMenuItem onPaste={() => onPasteInto(node.path)} />
        <ContextMenuItem
          onSelect={() =>
            void copyPathToClipboard(absolutePath, t("toasts.copyPathFailed"))
          }
        >
          {t("copyPath")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onRequestRename(node)}>
          {tCommon("rename")}
        </ContextMenuItem>
        {isDeviceProject ? null : (
          <ContextMenuItem
            onSelect={() => void handleOpenDirInSystemExplorer()}
          >
            {systemExplorerLabel}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => void onOpenDirInTerminal(absolutePath, node.name)}
        >
          {t("openInTerminal")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={isGitMenuDisabled}>
            {t("git")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => onRequestAddToVcs(node)}
              disabled={isGitMenuDisabled}
            >
              {t("actions.addToVcs")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onOpenDirDiff(node.path)}
              disabled={isGitMenuDisabled}
            >
              {tCommon("viewDiff")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onRequestCompareWithBranch(node)}
              disabled={isGitMenuDisabled}
            >
              {t("compareWithBranch")}
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onSelect={() => onRequestRollback(node)}
              disabled={isGitMenuDisabled}
            >
              {t("actions.rollback")}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onRequestDelete(node)}
          variant="destructive"
        >
          {tCommon("delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 文件树的「粘贴」：菜单打开时才挂载，这时才读剪贴板；没有可粘贴的文件时禁用。 */
export function PasteMenuItem({ onPaste }: { onPaste: () => void }) {
  const t = useTranslations("Folder.fileTreeTab")
  const [entries, setEntries] = useState<FileTreeClipboardEntry[]>([])
  useEffect(() => {
    let disposed = false
    void readPasteEntries().then((next) => {
      if (!disposed) setEntries(next)
    })
    return () => {
      disposed = true
    }
  }, [])
  const label =
    entries.length === 0
      ? t("paste")
      : entries.length === 1
        ? t("pasteNamed", { name: entries[0].name })
        : t("pasteCount", { count: entries.length })
  return (
    <ContextMenuItem disabled={entries.length === 0} onSelect={onPaste}>
      {label}
    </ContextMenuItem>
  )
}

/** 菜单打开时才挂载，避免每个树节点常驻订阅 tab 状态。 */
function SendToAgentMenuItem(props: {
  absolutePath: string
  workspacePath: string
  fileName: string
}) {
  const { label, sendFile } = useSendToAgent()
  return (
    <ContextMenuItem onSelect={() => void sendFile(props)}>
      {label}
    </ContextMenuItem>
  )
}
