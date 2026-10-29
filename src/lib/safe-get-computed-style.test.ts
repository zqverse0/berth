import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installSafeGetComputedStyle } from "./safe-get-computed-style"

describe("installSafeGetComputedStyle", () => {
  let originalMethod: typeof window.getComputedStyle

  beforeEach(() => {
    originalMethod = window.getComputedStyle
  })

  afterEach(() => {
    window.getComputedStyle = originalMethod
  })

  it("handles undefined, null and non-Element arguments gracefully without throwing", () => {
    installSafeGetComputedStyle()

    // Testing invalid arguments that previously crashed in pdfjs TextLayerBuilder
    expect(() => {
      const style = window.getComputedStyle(undefined as unknown as Element)
      expect(typeof style.getPropertyValue).toBe("function")
      expect(style.getPropertyValue("-moz-user-select")).toBe("")
    }).not.toThrow()

    expect(() => {
      const style = window.getComputedStyle(null as unknown as Element)
      expect(typeof style.getPropertyValue).toBe("function")
    }).not.toThrow()

    expect(() => {
      const style = window.getComputedStyle({} as unknown as Element)
      expect(typeof style.getPropertyValue).toBe("function")
    }).not.toThrow()
  })

  it("delegates to original getComputedStyle for valid Elements", () => {
    installSafeGetComputedStyle()

    const div = document.createElement("div")
    div.style.color = "red"
    document.body.appendChild(div)

    const style = window.getComputedStyle(div)
    expect(style).toBeDefined()
    expect(typeof style.getPropertyValue).toBe("function")

    div.remove()
  })

  it("is idempotent and does not wrap repeatedly", () => {
    installSafeGetComputedStyle()
    const firstWrapped = window.getComputedStyle
    installSafeGetComputedStyle()
    expect(window.getComputedStyle).toBe(firstWrapped)
  })
})
