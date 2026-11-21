"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import { gitStatus } from "@/lib/api"
import { finishGroup, type GroupFinishPlan } from "@/lib/agent/berth-tasks"
import { listGroups, readTaskGroup } from "@/lib/agent/berth-group"
import { paneFolderId } from "@/lib/terminal/agent-panes"
import { refreshTerminalInventory } from "@/lib/terminal/terminal-inventory-query"
import { useTabActions } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { mainFolderId, projectName } from "@/lib/workspace/projects"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/** 从列表移除项目、删除 worktree、清理失效 worktree。 */
/** remove：移出整个项目；detach：只把这个成员移出项目（不删目录）；delete：删 worktree；prune：清理失效。 */
export type RemoveMode = "remove" | "detach" | "delete" | "prune"

type Check =
  | { kind: "plain" }
  /** 有 Agent 或群成员在这个 worktree 里跑：只能取消。 */
  | { kind: "busy"; agents: number; members: string[] }
  /** 有未提交改动：确认即连同改动一起删。 */
  | { kind: "dirty"; changes: number }
  /** 群 worktree：走群组收尾，检查不过只能取消。 */
  | { kind: "group"; group: string; plan: GroupFinishPlan }

type Confirm = Check & {
  folderId: number
  folderName: string
  mode: RemoveMode
  terminalCount: number
}

const trimSlash = (path: string) => path.replace(/[\\/]+$/, "")
const inside = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`)

/**
 * 删除 worktree 前的检查：有 Agent / 群成员在跑就拒绝；群 worktree 交给群组收尾（任务都结束、
 * 已合并、目录干净才删，分支保留）；其余有未提交改动先确认。
 */
async function checkDelete(
  folderId: number,
  path: string,
  terminals: Awaited<ReturnType<typeof refreshTerminalInventory>>
): Promise<Check> {
  const { allFolders } = useAppWorkspaceStore.getState()
  const folder = allFolders.find((item) => item.id === folderId)
  const main = folder ? mainFolderId(folder) : folderId
  const root = trimSlash(path)

  const agents = terminals.filter(
    (item) =>
      item.status === "running" &&
      item.agentId &&
      paneFolderId(item, allFolders) === folderId
  ).length
  const group = await readTaskGroup(main).catch(() => null)
  const members = group?.ok
    ? group.result.members
        .filter(
          (member) =>
            member.leftAt == null &&
            member.bodies.some(
              (body) => body.cwd != null && inside(trimSlash(body.cwd), root)
            )
        )
        .map((member) => member.label || member.name)
    : []
  if (agents > 0 || members.length > 0) return { kind: "busy", agents, members }

  const groups = await listGroups(main, true).catch(() => null)
  const name = groups?.ok
    ? Object.entries(groups.result.worktrees).find(
        ([, worktree]) => trimSlash(worktree) === root
      )?.[0]
    : undefined
  if (name) {
    const plan = await finishGroup(main, name, true)
    if (!plan.ok) throw new Error(plan.error.message)
    return { kind: "group", group: name, plan: plan.result }
  }

  const changes = (await gitStatus(path)).length
  return changes > 0 ? { kind: "dirty", changes } : { kind: "plain" }
}

/**
 * 移除项目 / 删除 worktree / 清理失效 worktree：先检查再弹确认框；确认后执行并关掉相关 tab。
 * 返回发起入口与要渲染的确认框。
 */
export function useRemoveProject() {
  const t = useTranslations("Folder.sidebar")
  const tMembers = useTranslations("ProjectMembers")
  const tCommon = useTranslations("Folder.common")
  const tTerminal = useTranslations("Folder.terminal")
  const removeFolderFromWorkspace = useAppWorkspaceStore(
    (s) => s.removeFolderFromWorkspace
  )
  const { closeTabsByFolder } = useTabActions()
  const [confirm, setConfirm] = useState<Confirm | null>(null)

  const requestRemove = useCallback(
    (folderId: number, mode: RemoveMode) => {
      const folder = useAppWorkspaceStore
        .getState()
        .allFolders.find((item) => item.id === folderId)
      // 移除的是整个空间，显示空间名；其余操作针对单个项目，显示目录名。
      const folderName =
        (folder && (mode === "remove" ? projectName(folder) : folder.name)) ??
        String(folderId)
      void (async () => {
        const terminals = await refreshTerminalInventory().catch(() => [])
        const terminalCount = terminals.filter(
          (item) => item.folderId === folderId && item.status === "running"
        ).length
        try {
          const check: Check =
            mode === "delete" && folder
              ? await checkDelete(folderId, folder.path, terminals)
              : { kind: "plain" }
          setConfirm({ folderId, folderName, mode, terminalCount, ...check })
        } catch (error) {
          toast.error(
            t("toasts.worktreeDeleteFailed", { message: toErrorMessage(error) })
          )
        }
      })()
    },
    [t]
  )

  const handleConfirm = useCallback(async () => {
    if (!confirm) return
    const { folderId, folderName, mode } = confirm
    // 移除主成员会连带移除整个项目，先记下其余成员以便关闭它们的 tab。
    const familyIds = useAppWorkspaceStore
      .getState()
      .allFolders.filter(
        (f) => f.id !== folderId && mainFolderId(f) === folderId
      )
      .map((f) => f.id)
    try {
      if (confirm.kind === "group") {
        const folder = useAppWorkspaceStore
          .getState()
          .allFolders.find((item) => item.id === folderId)
        const main = folder ? mainFolderId(folder) : folderId
        const result = await finishGroup(main, confirm.group, false)
        if (!result.ok) throw new Error(result.error.message)
        // 目录已由群组收尾删掉：列表里的这一行按失效清掉。
        await removeFolderFromWorkspace(folderId, true)
      } else {
        await removeFolderFromWorkspace(
          folderId,
          mode !== "remove" && mode !== "detach",
          confirm.kind === "dirty"
        )
      }
      for (const id of [folderId, ...familyIds]) closeTabsByFolder(id)
      toast.success(
        mode === "detach"
          ? tMembers("detached", { name: folderName })
          : mode === "remove"
            ? t("toasts.folderRemoved", { name: folderName })
            : t("toasts.worktreeDeleted", { name: folderName })
      )
    } catch (e) {
      const message = toErrorMessage(e)
      toast.error(
        mode === "remove" || mode === "detach"
          ? t("toasts.removeFolderFailed", { message })
          : t("toasts.worktreeDeleteFailed", { message })
      )
    } finally {
      setConfirm(null)
    }
  }, [confirm, closeTabsByFolder, removeFolderFromWorkspace, t, tMembers])

  const blocked =
    confirm?.kind === "busy" ||
    (confirm?.kind === "group" && !confirm.plan.ready)

  const title = !confirm
    ? ""
    : confirm.mode === "detach"
      ? tMembers("detachTitle", { name: confirm.folderName })
      : confirm.mode === "remove"
        ? t("removeFolderConfirmTitle")
        : confirm.mode === "prune"
          ? tMembers("pruneTitle", { name: confirm.folderName })
          : confirm.kind === "group"
            ? tMembers("groupFinishTitle", { name: confirm.folderName })
            : t("deleteWorktreeConfirmTitle")

  const body = (() => {
    if (!confirm) return null
    if (confirm.mode === "detach") return tMembers("detachDescription")
    if (confirm.mode === "remove")
      return t("removeFolderConfirmDescription", { name: confirm.folderName })
    if (confirm.mode === "prune") return tMembers("pruneDescription")
    switch (confirm.kind) {
      case "busy":
        return tMembers("deleteBusy", {
          agents: confirm.agents,
          members: confirm.members.join("、") || "-",
        })
      case "group": {
        if (confirm.plan.ready) return tMembers("groupFinishReady")
        const reasons = [
          confirm.plan.openTasks.length > 0
            ? tMembers("groupOpenTasks", {
                tasks: confirm.plan.openTasks.join("、"),
              })
            : null,
          confirm.plan.dirty.length > 0
            ? tMembers("groupDirty", { count: confirm.plan.dirty.length })
            : null,
          confirm.plan.merged
            ? null
            : tMembers("groupUnmerged", { base: confirm.plan.baseBranch }),
        ].filter(Boolean)
        return (
          <>
            {tMembers("groupFinishBlocked")}
            {reasons.map((reason) => (
              <span key={reason} className="mt-1 block">
                · {reason}
              </span>
            ))}
          </>
        )
      }
      case "dirty":
        return tMembers("deleteDirty", {
          name: confirm.folderName,
          count: confirm.changes,
        })
      default:
        return tMembers("deleteWorktree", { name: confirm.folderName })
    }
  })()

  const removeDialog = (
    <AlertDialog
      open={confirm !== null}
      onOpenChange={(open) => !open && setConfirm(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {body}
            {!blocked && (confirm?.terminalCount ?? 0) > 0 ? (
              <span className="mt-2 block">
                {tTerminal("folderTerminateDescription", {
                  count: confirm?.terminalCount ?? 0,
                })}
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {blocked ? tMembers("gotIt") : tCommon("cancel")}
          </AlertDialogCancel>
          {blocked ? null : (
            <AlertDialogAction onClick={handleConfirm}>
              {tCommon("confirm")}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { requestRemove, removeDialog }
}
