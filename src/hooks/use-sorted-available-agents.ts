"use client"

import { useEffect, useMemo } from "react"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import type { AgentType } from "@/lib/types"

const STORAGE_KEY = "workspace:sorted-available-agents"

function readSeed(): AgentType[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is AgentType => typeof v === "string")
  } catch {
    // Corrupted storage — treat as empty.
    return []
  }
}

function writeSeed(types: AgentType[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(types))
  } catch {
    // Quota exceeded or storage disabled — ignore.
  }
}

// Module-level seed snapshot read once at import. Avoids re-reading
// localStorage on every consumer mount and gives a synchronous default
// even before the first profile list reload resolves.
const initialSeed: AgentType[] = readSeed()

export interface UseSortedAvailableAgentsResult {
  /** Known agent profiles (id = tools directory name). */
  agents: AgentProfileProjection[]
  /**
   * Known projected Agent types in the shared display order. While the first
   * profile list call is in flight, this falls back to the last persisted
   * snapshot from localStorage. Empty array means no usable agents are known
   * yet.
   */
  sortedTypes: AgentType[]
  /** True once the first successful reload has completed this session. */
  fresh: boolean
  refresh: () => Promise<void>
}

/** tool.json agent profile projected onto the AgentType-based surfaces. */
export interface AgentProfileProjection {
  agentType: AgentType
  /** tools 目录名（= 启动主键）。 */
  id: string
  name: string
}

/**
 * Thin wrapper over `useAgentProfiles()` that projects each profile's
 * `projectType` (any string — file-driven, no frontend allow-list) and
 * persists the result so cold starts have a synchronous (if possibly stale)
 * seed.
 *
 * Used by both TabProvider (to resolve default agents for new draft tabs),
 * the project tab (agent availability), and Settings Skills/MCP matrices.
 */
export function useSortedAvailableAgents(): UseSortedAvailableAgentsResult {
  const { agents: profiles, fresh, refresh } = useAgentProfiles()

  const agents = useMemo(() => {
    const index = new Map<string, AgentProfileProjection>()
    for (const profile of profiles) {
      const agentType = profile.projectType
      if (!agentType) continue
      if (!index.has(agentType)) {
        index.set(agentType, {
          agentType,
          id: profile.id,
          name: profile.name,
        })
      }
    }
    // 按插件名排序，不维护品牌偏好表；用户拖拽排序另存。
    return [...index.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.agentType.localeCompare(right.agentType)
    )
  }, [profiles])

  const liveSortedTypes = useMemo(
    () => agents.map((agent) => agent.agentType),
    [agents]
  )

  // While not fresh, expose the localStorage seed so consumers can
  // resolve a sensible default without waiting on the API. Once fresh,
  // the live list takes over even if it temporarily shrinks (e.g. an
  // agent.json was removed).
  const sortedTypes = fresh ? liveSortedTypes : initialSeed

  useEffect(() => {
    if (!fresh) return
    writeSeed(liveSortedTypes)
  }, [fresh, liveSortedTypes])

  return { agents, sortedTypes, fresh, refresh }
}
