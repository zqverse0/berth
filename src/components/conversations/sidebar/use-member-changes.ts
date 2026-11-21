"use client"

import { useEffect, useMemo, useState } from "react"
import { gitStatus } from "@/lib/api"
import { useWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"

interface MemberPath {
  id: number
  path: string
}

/**
 * 展开项目的各成员未提交改动数。当前成员跟工作区状态流（与文件面板共用同一份监视，不另开）；
 * 其余成员只在列表可见、成员或当前成员变化时各读一次 `git status`，不常驻监视。
 */
export function useMemberChanges(
  current: MemberPath | null,
  others: readonly MemberPath[],
  visible: boolean
): ReadonlyMap<number, number> {
  const { git } = useWorkspaceStateStore(
    visible ? (current?.path ?? null) : null
  )
  const [read, setRead] = useState<ReadonlyMap<number, number>>(new Map())
  // 以内容为键：父组件每次渲染给的数组都是新的。
  const key = others.map((member) => `${member.id}:${member.path}`).join("\n")

  useEffect(() => {
    if (!visible || !key) return
    let cancelled = false
    const members = key.split("\n").map((line) => {
      const at = line.indexOf(":")
      return { id: Number(line.slice(0, at)), path: line.slice(at + 1) }
    })
    void (async () => {
      // 逐个读：每个成员一个 git 进程，不一次全发。
      for (const member of members) {
        const count = await gitStatus(member.path).then(
          (entries) => entries.length,
          () => null
        )
        if (cancelled) return
        if (count != null)
          setRead((prev) =>
            prev.get(member.id) === count
              ? prev
              : new Map(prev).set(member.id, count)
          )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, visible, current?.id])

  return useMemo(() => {
    if (!current) return read
    return new Map(read).set(current.id, git.length)
  }, [current, git.length, read])
}
