import { describe, expect, it } from "vitest"
import { decodeTauriTerminalPacket } from "./tauri-terminal-packet"

function packet(
  kind: number,
  sequenceStart: bigint,
  data: number[],
  sequenceEnd = sequenceStart
): ArrayBuffer {
  const bytes = new Uint8Array(20 + data.length)
  bytes.set([0x54, 0x56, 2, kind])
  const view = new DataView(bytes.buffer)
  view.setBigUint64(4, sequenceStart)
  view.setBigUint64(12, sequenceEnd)
  bytes.set(data, 20)
  return bytes.buffer
}

describe("decodeTauriTerminalPacket", () => {
  it("keeps raw output bytes and a sequence range", () => {
    const decoded = decodeTauriTerminalPacket(
      packet(1, 40n, [0xe4, 0xb8, 0xad], 42n)
    )

    expect(decoded).toEqual({
      type: "output",
      sequenceStart: 40,
      sequenceEnd: 42,
      data: new Uint8Array([0xe4, 0xb8, 0xad]),
    })
  })

  it("decodes a resync packet without inventing output", () => {
    expect(decodeTauriTerminalPacket(packet(2, 7n, []))).toEqual({
      type: "resync",
      sequence: 7,
    })
  })

  it("rejects truncated, unknown and unsafe packets", () => {
    expect(decodeTauriTerminalPacket(new ArrayBuffer(19))).toEqual({
      type: "invalid",
    })
    expect(decodeTauriTerminalPacket(packet(9, 1n, []))).toEqual({
      type: "invalid",
    })
    expect(
      decodeTauriTerminalPacket(
        packet(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n, [])
      )
    ).toEqual({ type: "invalid" })
    expect(decodeTauriTerminalPacket(packet(1, 8n, [], 7n))).toEqual({
      type: "invalid",
    })
  })

  it("rejects packets with an unknown magic or version", () => {
    const wrongMagic = packet(1, 1n, [])
    new Uint8Array(wrongMagic)[0] = 0
    expect(decodeTauriTerminalPacket(wrongMagic)).toEqual({ type: "invalid" })

    const wrongVersion = packet(1, 1n, [])
    new Uint8Array(wrongVersion)[2] = 1
    expect(decodeTauriTerminalPacket(wrongVersion)).toEqual({
      type: "invalid",
    })
  })

  it("accepts Uint8Array and number[] channel payloads", () => {
    const raw = packet(1, 9n, [0xe4, 0xb8, 0xad])
    expect(decodeTauriTerminalPacket(new Uint8Array(raw))).toEqual({
      type: "output",
      sequenceStart: 9,
      sequenceEnd: 9,
      data: new Uint8Array([0xe4, 0xb8, 0xad]),
    })
    expect(decodeTauriTerminalPacket(Array.from(new Uint8Array(raw)))).toEqual({
      type: "output",
      sequenceStart: 9,
      sequenceEnd: 9,
      data: new Uint8Array([0xe4, 0xb8, 0xad]),
    })
  })
})
