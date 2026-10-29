import { beforeEach, describe, expect, it, vi } from "vitest"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { mergeGroupEvents, postToMember, type GroupEvent } from "./berth-group"
vi.mock("@/lib/runtime-bridge", () => ({
  runtimeBridgeOperation: vi.fn().mockResolvedValue({ ok: true, result: {} }),
}))
beforeEach(() => vi.clearAllMocks())
describe("postToMember", () => {
  it("sends quoted messages through group.post with replyTo", async () => {
    await postToMember(7, "g", "a", "answer", "gui-test", 4)
    expect(runtimeBridgeOperation).toHaveBeenCalledWith({
      method: "group.post",
      folderId: 7,
      params: {
        name: "g",
        author: "user",
        to: "a",
        text: "answer",
        idempotencyKey: "gui-test:a",
        replyTo: 4,
      },
    })
  })
  it("leaves unquoted messages unchanged", async () => {
    await postToMember(7, "g", "a", "instruction", "gui-test")
    expect(runtimeBridgeOperation).toHaveBeenCalledWith({
      method: "group.post",
      folderId: 7,
      params: {
        name: "g",
        author: "user",
        to: "a",
        text: "instruction",
        idempotencyKey: "gui-test:a",
      },
    })
  })
})

function event(seq: number, text: string): GroupEvent {
  return {
    schema_version: 1,
    seq,
    timestamp_ms: seq,
    kind: "message",
    text,
  }
}

describe("mergeGroupEvents", () => {
  it("merges incremental reads by sequence", () => {
    const merged = mergeGroupEvents(
      [event(1, "hello"), event(2, "old")],
      [event(2, "updated"), event(3, "next")]
    )
    expect(merged.map((item) => [item.seq, item.text])).toEqual([
      [1, "hello"],
      [2, "updated"],
      [3, "next"],
    ])
  })
})
