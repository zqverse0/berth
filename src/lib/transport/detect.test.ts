import { afterEach, describe, expect, it } from "vitest"
import { assertTauriEnvironment, detectEnvironment } from "./detect"

describe("detectEnvironment", () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    })
  })

  it("returns tauri when __TAURI_INTERNALS__ is present", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    })
    expect(detectEnvironment()).toBe("tauri")
    expect(() => assertTauriEnvironment()).not.toThrow()
  })

  it("returns unsupported outside Tauri without throwing", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    })
    expect(detectEnvironment()).toBe("unsupported")
    expect(() => assertTauriEnvironment()).toThrow(/desktop app runtime/i)
  })
})
