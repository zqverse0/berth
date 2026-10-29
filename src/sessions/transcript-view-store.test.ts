import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail } from "@/lib/types"

const api = vi.hoisted(() => ({
  getFolderConversation: vi.fn(),
  getConversationSourceRevision: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

import {
  LIVE_POLL_MS,
  useTranscriptDetail,
  useTranscriptLiveSync,
  useTranscriptViewStore,
} from "./transcript-view-store"

const detail = (revision: string) =>
  ({ turns: [], source_revision: revision }) as unknown as DbConversationDetail

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("transcript live sync", () => {
  it("refetches only when the source revision changes, once per session", async () => {
    vi.useFakeTimers()
    api.getFolderConversation.mockResolvedValueOnce(detail("r1"))
    api.getConversationSourceRevision.mockResolvedValue("r1")

    const { unmount } = renderHook(() => {
      useTranscriptDetail(42)
      // 两个视图订阅同一会话，只应有一个轮询
      useTranscriptLiveSync(42)
      useTranscriptLiveSync(42)
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(useTranscriptViewStore.getState().details[42].source_revision).toBe(
      "r1"
    )

    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS))
    expect(api.getConversationSourceRevision).toHaveBeenCalledTimes(1)
    expect(api.getFolderConversation).toHaveBeenCalledTimes(1)

    api.getConversationSourceRevision.mockResolvedValue("r2")
    api.getFolderConversation.mockResolvedValueOnce(detail("r2"))
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS))
    expect(api.getFolderConversation).toHaveBeenCalledTimes(2)
    expect(useTranscriptViewStore.getState().details[42].source_revision).toBe(
      "r2"
    )

    unmount()
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3))
    expect(api.getConversationSourceRevision).toHaveBeenCalledTimes(2)
  })
})

describe("transcript reading level default", () => {
  it("uses the last chosen level for newly opened sessions and persists it", () => {
    const { updateView } = useTranscriptViewStore.getState()
    updateView(1, (view) => ({ ...view, level: "full" }))
    expect(window.localStorage.getItem("berth.transcript.level")).toBe("full")
    // 另一个会话只改筛选，不应改动默认模式
    updateView(2, (view) => ({ ...view, query: "x" }))
    expect(useTranscriptViewStore.getState().views[2].level).toBe("full")
    expect(window.localStorage.getItem("berth.transcript.level")).toBe("full")
  })
})
