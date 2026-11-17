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

describe("detail 淘汰", () => {
  afterEach(() => {
    act(() => resetConversationRuntimeStore())
    getFolderConversationMock.mockReset()
  })

  const cached = (id: number) =>
    useConversationRuntimeStore.getState().byConversationId.get(id)?.detail ??
    null

  it("显示中的不删，关掉后只留最近 3 个", async () => {
    getFolderConversationMock.mockImplementation(async () => makeDetail())
    const views = [1, 2, 3, 4, 5].map((id) =>
      renderHook(() => useConversationDetail(id))
    )
    await act(async () => {})
    expect([1, 2, 3, 4, 5].every((id) => cached(id))).toBe(true)

    // 依次关掉 1–4：1 被挤出，2、3、4 留着；5 仍在显示
    for (const view of views.slice(0, 4)) act(() => view.unmount())
    expect(cached(1)).toBeNull()
    expect([2, 3, 4, 5].every((id) => cached(id))).toBe(true)

    act(() => views[4].unmount())
    expect(cached(2)).toBeNull()
    expect([3, 4, 5].every((id) => cached(id))).toBe(true)
  })

  it("被淘汰后再显示会重拉", async () => {
    getFolderConversationMock.mockImplementation(async () => makeDetail())
    const first = renderHook(() => useConversationDetail(9))
    await act(async () => {})
    act(() => first.unmount())
    // 再关掉 3 个别的会话，9 被挤出
    for (const id of [10, 11, 12]) {
      const other = renderHook(() => useConversationDetail(id))
      await act(async () => {})
      act(() => other.unmount())
    }
    expect(cached(9)).toBeNull()

    const again = renderHook(() => useConversationDetail(9))
    await act(async () => {})
    expect(again.result.current.detail).not.toBeNull()
    expect(
      getFolderConversationMock.mock.calls.filter(([id]) => id === 9)
    ).toHaveLength(2)
    act(() => again.unmount())
  })
})
