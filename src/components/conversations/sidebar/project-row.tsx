"use client"

import { memo, useCallback, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  BookOpen,
  MoreHorizontal,
  PencilLine,
  Pin,
  XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DeviceStatus } from "@/components/devices/devices"
import { ProjectRowButton, projectBlockClass } from "./project-row-face"

/** 对方项目在行上要用的：所在设备与它的在线状态。 */
export interface RowDevice {
  id: number
  name: string
  state: DeviceStatus
}

/**
 * 项目行：项目只是成员的分组，没有自己的目录，所以不能选中、没有路径操作。
 * 点击展开 / 收起成员；菜单只有置顶、重命名、添加参考目录、移出（对方设备的项目没有菜单）。
 */
export const ProjectRow = memo(function ProjectRow({
  folderId,
  folderName,
  pinned,
  selected,
  current,
  expanded,
  device,
  idle,
  trailing,
  onToggle,
  onRemoveFromWorkspace,
  onRename,
  onSetPinned,
  onAddReference,
}: {
  /** 主成员 id：项目的名称、置顶记在它的项目记录上。 */
  folderId: number
  folderName: string
  pinned: boolean
  /** 收起且当前成员在里面：整行高亮。 */
  selected: boolean
  /** 当前成员在这个项目里：名称加粗。 */
  current: boolean
  /** 已展开成员：打开的文件夹图标。 */
  expanded: boolean
  /** 对方设备的项目；本机为 null（本机不标）。 */
  device: RowDevice | null
  /** 没有会话：名称淡色。 */
  idle: boolean
  /** 行尾：折叠时汇总的 Agent 图标。 */
  trailing?: ReactNode
  onToggle: (folderId: number) => void
  onRemoveFromWorkspace: (folderId: number) => void
  onRename: (folderId: number, name: string) => void
  onSetPinned: (folderId: number, pinned: boolean) => void
  onAddReference: (folderId: number) => void
}) {
  const tMembers = useTranslations("ProjectMembers")
  // Own the translations here rather than receiving `t` as a prop: next-intl
  // returns a fresh `t` on every parent render, which would defeat this memo.
  const t = useTranslations("Folder.sidebar")

  // 重命名对话框与 ContextMenu 平级，菜单选中关闭后它还在。初值是当前项目名。
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameValue, setNameValue] = useState("")
  const openRenameDialog = useCallback(() => {
    setNameValue(folderName)
    setRenameOpen(true)
  }, [folderName])
  const trimmed = nameValue.trim()
  const confirmRename = useCallback(() => {
    if (!trimmed) return
    onRename(folderId, trimmed)
    setRenameOpen(false)
  }, [trimmed, folderId, onRename])

  const offline = device?.state === "offline"
  const button = (
    <div className="flex h-[1.9375rem] w-full items-center">
      <ProjectRowButton
        data-project-id={folderId}
        onClick={() => onToggle(folderId)}
        aria-expanded={expanded}
        name={folderName}
        alias={null}
        pinned={pinned}
        selected={selected}
        worktree={false}
        nested={false}
        open={expanded}
        strong={current}
        branch={null}
        dim={idle}
        disabled={device != null && device.state !== "online"}
      />
      {trailing}
      {device ? null : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            // Re-open the SAME context menu as right-click: dispatch a
            // synthetic contextmenu event that bubbles to the trigger.
            const rect = e.currentTarget.getBoundingClientRect()
            e.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: rect.left,
                clientY: rect.bottom,
              })
            )
          }}
          title={t("moreOptions")}
          aria-label={t("moreOptions")}
          aria-haspopup="menu"
          className={cn(
            "mr-[0.375rem] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-end rounded-[0.375rem] outline-none text-muted-foreground/90",
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
            "transition-[opacity,color] duration-150 hover:text-sidebar-foreground"
          )}
        >
          <MoreHorizontal className="h-[0.875rem] w-[0.875rem]" />
        </button>
      )}
    </div>
  )
  return (
    <>
      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return
          onToggle(folderId)
        }}
        className={cn(projectBlockClass(selected), offline && "opacity-60")}
      >
        {device ? (
          <div className="relative h-[2rem]">{button}</div>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="relative h-[2rem]">{button}</div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onSetPinned(folderId, !pinned)}>
                <Pin className="h-4 w-4" />
                {pinned
                  ? t("folderHeaderMenu.unpinProject")
                  : t("folderHeaderMenu.pinProject")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={openRenameDialog}>
                <PencilLine className="h-4 w-4" />
                {t("folderHeaderMenu.renameProject")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onAddReference(folderId)}>
                <BookOpen className="h-4 w-4" />
                {tMembers("addReference")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onRemoveFromWorkspace(folderId)}
              >
                <XCircle className="h-4 w-4" />
                {t("folderHeaderMenu.removeFromWorkspace")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("folderHeaderMenu.renameProjectTitle")}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key === "Process") return
              if (e.key === "Enter") confirmRename()
            }}
            placeholder={t("folderHeaderMenu.renameProjectPlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("folderHeaderMenu.setAliasCancel")}
            </Button>
            <Button onClick={confirmRename} disabled={!trimmed}>
              {t("folderHeaderMenu.setAliasSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})
