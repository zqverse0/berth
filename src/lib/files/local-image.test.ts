import { describe, expect, it, vi } from "vitest"
import * as api from "@/lib/api"
import { loadLocalImageDataUrl } from "./local-image"

// data URL 前缀 "data:image/png;base64," 22 字符；20 MB 的 base64 三张即超 64 MB 上限
const MB = 1024 * 1024
const PREFIX = "data:image/png;base64,".length

describe("loadLocalImageDataUrl", () => {
  it("evicts the least recently used once total chars exceed the cap", async () => {
    const read = vi
      .spyOn(api, "readFileBase64")
      .mockResolvedValue("A".repeat(20 * MB - PREFIX))
    await loadLocalImageDataUrl("/a.png")
    await loadLocalImageDataUrl("/b.png")
    await loadLocalImageDataUrl("/c.png")
    await loadLocalImageDataUrl("/a.png") // 命中并移到最新
    await loadLocalImageDataUrl("/d.png") // 80 MB > 64 MB，挤掉最旧的 /b.png
    read.mockClear()
    await loadLocalImageDataUrl("/a.png")
    await loadLocalImageDataUrl("/c.png")
    await loadLocalImageDataUrl("/d.png")
    expect(read).not.toHaveBeenCalled()
    await loadLocalImageDataUrl("/b.png")
    expect(read).toHaveBeenCalledWith("/b.png")
    read.mockRestore()
  })

  it("returns but does not cache an image larger than the cap", async () => {
    const huge = "A".repeat(65 * MB)
    const read = vi.spyOn(api, "readFileBase64").mockResolvedValue(huge)
    expect(await loadLocalImageDataUrl("/huge.png")).toBe(
      `data:image/png;base64,${huge}`
    )
    await loadLocalImageDataUrl("/huge.png")
    expect(read).toHaveBeenCalledTimes(2)
    read.mockRestore()
  })
})
