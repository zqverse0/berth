import { describe, expect, it } from "vitest"

import {
  formatResetDuration,
  formatUsageWindowLine,
  usageWindowParts,
} from "@/lib/agent/usage-window"

/** 用正则替换的极简翻译器，模拟 next-intl 的插值。 */
const t = (key: string, values?: Record<string, string | number>) => {
  const templates: Record<string, string> = {
    usedFormat: "Used {value} {unit}",
    remainingFormat: "{value} {unit} left",
    usageWithAbsoluteFormat: "{percent} ({absolute})",
    resetCountdown: "Resets in {duration}",
  }
  const template = templates[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? "")
  )
}

describe("usageWindowParts", () => {
  it("shows the percentage when only a percentage exists", () => {
    expect(
      usageWindowParts({ id: "a", label: "5h", usedPercent: 42 }, t)
    ).toEqual({
      usage: "42%",
      reset: null,
    })
  })

  it("shows absolute used when upstream gives no percentage", () => {
    const parts = usageWindowParts(
      { id: "a", label: "30d", used: 2, unit: "credits" },
      t
    )
    expect(parts.usage).toBe("Used 2 credits")
  })

  it("shows remaining for balance-style windows", () => {
    const parts = usageWindowParts(
      { id: "a", label: "Balance", remaining: 10.5, unit: "tokens" },
      t
    )
    expect(parts.usage).toBe("10.50 tokens left")
  })

  it("keeps both when a percentage and an absolute value exist", () => {
    const parts = usageWindowParts(
      {
        id: "a",
        label: "7d",
        usedPercent: 71,
        remaining: 10.5,
        unit: "tokens",
      },
      t
    )
    expect(parts.usage).toBe("71% (10.50 tokens left)")
  })

  it("reports reset only while it is in the future", () => {
    const now = Date.now()
    expect(
      usageWindowParts(
        { id: "a", label: "5h", usedPercent: 10, resetsAt: now + 7_200_000 },
        t,
        now
      ).reset
    ).toBe("Resets in 2h")
    expect(
      usageWindowParts(
        { id: "a", label: "5h", usedPercent: 10, resetsAt: now - 1000 },
        t,
        now
      ).reset
    ).toBeNull()
  })

  it("formats one deterministic line per window", () => {
    const now = Date.now()
    expect(
      formatUsageWindowLine(
        {
          id: "a",
          label: "30d",
          used: 2,
          unit: "credits",
          resetsAt: now + 3 * 86_400_000,
        },
        t,
        now
      )
    ).toBe("30d · Used 2 credits · Resets in 3d")
  })
})

describe("formatResetDuration", () => {
  it("covers minutes, hours and days", () => {
    expect(formatResetDuration(45 * 60_000)).toBe("45m")
    expect(formatResetDuration(2 * 3_600_000 + 10 * 60_000)).toBe("2h 10m")
    expect(formatResetDuration(3 * 3_600_000)).toBe("3h")
    expect(formatResetDuration(2 * 86_400_000 + 5 * 3_600_000)).toBe("2d 5h")
    expect(formatResetDuration(86_400_000)).toBe("1d")
    expect(formatResetDuration(0)).toBeNull()
  })
})
