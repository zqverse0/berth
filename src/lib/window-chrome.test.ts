import { describe, expect, it } from "vitest"

import {
  ACTIVITY_BAR_WIDTH,
  MAC_TRAFFIC_LIGHT_INSET,
  RIGHT_CHROME_CLUSTER,
  WINDOW_CAPTION_WIDTH,
  leftChromeReserve,
  rightChromeClusterWidth,
  rightChromeReserve,
} from "./window-chrome"

// The app "zoom" scales the root font-size (rem), so the rem-sized chrome buttons
// grow with zoom. Their fixed-px containers must grow by the same factor or the
// buttons overflow/clip at high zoom (the 150% bug). These guard that only the
// DOM button CLUSTER scales, while the native insets (macOS traffic-light
// clearance, Windows/Linux caption strip) stay fixed.
describe("window-chrome zoom scaling", () => {
  it("defaults to 100% (no scaling) and matches the pre-zoom baseline", () => {
    // Baseline the aux-panel collapse test also hard-codes: 80 (mac/web) and
    // 80 + 138 = 218 (win/linux caption reserved).
    expect(rightChromeReserve(false)).toBe(RIGHT_CHROME_CLUSTER)
    expect(rightChromeReserve(true)).toBe(
      RIGHT_CHROME_CLUSTER + WINDOW_CAPTION_WIDTH
    )
    expect(rightChromeClusterWidth()).toBe(RIGHT_CHROME_CLUSTER)
    // Left edge belongs to the ActivityBar; only uncovered traffic lights remain.
    expect(leftChromeReserve(false)).toBe(0)
    expect(leftChromeReserve(true)).toBe(
      MAC_TRAFFIC_LIGHT_INSET - ACTIVITY_BAR_WIDTH
    )
  })

  it("scales only the button cluster at 150%, leaving native insets fixed", () => {
    // Right cluster is 80 → 120; left cluster is 108 → 162.
    expect(rightChromeClusterWidth(150)).toBe(120)
    expect(rightChromeReserve(false, 150)).toBe(120)
    // Native caption strip stays 138.
    expect(rightChromeReserve(true, 150)).toBe(120 + WINDOW_CAPTION_WIDTH)
    // Activity bar grows 48 → 72 and covers the 76px traffic lights but 4px.
    expect(leftChromeReserve(false, 150)).toBe(0)
    expect(leftChromeReserve(true, 150)).toBe(4)
  })

  it("scales the cluster down below 100% too and rounds to whole pixels", () => {
    // 80 * 0.9 = 72
    expect(rightChromeClusterWidth(90)).toBe(72)
    // Activity bar shrinks to 24, leaving 76 - 24 = 52 of traffic lights.
    expect(leftChromeReserve(true, 50)).toBe(52)
  })
})
