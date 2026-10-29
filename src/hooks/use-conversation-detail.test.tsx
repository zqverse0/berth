import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { useConversationDetail } from "./use-conversation-detail"

const getFolderConversationMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({
  getFolderConversation: getFolderConversationMock,
}))

const CID = 77

function seedSession(detail: DbConversationDetail | null) {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([
      [
        CID,
        {
          conversationId: CID,
          detail,
          detailLoading: false,
          detailError: null,
        },
      ],
    ]),
  })
}

const makeDetail = (): DbConversationDetail =>
  ({ summary: {}, turns: [] }) as unknown as DbConversationDetail

// `enabled: false` isolates the store subscription from the auto-fetch effect.
describe("useConversationDetail subscription", () => {
  // Reset can fire a store update while the hook is still mounted (before RTL
  // cleanup); wrap it in act to avoid an "update not wrapped in act" warning.
  afterEach(() => {
    act(() => resetConversationRuntimeStore())
    getFolderConversationMock.mockReset()
  })

  it("does not fetch while disabled, then fetches when activated", async () => {
    seedSession(null)
    getFolderConversationMock.mockResolvedValue(makeDetail())
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useConversationDetail(CID, { enabled }),
      { initialProps: { enabled: false } }
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(getFolderConversationMock).not.toHaveBeenCalled()

    await act(async () => {
      rerender({ enabled: true })
      await Promise.resolve()
    })
    expect(getFolderConversationMock).toHaveBeenCalledWith(CID)
  })

  it("re-renders and surfaces the new detail when detail actually changes", () => {
    seedSession(null)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConversationDetail(CID, { enabled: false })
    })
    const mounted = renders
    expect(result.current.detail).toBeNull()

    // A real detail transition (fetch success, etc.) must re-render consumers.
    const nextDetail = makeDetail()
    act(() => seedSession(nextDetail))

    expect(renders).toBe(mounted + 1)
    expect(result.current.detail).toBe(nextDetail)
  })
})
