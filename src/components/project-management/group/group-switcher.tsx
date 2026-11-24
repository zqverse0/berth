"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Settings2, Users } from "lucide-react"
import { create } from "zustand"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  configureChatGroup,
  createChatGroup,
  deleteChatGroup,
  listChatGroups,
  PROJECT_GROUP,
  renameChatGroup,
  type ChatGroup,
} from "@/lib/agent/berth-group"
import { toast } from "@/lib/notify"
import { confirmDialog } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { showProjectHome } from "@/lib/workspace/project-home"
import { mainFolderId, memberLabel } from "@/lib/workspace/projects"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { useSelectedGroup } from "./use-task-group"
import { useExperts } from "./expert-editor"
import { GroupSection } from "./group-members"

/**
 * 空间的群列表：权威来源是后端 `group.list`（groups.json + 各群账本），去掉与专家的私聊（`dm`）；
 * 这里只缓存最近一次读到的，群的增删改、成员进出后调 `reload` 失效。
 */
export const useChatGroups = create<{
  byFolder: Record<number, ChatGroup[]>
  reload: (folderId: number) => Promise<void>
}>((set) => ({
  byFolder: {},
  reload: async (folderId) => {
    const response = await listChatGroups(folderId)
    if (response.ok)
      set((state) => ({
        byFolder: {
          ...state.byFolder,
          [folderId]: response.result.groups.filter((group) => !group.dm),
        },
      }))
  },
}))

/** 读一次本空间的群列表。 */
export function useChatGroupList(folderId: number) {
  const groups = useChatGroups((state) => state.byFolder[folderId])
  useEffect(() => {
    void useChatGroups.getState().reload(folderId)
  }, [folderId])
  return groups ?? []
}

const titleOf = (group: ChatGroup) => group.title || group.name
const trimSlash = (path: string) => path.replace(/[\\/]+$/, "")
const SELECT = "h-9 rounded-md border bg-background px-3 text-sm"

/** 群目录可选：主项目与它的 worktree。 */
function useProjectDirs(folderId: number) {
  const folders = useAppWorkspaceStore((state) => state.allFolders)
  return folders
    .filter(
      (folder) => folder.kind !== "chat" && mainFolderId(folder) === folderId
    )
    .sort((a, b) => Number(b.id === folderId) - Number(a.id === folderId))
    .map((folder) => ({ path: folder.path, label: memberLabel(folder) }))
}

/**
 * 侧栏群组视图的「群」分组：本空间的群（图标、显示名、目录，下一行列出成员名）。点一行 = 选中这个群、首页显示它的群聊；
 * 分组标题的「＋」新建群，行尾按钮（悬停出现）打开群设置（显示名、目录、删除）。
 */
export function GroupList({ folderId }: { folderId: number }) {
  const t = useTranslations("BerthTasks.group.groups")
  const groups = useChatGroupList(folderId)
  const selected = useSelectedGroup(folderId)
  // 在和某位专家单聊时，高亮的是那位专家，不是群。
  const focused = useGroupWorkspaceStore((state) => state.focusedMember)
  const dirs = useProjectDirs(folderId)
  const { catalog } = useExperts()
  // 成员名：专家显示它的名字，其余（worker 等）显示成员名。
  const nameOf = (member: string) =>
    catalog?.experts.find((entry) => entry.id === member)?.expert.name || member
  const [dialog, setDialog] = useState<"create" | ChatGroup | null>(null)
  const select = (name: string) => {
    const store = useGroupWorkspaceStore.getState()
    store.selectGroup(folderId, name)
    store.setFocusedMember(null)
    showProjectHome()
  }
  const dirOf = (cwd: string) =>
    dirs.find((dir) => trimSlash(dir.path) === trimSlash(cwd))?.label ??
    cwd.split(/[\\/]/).filter(Boolean).pop() ??
    cwd
  return (
    <GroupSection
      title={t("section")}
      action={
        <button
          type="button"
          data-group-create
          aria-label={t("create")}
          title={t("create")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setDialog("create")}
        >
          <Plus aria-hidden="true" className="size-3.5" />
        </button>
      }
    >
      <div data-group-list>
        {groups.map((group) => (
          <div
            key={group.name}
            data-group-option={group.name}
            className={cn(
              "group relative rounded-md hover:bg-accent/40",
              group.name === selected && !focused && "bg-primary/10"
            )}
          >
            <button
              type="button"
              aria-pressed={group.name === selected}
              className="flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left"
              onClick={() => select(group.name)}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                <Users aria-hidden="true" className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {titleOf(group)}
                  </span>
                  <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
                    {dirOf(group.cwd)}
                  </span>
                </span>
                <span
                  data-group-members
                  className="block truncate text-[11px] text-muted-foreground/80"
                >
                  {group.members.length
                    ? group.members.map(nameOf).join(t("memberSeparator"))
                    : t("memberCount", { count: 0 })}
                </span>
              </span>
            </button>
            <button
              type="button"
              data-group-settings={group.name}
              aria-label={t("settingsOf", { name: titleOf(group) })}
              title={t("settings")}
              className="pointer-events-none absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground opacity-0 hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
              onClick={() => setDialog(group)}
            >
              <Settings2 aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {dialog === "create" ? (
        <CreateGroupDialog
          folderId={folderId}
          onClose={() => setDialog(null)}
          onCreated={select}
        />
      ) : dialog ? (
        <GroupSettingsDialog
          folderId={folderId}
          group={dialog}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </GroupSection>
  )
}

/** 调后端；失败提示并返回 false，成功刷新群列表。 */
async function act(
  folderId: number,
  work: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>
) {
  const response = await work().catch((cause: unknown) => ({
    ok: false as const,
    error: { message: String(cause) },
  }))
  if (!response.ok) toast.error(response.error.message)
  await useChatGroups.getState().reload(folderId)
  return response.ok
}

function DirSelect({
  folderId,
  value,
  onChange,
}: {
  folderId: number
  value: string
  onChange: (path: string) => void
}) {
  const t = useTranslations("BerthTasks.group.groups")
  const dirs = useProjectDirs(folderId)
  // 当前目录不在列表里（worktree 已删）也照样显示。
  const known = dirs.some((dir) => trimSlash(dir.path) === trimSlash(value))
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {t("cwd")}
      <select
        data-group-cwd
        className={SELECT}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {known || !value ? null : <option value={value}>{value}</option>}
        {dirs.map((dir) => (
          <option key={dir.path} value={dir.path}>
            {dir.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function CreateGroupDialog({
  folderId,
  onClose,
  onCreated,
}: {
  folderId: number
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const t = useTranslations("BerthTasks.group.groups")
  const dirs = useProjectDirs(folderId)
  const [form, setForm] = useState({
    name: "",
    title: "",
    cwd: dirs[0]?.path ?? "",
  })
  const submit = async () => {
    const name = form.name.trim()
    const ok = await act(folderId, () =>
      createChatGroup(
        folderId,
        name,
        form.title.trim() || undefined,
        form.cwd || undefined
      )
    )
    if (!ok) return
    onCreated(name)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-group-create-dialog>
        <DialogHeader>
          <DialogTitle>{t("create")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("name")}
            <Input
              data-group-name
              placeholder={t("namePlaceholder")}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("title")}
            <Input
              data-group-title
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <DirSelect
            folderId={folderId}
            value={form.cwd}
            onChange={(cwd) => setForm({ ...form, cwd })}
          />
        </div>
        <DialogFooter>
          <Button
            data-group-create-submit
            disabled={!form.name.trim()}
            onClick={() => void submit()}
          >
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GroupSettingsDialog({
  folderId,
  group,
  onClose,
}: {
  folderId: number
  group: ChatGroup
  onClose: () => void
}) {
  const t = useTranslations("BerthTasks.group.groups")
  const [form, setForm] = useState({
    title: group.title ?? "",
    cwd: group.cwd,
  })
  const save = async () => {
    const title = form.title.trim()
    if (title !== (group.title ?? "")) {
      if (
        !(await act(folderId, () =>
          renameChatGroup(folderId, group.name, title)
        ))
      )
        return
    }
    const cwd =
      trimSlash(form.cwd) !== trimSlash(group.cwd) ? form.cwd : undefined
    if (cwd !== undefined) {
      const ok = await act(folderId, () =>
        configureChatGroup(folderId, group.name, { cwd })
      )
      if (!ok) return
    }
    onClose()
  }
  const remove = async () => {
    if (!(await confirmDialog(t("deleteConfirm", { name: titleOf(group) }))))
      return
    if (!(await act(folderId, () => deleteChatGroup(folderId, group.name))))
      return
    useGroupWorkspaceStore.getState().selectGroup(folderId, PROJECT_GROUP)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-group-settings-dialog>
        <DialogHeader>
          <DialogTitle>{t("settingsOf", { name: titleOf(group) })}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            {t("title")}
            <Input
              data-group-title
              placeholder={group.name}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <DirSelect
            folderId={folderId}
            value={form.cwd}
            onChange={(cwd) => setForm({ ...form, cwd })}
          />
          {trimSlash(form.cwd) !== trimSlash(group.cwd) ? (
            <p className="text-xs text-muted-foreground">{t("cwdHint")}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("everyoneHint")}</p>
        </div>
        <DialogFooter className="sm:justify-between">
          {group.name === PROJECT_GROUP ? (
            <span />
          ) : (
            <Button
              variant="ghost"
              data-group-delete
              className="text-destructive"
              onClick={() => void remove()}
            >
              {t("delete")}
            </Button>
          )}
          <Button data-group-save onClick={() => void save()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
