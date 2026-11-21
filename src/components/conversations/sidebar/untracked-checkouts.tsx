"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranch, Plus } from "lucide-react"
import { toast } from "@/lib/notify"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { sessionIndent } from "./project-row-face"
import { HoverButton, MemberRow } from "./member-row"
import type { SidebarSession } from "./sidebar-sessions"

const NO_SESSIONS: readonly SidebarSession[] = []

/** 成员视图在别处（项目菜单、成员菜单）变了：展开着的未加入提示重读。 */
const MEMBERS_CHANGED = "berth:project-members-changed"

/**
 * `project.member.*`：`folderId` 是项目里的成员。`join` 加入未登记的检出（`path`）；
 * `move` 改挂到项目（`project`）、`main` 设为主成员（`folderId` 即该成员）。
 */
export async function projectMemberOp(
  folderId: number,
  action: "join" | "move" | "main",
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
 * git 里还没加入的检出（与 `berth project . member ls` 同一份）：项目可见时现读，
 * 成员变动后重读。`folderId` 是项目里任一成员。
 */
function useUntracked(folderId: number, visible: boolean) {
  const [untracked, setUntracked] = useState<Untracked[]>([])
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void (async () => {
      const response = await runtimeBridgeOperation<{
        untracked: Untracked[]
      }>({ method: "project.member.ls", folderId })
      if (!cancelled && response.ok)
        setUntracked(response.result.untracked ?? [])
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
  return untracked
}

/**
 * 成员区末尾：收起的「未加入的 worktree」提示（git 里有、没登记进任何项目，逐个加入）。
 */
export function UntrackedCheckouts({
  folderId,
  visible,
  onJoined,
}: {
  folderId: number
  visible: boolean
  /** 加入了一个检出：重读成员。 */
  onJoined: () => void
}) {
  const t = useTranslations("ProjectMembers")
  const untracked = useUntracked(folderId, visible)
  const [showUntracked, setShowUntracked] = useState(false)
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
    </>
  )
}
