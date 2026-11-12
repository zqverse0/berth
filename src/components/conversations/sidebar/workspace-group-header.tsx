"use client"

import { useState, type PointerEvent } from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react"
import {
  checkWorkspaceName,
  type WorkspaceGroup,
  type WorkspaceGroupsState,
} from "@/lib/workspace-groups"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { WORKSPACE_DROP_ATTR } from "./use-sidebar-drag"

/**
 * 工作区标题：点标题切换到该工作区，点左侧箭头在「完整 / 只看运行中」间切换；右键或「更多」改名、新建、删除（「默认」没有删除）。
 * 整行是项目的放下目标，也能拖动调整顺序。
 */
export function WorkspaceGroupHeader({
  group,
  current,
  full,
  summary,
  onSwitch,
  onToggle,
  onDragStart,
  onRename,
  onCreate,
  onDelete,
}: {
  group: WorkspaceGroup
  current: boolean
  full: boolean
  /** 右侧摘要：需关注 / 运行数，或项目数 */
  summary: string
  onSwitch: () => void
  onToggle: () => void
  onDragStart: (event: PointerEvent) => void
  onRename: () => void
  onCreate: () => void
  onDelete: () => void
}) {
  const t = useTranslations("WorkspaceGroups")
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          {...{ [WORKSPACE_DROP_ATTR]: group.id }}
          className={cn(
            "group/ws mt-1 flex h-7 items-center rounded-md pr-1 pl-0.5 hover:bg-accent/60 data-[drop-active]:bg-accent data-[drop-active]:ring-1 data-[drop-active]:ring-primary/40",
            current &&
              "sticky top-0 z-10 bg-[color-mix(in_srgb,var(--primary)_18%,var(--sidebar))] shadow-[inset_3px_0_0_var(--primary)] hover:bg-[color-mix(in_srgb,var(--primary)_24%,var(--sidebar))]"
          )}
        >
          <button
            type="button"
            aria-expanded={full}
            aria-label={`${group.name}: ${full ? t("showRunning") : t("showFull")}`}
            title={full ? t("showRunning") : t("showFull")}
            onClick={onToggle}
            className="ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {full ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
          <button
            type="button"
            aria-current={current ? "true" : undefined}
            title={current ? undefined : t("switchTo")}
            onClick={onSwitch}
            onPointerDown={onDragStart}
            className={cn(
              "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              current
                ? "font-semibold text-foreground"
                : "text-muted-foreground"
            )}
          >
            {group.emoji ? (
              <span aria-hidden className="shrink-0">
                {group.emoji}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{group.name}</span>
            <span className="ml-auto shrink-0 truncate pl-2 text-[0.6875rem] font-normal text-muted-foreground">
              {summary}
            </span>
          </button>
          <button
            type="button"
            aria-label={t("more")}
            title={t("more")}
            aria-haspopup="menu"
            onClick={(event) => {
              // 与右键同一个菜单
              const rect = event.currentTarget.getBoundingClientRect()
              event.currentTarget.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  button: 2,
                  clientX: rect.left,
                  clientY: rect.bottom,
                })
              )
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRename}>
          <PencilLine className="h-4 w-4" />
          {t("rename")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCreate}>
          <Plus className="h-4 w-4" />
          {t("create")}
        </ContextMenuItem>
        {group.isDefault ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="h-4 w-4" />
              {t("delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 顶栏的工作区下拉：显示当前工作区，列出全部工作区及其需关注 / 运行数，选中即切换。 */
export function WorkspaceSwitcher({
  items,
  onSwitch,
  onCreate,
}: {
  items: { group: WorkspaceGroup; current: boolean; summary: string }[]
  onSwitch: (groupId: string) => void
  onCreate: () => void
}) {
  const t = useTranslations("WorkspaceGroups")
  const active = items.find((item) => item.current)?.group
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("workspaceMenu")}
          title={t("workspaceMenu")}
          className="-ml-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[0.8125rem] font-semibold text-sidebar-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent/60"
        >
          {active?.emoji ? <span aria-hidden>{active.emoji}</span> : null}
          <span className="min-w-0 truncate">{active?.name}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-64 overflow-y-auto"
      >
        {items.map(({ group, current, summary }) => (
          <DropdownMenuItem key={group.id} onSelect={() => onSwitch(group.id)}>
            <Check className={cn("size-3.5", !current && "invisible")} />
            {group.emoji ? <span aria-hidden>{group.emoji}</span> : null}
            <span className="min-w-0 truncate">{group.name}</span>
            <span className="ml-auto shrink-0 pl-2 text-[0.6875rem] text-muted-foreground">
              {summary}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCreate}>
          <Plus className="size-3.5" />
          {t("create")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 新建 / 改名工作区：名称（必填、不重名）+ 可选 emoji；不合规时不保存，在输入框旁写明原因。 */
export function WorkspaceGroupDialog({
  state,
  editing,
  onClose,
  onSave,
}: {
  state: WorkspaceGroupsState
  /** `null` 关闭；`{ group: null }` 新建 */
  editing: { group: WorkspaceGroup | null } | null
  onClose: () => void
  onSave: (name: string, emoji: string | null) => void
}) {
  const t = useTranslations("WorkspaceGroups")
  const tCommon = useTranslations("Folder.common")
  const [form, setForm] = useState({
    name: editing?.group?.name ?? "",
    emoji: editing?.group?.emoji ?? "",
    touched: false,
  })
  const error = checkWorkspaceName(state, form.name, editing?.group?.id)
  const save = () => {
    if (error) {
      setForm((prev) => ({ ...prev, touched: true }))
      return
    }
    onSave(form.name, form.emoji.trim() || null)
  }
  return (
    <Dialog open={editing != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {editing?.group ? t("renameTitle") : t("createTitle")}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="flex gap-2">
            <Input
              aria-label={t("emojiLabel")}
              placeholder="🛠"
              value={form.emoji}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, emoji: e.target.value }))
              }
              className="w-14 text-center"
            />
            <Input
              aria-label={t("nameLabel")}
              aria-invalid={form.touched && error != null}
              placeholder={t("nameLabel")}
              value={form.name}
              autoFocus
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  name: e.target.value,
                  touched: true,
                }))
              }
              className="flex-1"
            />
          </div>
          <p
            role="alert"
            className={cn(
              "min-h-4 text-xs text-destructive",
              !(form.touched && error) && "invisible"
            )}
          >
            {error ? t(`nameErrors.${error}`) : ""}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit">{t("save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
