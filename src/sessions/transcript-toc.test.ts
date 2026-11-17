import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConversationToc, TocSegment } from "@/lib/types"

const api = vi.hoisted(() => ({
  getConversationToc: vi.fn(),
  getConversationParts: vi.fn(),
  getConversationRawTurns: vi.fn(),
  getConversationContext: vi.fn(),
  getConversationSourceRevision: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

import { loadToc, mergeToc, useTocStore, useTurnParts } from "./transcript-toc"

const segment = (id: string, start: number, end: number): TocSegment =>
  ({ id, start, end, index: 1, prompt: true, stats: {} }) as TocSegment

const toc = (
  generation: number,
  from: number,
  segments: TocSegment[]
): ConversationToc =>
  ({
    summary: { id: 1 },
    generation,
    from,
    turns: segments.at(-1)?.end ?? 0,
    segments,
    source_revision: `r${generation}-${from}`,
  }) as unknown as ConversationToc

describe("transcript toc", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTocStore.setState({ tocs: {}, contexts: {}, errors: {} })
  })

  it("接上第 from 段起的变化，generation 不同就整份换掉", () => {
    const first = toc(1, 0, [segment("a", 0, 3), segment("b", 3, 5)])
    const tail = toc(1, 1, [segment("b", 3, 7), segment("c", 7, 9)])
    expect(mergeToc(first, tail).segments.map((s) => [s.id, s.end])).toEqual([
      ["a", 3],
      ["b", 7],
      ["c", 9],
    ])
    const rebuilt = toc(2, 0, [segment("x", 0, 2)])
    expect(mergeToc(first, rebuilt)).toBe(rebuilt)
  })

  it("刷新只要最后一段起的变化", async () => {
    api.getConversationToc.mockResolvedValueOnce(
      toc(1, 0, [segment("a", 0, 3), segment("b", 3, 5)])
    )
    await loadToc(7)
    api.getConversationToc.mockResolvedValueOnce(
      toc(1, 1, [segment("b", 3, 6)])
    )
    await loadToc(7, true)
    expect(api.getConversationToc).toHaveBeenLastCalledWith(7, {
      generation: 1,
      from: 1,
    })
    expect(useTocStore.getState().tocs[7].segments.at(-1)?.end).toBe(6)
  })

  it("按轮取时 generation 对不上就重取整份目录", async () => {
    api.getConversationToc.mockResolvedValue(toc(2, 0, [segment("x", 0, 1)]))
    api.getConversationParts.mockResolvedValue({ generation: 2, turns: [] })
    renderHook(() => useTurnParts(8, 1, [0]))
    await waitFor(() =>
      expect(api.getConversationToc).toHaveBeenCalledWith(8, undefined)
    )
    expect(useTocStore.getState().tocs[8].generation).toBe(2)
  })

  it("取过的轮不再请求", async () => {
    api.getConversationParts.mockResolvedValue({
      generation: 3,
      turns: [{ entry: 0, id: "m0", role: "user", parts: [] }],
    })
    const first = renderHook(() => useTurnParts(9, 3, [0]))
    await waitFor(() => expect(first.result.current.turns?.size).toBe(1))
    const second = renderHook(() => useTurnParts(9, 3, [0]))
    expect(second.result.current.turns?.get(0)?.id).toBe("m0")
    expect(api.getConversationParts).toHaveBeenCalledTimes(1)
  })
})
