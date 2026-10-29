import { describe, expect, it, vi } from "vitest"
import { createTerminalWriteAdapter } from "./terminal-write-adapter"

describe("createTerminalWriteAdapter", () => {
  it("writes chunks directly without scheduling or merging", () => {
    const writes: Array<string | Uint8Array> = []
    const adapter = createTerminalWriteAdapter({
      write: (data) => writes.push(data),
    })

    adapter.write(new Uint8Array([0xe4, 0xbd]))
    adapter.write(new Uint8Array([0xa0]))

    expect(writes).toEqual([
      new Uint8Array([0xe4, 0xbd]),
      new Uint8Array([0xa0]),
    ])
  })

  it("maps applied callbacks to the matching xterm callbacks", () => {
    const callbacks: Array<() => void> = []
    const firstApplied = vi.fn()
    const secondApplied = vi.fn()
    const adapter = createTerminalWriteAdapter({
      write: (_data, callback) => {
        if (callback) callbacks.push(callback)
      },
    })

    adapter.write(new Uint8Array([1]), firstApplied)
    adapter.write(new Uint8Array([2]), secondApplied)
    expect(firstApplied).not.toHaveBeenCalled()
    expect(secondApplied).not.toHaveBeenCalled()

    callbacks[0]()
    expect(firstApplied).toHaveBeenCalledOnce()
    expect(secondApplied).not.toHaveBeenCalled()
    callbacks[1]()
    expect(secondApplied).toHaveBeenCalledOnce()
  })

  it("contains callback failures and keeps later writes alive", () => {
    const callbacks: Array<() => void> = []
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const failed = vi.fn(() => {
      throw new Error("metrics failed")
    })
    const later = vi.fn()
    const adapter = createTerminalWriteAdapter({
      write: (_data, callback) => {
        if (callback) callbacks.push(callback)
      },
    })

    adapter.write("first", failed)
    adapter.write("second", later)

    expect(() => callbacks[0]?.()).not.toThrow()
    callbacks[1]?.()

    expect(failed).toHaveBeenCalledOnce()
    expect(later).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      "[TerminalWriteAdapter] callback failed",
      expect.any(Error)
    )
    error.mockRestore()
    adapter.dispose()
  })

  it("places a callback fence after previously submitted writes", () => {
    const callbacks: Array<() => void> = []
    const fenced = vi.fn()
    const adapter = createTerminalWriteAdapter({
      write: (_data, callback) => {
        if (callback) callbacks.push(callback)
      },
    })

    adapter.write(new Uint8Array([1]), vi.fn())
    adapter.fence(fenced)
    callbacks[0]()
    expect(fenced).not.toHaveBeenCalled()
    callbacks[1]()
    expect(fenced).toHaveBeenCalledOnce()
  })

  it("does not acknowledge output that xterm never received", () => {
    const write = vi.fn()
    const applied = vi.fn()
    const adapter = createTerminalWriteAdapter({ write })

    adapter.dispose()
    adapter.write("late output", applied)

    expect(write).not.toHaveBeenCalled()
    expect(applied).not.toHaveBeenCalled()
  })

  it("forwards terminal control sequences without rewriting live output", () => {
    const writes: Uint8Array[] = []
    const adapter = createTerminalWriteAdapter({
      write: (data) => {
        writes.push(
          typeof data === "string" ? new TextEncoder().encode(data) : data
        )
      },
    })

    adapter.write("EARLY\x1b[3JRECENT")

    expect(new TextDecoder().decode(writes[0])).toBe("EARLY\x1b[3JRECENT")
  })

  it("keeps split writes independent", () => {
    const writes: Uint8Array[] = []
    const adapter = createTerminalWriteAdapter({
      write: (data) => {
        writes.push(
          typeof data === "string" ? new TextEncoder().encode(data) : data
        )
      },
    })

    adapter.write("EARLY\x1b[3")
    adapter.write("JRECENT")

    expect(writes.map((w) => new TextDecoder().decode(w)).join("")).toBe(
      "EARLY\x1b[3JRECENT"
    )
  })
})
