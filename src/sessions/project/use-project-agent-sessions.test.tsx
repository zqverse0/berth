import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CONVERSATION_CHANGED_EVENT,
  type ConversationChange,
  type ProjectAgentSessionPage,
} from "@/lib/types"
import { resetProjectSessionQueryCache } from "./cache"
import { useProjectAgentSessions } from "./use-project-agent-sessions"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  subscribe: vi.fn(),
  conversationChangeHandler: null as
    | ((change: ConversationChange) => void)
    | null,
}))

vi.mock("@/lib/api", () => ({
  listProjectAgentSessions: mocks.list,
  resolveProjectAgentSession: mocks.resolve,
}))

vi.mock("@/lib/platform", () => ({
  subscribe: mocks.subscribe,
}))

const emptyPage: ProjectAgentSessionPage = {
  items: [],
  nextCursor: null,
  scanComplete: true,
  sourceWarning: null,
}

describe("useProjectAgentSessions", () => {
  beforeEach(() => {
    resetProjectSessionQueryCache()
    mocks.list.mockReset().mockResolvedValue(emptyPage)
    mocks.resolve.mockReset()
    mocks.conversationChangeHandler = null
    mocks.subscribe
      .mockReset()
      .mockImplementation(
        (event: string, handler: (change: ConversationChange) => void) => {
          if (event === CONVERSATION_CHANGED_EVENT) {
            mocks.conversationChangeHandler = handler
          }
          return Promise.resolve(() => {})
        }
      )
  })

  it("does not query before an Agent is explicitly selected", async () => {
    const { rerender } = renderHook(
      ({ agentType }) =>
        useProjectAgentSessions({
          folderId: 7,
          agentType,
          query: "",
          enabled: true,
        }),
      { initialProps: { agentType: null as "codex" | null } }
    )

    await new Promise((resolve) => window.setTimeout(resolve, 300))
    expect(mocks.list).not.toHaveBeenCalled()

    rerender({ agentType: "codex" })
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))
    expect(mocks.list).toHaveBeenCalledWith({
      folderId: 7,
      agentType: "codex",
      cursor: null,
      search: null,
      refresh: false,
    })
  })

  it("reuses a loaded scope instead of repeating the first-page request", async () => {
    const options = {
      folderId: 7,
      agentType: "codex" as const,
      query: "",
      enabled: true,
    }
    const first = renderHook(() => useProjectAgentSessions(options))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    first.unmount()

    renderHook(() => useProjectAgentSessions(options))
    await new Promise((resolve) => window.setTimeout(resolve, 300))

    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it("upserts a newly-created Berth conversation from the shared event", async () => {
    const { result } = renderHook(() =>
      useProjectAgentSessions({
        folderId: 7,
        agentType: "codex",
        query: "",
        enabled: true,
      })
    )
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.conversationChangeHandler).not.toBeNull())

    act(() => {
      mocks.conversationChangeHandler?.({
        kind: "upsert",
        summary: {
          id: 9,
          folder_id: 7,
          title: "New session",
          title_locked: false,
          agent_type: "codex",
          kind: "regular",
          model: null,
          git_branch: null,
          external_id: "session-9",
          message_count: 0,
          child_count: 0,
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
          pinned_at: null,
        },
      })
    })

    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.items[0]).toMatchObject({
      conversationId: 9,
      externalId: "session-9",
      source: "database_only",
    })
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it("accumulates cursor pages without dropping existing identities", async () => {
    mocks.list
      .mockResolvedValueOnce({
        ...emptyPage,
        items: [
          {
            agentType: "codex",
            externalId: "s1",
            conversationId: null,
            conversation: null,
            title: "one",
            model: null,
            gitBranch: null,
            messageCount: 1,
            startedAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            source: "native_only",
            sourceAvailable: true,
          },
        ],
        nextCursor: "next",
        scanComplete: false,
      })
      .mockResolvedValueOnce({
        ...emptyPage,
        items: [
          {
            agentType: "codex",
            externalId: "s2",
            conversationId: null,
            conversation: null,
            title: "two",
            model: null,
            gitBranch: null,
            messageCount: 1,
            startedAt: "2026-01-02T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            source: "native_only",
            sourceAvailable: true,
          },
        ],
      })
    const { result } = renderHook(() =>
      useProjectAgentSessions({
        folderId: 7,
        agentType: "codex",
        query: "",
        enabled: true,
      })
    )

    await waitFor(() => expect(result.current.items).toHaveLength(1))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "next" })
    )
  })
})
