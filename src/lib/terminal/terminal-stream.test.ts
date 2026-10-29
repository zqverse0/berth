import { describe, expect, it } from "vitest"
import {
  decodeBase64,
  encodeBase64,
  EventQueue,
  snapshotFromWire,
} from "./terminal-stream"

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

describe("Tauri terminal boundary helpers", () => {
  it("round-trips binary through encode/decode", () => {
    const input = bytes("hello\0world")
    expect(decode(decodeBase64(encodeBase64(input)))).toBe("hello\0world")
  })

  it("decodes the local Tauri snapshot boundary", () => {
    const snap = snapshotFromWire({
      terminalId: "t1",
      backendInstanceId: "b1",
      sequence: 4,
      rows: 24,
      cols: 80,
      ansiBase64: encodeBase64(bytes("prompt$ ")),
      historyTruncated: false,
      status: "running",
      exitCode: null,
      exitedAt: null,
      lastKnownCwd: "/tmp",
    })
    expect(snap.sequence).toBe(4)
    expect(decode(snap.ansi)).toBe("prompt$ ")
    expect(snap.lastKnownCwd).toBe("/tmp")
  })
})

describe("EventQueue", () => {
  it("delivers pushed events in order", async () => {
    const q = new EventQueue<number>()
    q.push(1)
    q.push(2)
    const iter = q[Symbol.asyncIterator]()
    expect(await iter.next()).toEqual({ value: 1, done: false })
    expect(await iter.next()).toEqual({ value: 2, done: false })
    q.close()
    expect(await iter.next()).toEqual({ value: undefined, done: true })
  })
})
