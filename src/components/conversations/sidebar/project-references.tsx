"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BookOpen, GitBranch, Plus, SquareTerminal, X } from "lucide-react"
import { toast } from "@/lib/notify"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { sessionIndent } from "./project-row-face"
import { HoverButton, MemberRow } from "./member-row"
import type { SidebarSession } from "./sidebar-sessions"

const NO_SESSIONS: readonly SidebarSession[] = []

/** 成员视图在别处（项目菜单、成员菜单）变了：展开着的参考组 / 未加入提示重读。 */
const MEMBERS_CHANGED = "berth:project-members-changed"

/**
 * `project.member.*`：`folderId` 是项目里的成员。`add` / `rm` 参考目录、`join` 加入未登记的检出
 * （`path`）；`move` 改挂到项目（`project`）、`main` 设为主成员（`folderId` 即该成员）。
 */
export async function projectMemberOp(
  folderId: number,
  action: "add" | "rm" | "join" | "move" | "main",
  params: Record<string, unknown> = {}
) {
  const response = await runtimeBridgeOperation({
    method: `project.member.${action}`,
    folderId,
    params,
  })
  if (!response.ok) throw new Error(response.error.message)
  window.dispatchEvent(new Event(MEMBERS_CHANGED))
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** 项目菜单「添加参考目录…」：选目录后加入；失败时报 `failed` 文案。 */
export async function pickAndAddReference(
  folderId: number,
  failed: (message: string) => string
) {
  if (!isDesktop()) return
  const selected = await openFileDialog({ directory: true, multiple: false })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (!path) return
  await projectMemberOp(folderId, "add", { path }).catch((error: unknown) =>
    toast.error(failed(errorText(error)))
  )
}

function baseName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  )
}

interface Untracked {
  path: string
  branch: string | null
}

/**
 * 项目的参考成员与 git 里还没加入的检出（与 `berth project . member ls` 同一份）：项目可见时现读，
 * 成员变动后重读。`folderId` 是项目里任一成员。
 */
function useMemberView(folderId: number, visible: boolean) {
  const [view, setView] = useState<{
    references: string[]
    untracked: Untracked[]
  }>({ references: [], untracked: [] })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void (async () => {
      const response = await runtimeBridgeOperation<{
        references: { path: string }[]
        untracked: Untracked[]
      }>({ method: "project.member.ls", folderId })
      if (!cancelled && response.ok)
        setView({
          references: response.result.references.map((item) => item.path),
          untracked: response.result.untracked ?? [],
        })
    })()
    return () => {
      cancelled = true
    }
  }, [folderId, version, visible])
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1)
    window.addEventListener(MEMBERS_CHANGED, bump)
    return () => window.removeEventListener(MEMBERS_CHANGED, bump)
  }, [])
  return view
}

/**
 * 成员区末尾：「参考」组（在项目菜单里加；点一行在文件面板里浏览，悬停可开终端——会话归本项目——
 * 或移出项目，不动磁盘），以及收起的「未加入的 worktree」提示（git 里有、没登记进任何项目，逐个加入）。
 */
export function ProjectReferences({
  folderId,
  browsing,
  visible,
  onBrowse,
  onOpenTerminal,
  onJoined,
}: {
  folderId: number
  /** 文件面板正在浏览的参考目录。 */
  browsing: string | null
  visible: boolean
  onBrowse: (path: string | null) => void
  onOpenTerminal: (path: string) => void
  /** 加入了一个检出：重读成员。 */
  onJoined: () => void
}) {
  const t = useTranslations("ProjectMembers")
  const { references, untracked } = useMemberView(folderId, visible)
  const [showUntracked, setShowUntracked] = useState(false)
  const remove = (path: string) =>
    projectMemberOp(folderId, "rm", { path }).catch((error: unknown) =>
      toast.error(t("removeReferenceFailed", { message: errorText(error) }))
    )
  const join = (path: string) =>
    projectMemberOp(folderId, "join", { path }).then(onJoined, (error) =>
      toast.error(t("joinFailed", { message: errorText(error) }))
    )

  return (
    <>
      {untracked.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowUntracked((show) => !show)}
          className="block h-6 w-full truncate rounded-md text-left text-xs text-muted-foreground hover:text-foreground"
          style={{ paddingLeft: sessionIndent(false) }}
          title={t("untrackedHint")}
        >
          {showUntracked
            ? t("hideUntracked")
            : t("showUntracked", { count: untracked.length })}
        </button>
      ) : null}
      {showUntracked
        ? untracked.map(({ path, branch }) => (
            <MemberRow
              key={path}
              folderId={null}
              name={baseName(path)}
              path={`${path}\n${t("untrackedHint")}`}
              branch={branch}
              worktree
              icon={<GitBranch className="h-3.5 w-3.5 text-muted-foreground" />}
              selected={false}
              sessions={NO_SESSIONS}
              // 只有行尾「+」加入，误点不改成员
              onSelect={() => {}}
              onOpenSession={() => {}}
              actions={{}}
              hover={
                <HoverButton label={t("join")} onClick={() => void join(path)}>
                  <Plus className="size-3.5" />
                </HoverButton>
              }
            />
          ))
        : null}
      {references.length > 0 ? (
        <div
          className="flex h-6 items-center text-xs text-muted-foreground"
          style={{ paddingLeft: sessionIndent(false) }}
        >
          <span className="min-w-0 flex-1 truncate">{t("references")}</span>
        </div>
      ) : null}
      {references.map((path) => (
        <MemberRow
          key={path}
          folderId={null}
          name={baseName(path)}
          path={`${path}\n${t("referenceHint")}`}
          branch={null}
          worktree={false}
          icon={<BookOpen className="h-3.5 w-3.5 text-muted-foreground" />}
          selected={browsing === path}
          sessions={NO_SESSIONS}
          onSelect={() => onBrowse(browsing === path ? null : path)}
          onOpenSession={() => {}}
          actions={{}}
          hover={
            <>
              <HoverButton
                label={t("terminalHere")}
                onClick={() => onOpenTerminal(path)}
              >
                <SquareTerminal className="size-3.5" />
              </HoverButton>
              <HoverButton
                label={t("removeReference")}
                onClick={() => {
                  if (browsing === path) onBrowse(null)
                  void remove(path)
                }}
              >
                <X className="size-3.5" />
              </HoverButton>
            </>
          }
        />
      ))}
    </>
  )
}
