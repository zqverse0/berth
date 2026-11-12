import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetTerminalWebglForTests,
  createTerminalWebglController,
  type WebglAddonLike,
} from "./terminal-webgl"

function fakeAddon() {
  let lose: (() => void) | null = null
  const addon = {
    activate: vi.fn(),
    dispose: vi.fn(),
    clearTextureAtlas: vi.fn(),
    onContextLoss: (listener: () => void) => {
      lose = listener
      return { dispose: () => (lose = null) }
    },
    loseContext: () => lose?.(),
  }
  return addon
}

function setup(options: { failLoad?: boolean } = {}) {
  const addons: ReturnType<typeof fakeAddon>[] = []
  const term = {
    loadAddon: vi.fn(() => {
      if (options.failLoad) throw new Error("WebGL2 not supported")
    }),
  }
  const createAddon = () =>
    Promise.resolve(() => {
      const addon = fakeAddon()
      addons.push(addon)
      return addon as unknown as WebglAddonLike
    })
  const controller = createTerminalWebglController(term, { createAddon })
  return { term, addons, controller }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  __resetTerminalWebglForTests()
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createTerminalWebglController", () => {
  it("loads WebGL only while visible and releases after a hidden grace period", async () => {
    const { term, addons, controller } = setup()
    controller.setVisible(false)
    await flush()
    expect(term.loadAddon).not.toHaveBeenCalled()

    controller.setVisible(true)
    await flush()
    expect(term.loadAddon).toHaveBeenCalledTimes(1)

    // 短暂切走再回来不重建
    controller.setVisible(false)
    await vi.advanceTimersByTimeAsync(1000)
    controller.setVisible(true)
    await flush()
    expect(addons[0].dispose).not.toHaveBeenCalled()
    expect(term.loadAddon).toHaveBeenCalledTimes(1)

    controller.setVisible(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(addons[0].dispose).toHaveBeenCalledTimes(1)
  })

  it("stays on DOM after an init failure and gives up globally after repeated failures", async () => {
    for (let i = 0; i < 3; i++) {
      const { term, controller } = setup({ failLoad: true })
      controller.setVisible(true)
      await flush()
      expect(term.loadAddon).toHaveBeenCalledTimes(1)
      // 本次挂载不再重试
      controller.setVisible(false)
      controller.setVisible(true)
      await flush()
      expect(term.loadAddon).toHaveBeenCalledTimes(1)
    }
    const { term, controller } = setup()
    controller.setVisible(true)
    await flush()
    expect(term.loadAddon).not.toHaveBeenCalled()
  })

  it("falls back on context loss and retries while still visible, up to a cap", async () => {
    const { term, addons, controller } = setup()
    controller.setVisible(true)
    await flush()
    for (let i = 0; i < 3; i++) {
      addons[i].loseContext()
      expect(addons[i].dispose).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000)
    }
    // 三次丢失后本次挂载留在 DOM
    expect(term.loadAddon).toHaveBeenCalledTimes(3)
  })

  it("evicts the least recently visible hidden terminal when contexts run out", async () => {
    const all = Array.from({ length: 6 }, () => setup())
    for (const { controller } of all) {
      controller.setVisible(true)
      await flush()
      controller.setVisible(false)
    }
    const next = setup()
    next.controller.setVisible(true)
    await flush()
    expect(all[0].addons[0].dispose).toHaveBeenCalledTimes(1)
    expect(all[1].addons[0].dispose).not.toHaveBeenCalled()
    expect(next.term.loadAddon).toHaveBeenCalledTimes(1)
  })

  it("leaves extra terminals on DOM when every context is visible", async () => {
    for (let i = 0; i < 6; i++) {
      const { controller } = setup()
      controller.setVisible(true)
      await flush()
    }
    const extra = setup()
    extra.controller.setVisible(true)
    await flush()
    expect(extra.term.loadAddon).not.toHaveBeenCalled()
  })

  it("honours the DOM debug switch", async () => {
    localStorage.setItem("berth.terminal.renderer", "dom")
    const { term, controller } = setup()
    controller.setVisible(true)
    await flush()
    expect(term.loadAddon).not.toHaveBeenCalled()
  })

  it("clears the atlas on refresh and releases on dispose", async () => {
    const { addons, controller } = setup()
    controller.setVisible(true)
    await flush()
    controller.refreshAtlas()
    expect(addons[0].clearTextureAtlas).toHaveBeenCalledTimes(1)
    controller.dispose()
    expect(addons[0].dispose).toHaveBeenCalledTimes(1)
  })
})
