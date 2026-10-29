import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentProfileSummary } from "@/lib/transport/launchbar"

const mocks = vi.hoisted(() => ({
  agents: [] as AgentProfileSummary[],
  refresh: vi.fn(async () => {}),
}))

vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfiles: () => ({
    agents: mocks.agents,
    directory: "/tools",
    fresh: true,
    loading: false,
    error: null,
    refresh: mocks.refresh,
  }),
}))

import { useSortedAvailableAgents } from "./use-sorted-available-agents"

function profile(id: string, projectType: string | null): AgentProfileSummary {
  return {
    id,
    name: id,
    icon: null,
    description: null,
    projectType,
  }
}

describe("useSortedAvailableAgents", () => {
  beforeEach(() => {
    mocks.agents = []
    mocks.refresh.mockClear()
    window.localStorage.clear()
  })

  it("uses agent.json projectType as its only live Agent source", () => {
    mocks.agents = [
      profile("custom", "my_agent"),
      profile("claude", "claude_code"),
      profile("codex", "codex"),
    ]

    const { result } = renderHook(() => useSortedAvailableAgents())

    // 按插件名排序，没有品牌偏好表；未知 projectType（my_agent）照常出现。
    expect(result.current.sortedTypes).toEqual([
      "claude_code",
      "codex",
      "my_agent",
    ])
    expect(result.current.agents.map((agent) => agent.id)).toEqual([
      "claude",
      "codex",
      "custom",
    ])
    expect(result.current.fresh).toBe(true)
    expect(result.current.refresh).toBe(mocks.refresh)
  })
})
