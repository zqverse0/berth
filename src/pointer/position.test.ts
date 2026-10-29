import { describe, expect, it } from "vitest"
import { computeMenuPosition } from "./position"

describe("computeMenuPosition", () => {
  const viewport = { width: 1000, height: 800 }
  const menuSize = { width: 300, height: 36 }

  it("centers menu horizontally above anchor when there is plenty of room", () => {
    const anchor = { left: 400, top: 300, right: 600, bottom: 320 }
    const pos = computeMenuPosition(anchor, menuSize, viewport)

    // Center X is (400 + 600) / 2 = 500.
    // Left edge = 500 - 300 / 2 = 350.
    expect(pos.left).toBe(350)
    // Top edge = anchor.top (300) - gap (8) - height (36) = 256.
    expect(pos.top).toBe(256)
    expect(pos.placement).toBe("above")
  })

  it("shifts menu leftward when anchor is near the right edge of viewport", () => {
    // Selection at far right: [900, 990]
    const anchor = { left: 900, top: 400, right: 990, bottom: 420 }
    const pos = computeMenuPosition(anchor, menuSize, viewport)

    // Unclamped left would be ((900 + 990) / 2) - 150 = 945 - 150 = 795, which would push right edge to 1095 > 1000.
    // Clamped left = 1000 - 300 - 12 = 688.
    expect(pos.left).toBe(688)
    expect(pos.left + menuSize.width).toBe(viewport.width - 12)
    expect(pos.placement).toBe("above")
  })

  it("shifts menu rightward when anchor is near the left edge of viewport", () => {
    // Selection at far left: [0, 50]
    const anchor = { left: 0, top: 400, right: 50, bottom: 420 }
    const pos = computeMenuPosition(anchor, menuSize, viewport)

    // Unclamped left would be 25 - 150 = -125.
    // Clamped left = margin = 12.
    expect(pos.left).toBe(12)
    expect(pos.placement).toBe("above")
  })

  it("respects minTop so the menu cannot cover a tab strip", () => {
    const anchor = { left: 400, top: 80, right: 600, bottom: 80 }
    const pos = computeMenuPosition(anchor, menuSize, viewport, {
      forcePlacement: "above",
      minTop: 40,
    })
    expect(pos.top).toBeGreaterThanOrEqual(40)
  })

  it("can force above even when there is not enough room", () => {
    const anchor = { left: 400, top: 10, right: 600, bottom: 30 }
    const pos = computeMenuPosition(anchor, menuSize, viewport, {
      forcePlacement: "above",
    })
    expect(pos.placement).toBe("above")
    expect(pos.top).toBe(12)
  })

  it("flips menu below anchor when there is not enough room above", () => {
    // Selection near the top: top = 10, bottom = 30
    const anchor = { left: 400, top: 10, right: 600, bottom: 30 }
    const pos = computeMenuPosition(anchor, menuSize, viewport)

    // Room above = 10 - 12 = -2 < (36 + 8).
    // Room below = 800 - 30 - 12 = 758.
    expect(pos.placement).toBe("below")
    // Top = anchor.bottom (30) + gap (8) = 38.
    expect(pos.top).toBe(38)
    expect(pos.left).toBe(350)
  })

  it("keeps menu above when near the bottom of viewport", () => {
    // Selection near bottom: top = 760, bottom = 780
    const anchor = { left: 400, top: 760, right: 600, bottom: 780 }
    const pos = computeMenuPosition(anchor, menuSize, viewport)

    expect(pos.placement).toBe("above")
    expect(pos.top).toBe(760 - 8 - 36)
  })

  it("handles a single point anchor (e.g. contextmenu click event)", () => {
    const pointAnchor = { left: 980, top: 780, right: 980, bottom: 780 }
    const pos = computeMenuPosition(pointAnchor, menuSize, viewport)

    // Clamped horizontally to right margin: 1000 - 300 - 12 = 688
    expect(pos.left).toBe(688)
    // Sits above click point: 780 - 8 - 36 = 736
    expect(pos.top).toBe(736)
    expect(pos.placement).toBe("above")
  })

  it("handles larger elements like translate dialog smoothly", () => {
    const translateSize = { width: 320, height: 260 }
    // Near bottom right: [850, 950], top 700, bottom 720
    const anchor = { left: 850, top: 700, right: 950, bottom: 720 }
    const pos = computeMenuPosition(anchor, translateSize, viewport)

    // Clamped horizontally: 1000 - 320 - 12 = 668
    expect(pos.left).toBe(668)
    // Above anchor: 700 - 8 - 260 = 432
    expect(pos.top).toBe(432)
    expect(pos.placement).toBe("above")
  })

  it("handles narrow viewports gracefully without crashing", () => {
    const tinyViewport = { width: 250, height: 500 }
    const anchor = { left: 50, top: 200, right: 100, bottom: 220 }
    const pos = computeMenuPosition(anchor, menuSize, tinyViewport)

    expect(pos.left).toBe(12)
    expect(pos.top).toBe(200 - 8 - 36)
  })
})
