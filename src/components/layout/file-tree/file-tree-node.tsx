"use client"

import { createContext, useContext, useState } from "react"
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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
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
 * The directory drop zone highlighted by an in-flight *desktop* native drag
 * (relative path; `""` = workspace root), or null. On the web each row derives
 * its own drop highlight from the DOM `dragover`/`dragleave` it receives; on
 * desktop WebKit suppresses those target-side events during a native drag
 * (only `dragstart`/`dragend` reach the DOM), so the highlight is instead
 * broadcast here from Tauri's native DRAG_OVER hit-test and OR-ed into each
 * row's `dropActive`. Stays null on the web, so it never forces a re-render there.
 */
export const DesktopDropDirContext = createContext<string | null>(null)

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
 * Drag-and-drop bridge shared by every tree row and the workspace-root row. The
 * source of the in-flight drag lives in a ref on the container (set on
 * dragstart), so `canDropInto` can validate a hover without reading the
 * (drag-over–inaccessible) dataTransfer.
 */
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
  /** Whether the in-flight source may drop into `destDir` (relative; `""` =
   *  workspace root). False when there's no drag, it's a no-op (same parent), or
   *  it would move a directory into itself/a descendant. */
  canDropInto: (destDir: string) => boolean
  /** Move the in-flight source into `destDir`. */
  onDropInto: (destDir: string) => void
}

interface RenderNodeProps {
  node: FileTreeNode
  depth: number
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
  onOpenFilePreview: (path: string) => void
  onOpenFileDiff: (path: string) => void
  onOpenDirDiff: (path: string) => void
  onOpenCommitWindow: () => void
  onRequestCompareWithBranch: (target: FileActionTarget) => void
  onRequestRollback: (target: FileActionTarget) => void
  onOpenDirInTerminal: (dirPath: string, fileName: string) => Promise<void>
  onRequestAddToVcs: (target: FileActionTarget) => void
  onRequestRename: (target: FileActionTarget) => void
  onRequestCreate: (parentPath: string, kind: "file" | "dir") => void
  onRequestDelete: (target: FileActionTarget) => void
  onRefresh: () => void
}

export function RenderNode({
  node,
  depth,
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
  onOpenFilePreview,
  onOpenFileDiff,
  onOpenDirDiff,
  onOpenCommitWindow,
  onRequestCompareWithBranch,
  onRequestRollback,
  onOpenDirInTerminal,
  onRequestAddToVcs,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRefresh,
}: RenderNodeProps) {
  const t = useTranslations("Folder.fileTreeTab")
  const tCommon = useTranslations("Folder.common")
  // `dragging` dims this row while it is the drag source; `dropActive` lights a
  // directory row up while a valid drop hovers it (files are never drop targets).
  const [dragging, setDragging] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  // Desktop native drags don't emit DOM dragover, so a directory also lights up
  // when it's the drop zone broadcast from the Tauri DRAG_OVER hit-test.
  const desktopDropDir = useContext(DesktopDropDirContext)
  const isGitignoreIgnored = ancestorGitignoreIgnored || node.ignored === true

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
    const dirPath = parentDir(absolutePath)
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
            depth={depth}
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
            draggable
            onDragStart={(event) => {
              setDragging(true)
              dnd.onEntryDragStart(event, node)
            }}
            onDrag={(event) => dnd.onEntryDrag(event.clientX, event.clientY)}
            onDragEnd={() => {
              setDragging(false)
              dnd.onEntryDragEnd()
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onOpenFilePreview(node.path)}>
            {tCommon("openFile")}
          </ContextMenuItem>
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
              <ContextMenuItem
                onSelect={() => onRequestCreate(node.path, "dir")}
              >
                {t("newDirectory")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={isGitMenuDisabled}>
              {t("git")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => onOpenCommitWindow()}
                disabled={isGitMenuDisabled}
              >
                {t("actions.commitCode")}
              </ContextMenuItem>
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
          <ContextMenuItem onSelect={() => onRequestRename(node)}>
            {tCommon("rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRefresh}>
            {t("reloadFromDisk")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("openIn")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => void handleOpenInSystemExplorer()}
              >
                {systemExplorerLabel}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => void onOpenDirInTerminal(dirPath, node.name)}
              >
                {t("openInTerminal")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            onSelect={() =>
              void copyPathToClipboard(absolutePath, t("toasts.copyPathFailed"))
            }
          >
            {t("copyPath")}
          </ContextMenuItem>
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
          dropActive={dropActive || desktopDropDir === node.path}
          dropTargetDir={node.path}
          depth={depth}
          rowProps={{
            draggable: true,
            className: dragging ? "opacity-70" : undefined,
            title: isRepoDir ? repoDirLabel : symlinkTitle,
            onDragStart: (event) => {
              setDragging(true)
              dnd.onEntryDragStart(event, node)
            },
            onDrag: (event) => dnd.onEntryDrag(event.clientX, event.clientY),
            onDragEnd: () => {
              setDragging(false)
              setDropActive(false)
              dnd.onEntryDragEnd()
            },
            onDragOver: (event) => {
              if (!dnd.canDropInto(node.path)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setDropActive(true)
            },
            onDragLeave: (event) => {
              const related = event.relatedTarget
              if (
                related instanceof Node &&
                event.currentTarget.contains(related)
              )
                return
              setDropActive(false)
            },
            onDrop: (event) => {
              setDropActive(false)
              if (!dnd.canDropInto(node.path)) return
              event.preventDefault()
              event.stopPropagation()
              dnd.onDropInto(node.path)
            },
          }}
        >
          {shouldRenderChildren
            ? node.children.map((child) => (
                <RenderNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
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
                  onOpenFilePreview={onOpenFilePreview}
                  onOpenFileDiff={onOpenFileDiff}
                  onOpenDirDiff={onOpenDirDiff}
                  onOpenCommitWindow={onOpenCommitWindow}
                  onRequestCompareWithBranch={onRequestCompareWithBranch}
                  onRequestRollback={onRequestRollback}
                  onOpenDirInTerminal={onOpenDirInTerminal}
                  onRequestCreate={onRequestCreate}
                  onRequestAddToVcs={onRequestAddToVcs}
                  onRequestRename={onRequestRename}
                  onRequestDelete={onRequestDelete}
                  onRefresh={onRefresh}
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
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={isGitMenuDisabled}>
            {t("git")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => onOpenCommitWindow()}
              disabled={isGitMenuDisabled}
            >
              {t("actions.commitCode")}
            </ContextMenuItem>
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
        <ContextMenuItem onSelect={() => onRequestRename(node)}>
          {tCommon("rename")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t("openIn")}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => void handleOpenDirInSystemExplorer()}
            >
              {systemExplorerLabel}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => void onOpenDirInTerminal(absolutePath, node.name)}
            >
              {t("openInTerminal")}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          onSelect={() =>
            void copyPathToClipboard(absolutePath, t("toasts.copyPathFailed"))
          }
        >
          {t("copyPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRefresh}>
          {t("reloadFromDisk")}
        </ContextMenuItem>
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
