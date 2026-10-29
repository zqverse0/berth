import { describe, expect, it } from "vitest"
import type {
  DbConversationSummary,
  ProjectAgentSessionSummary,
} from "@/lib/types"
import {
  applyConversationChangeToProjectSessions,
  mergeProjectAgentSessionRows,
} from "./reducer"

function conversation(
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 1,
    folder_id: 7,
    title: "Session",
    title_locked: false,
    agent_type: "codex",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: "external-1",
    message_count: 1,
    child_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pinned_at: null,
    ...overrides,
  }
}

function nativeRow(
  overrides: Partial<ProjectAgentSessionSummary> = {}
): ProjectAgentSessionSummary {
  return {
    agentType: "codex",
    externalId: "external-1",
    conversationId: null,
    conversation: null,
    title: "Native title",
    model: "native-model",
    gitBranch: "dev",
    messageCount: 4,
    startedAt: "2025-12-31T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "native_only",
    sourceAvailable: true,
    ...overrides,
  }
}

const scope = { folderId: 7, agentType: "codex", query: "" }

describe("project session reducer", () => {
  it("deduplicates native and database projections by provider identity", () => {
    const merged = applyConversationChangeToProjectSessions(
      [nativeRow()],
      { kind: "upsert", summary: conversation() },
      scope
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      conversationId: 1,
      externalId: "external-1",
      model: "native-model",
      source: "both",
      sourceAvailable: true,
    })
  })

  it("ignores conversations outside the exact project and Agent scope", () => {
    const current = [nativeRow()]
    const merged = applyConversationChangeToProjectSessions(
      current,
      { kind: "upsert", summary: conversation({ folder_id: 8, id: 2 }) },
      scope
    )

    expect(merged).toBe(current)
  })

  it("removes a deleted database identity", () => {
    const current = [nativeRow({ conversationId: 1, source: "both" })]
    const merged = applyConversationChangeToProjectSessions(
      current,
      { kind: "deleted", id: 1 },
      scope
    )

    expect(merged).toEqual([])
  })

  it("keeps the latest identity when cursor pages overlap", () => {
    const merged = mergeProjectAgentSessionRows(
      [nativeRow()],
      [nativeRow({ title: "Updated", updatedAt: "2026-01-02T00:00:00Z" })]
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].title).toBe("Updated")
  })
})
