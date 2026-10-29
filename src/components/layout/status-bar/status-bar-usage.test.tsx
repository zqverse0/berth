import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"

const readAccountUsageMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/transport/usage", () => ({
  readAccountUsage: readAccountUsageMock,
}))

vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfilesStore: (
    selector: (state: { agents: unknown[] }) => unknown
  ) => selector({ agents: [] }),
}))

import { StatusBarUsage } from "@/components/layout/status-bar/status-bar-usage"

function renderUsage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarUsage />
    </NextIntlClientProvider>
  )
}

describe("StatusBarUsage", () => {
  beforeEach(() => {
    readAccountUsageMock.mockReset()
  })

  it("renders nothing when all agents are missing (not signed in)", async () => {
    readAccountUsageMock.mockResolvedValue([
      { subject: "codex", status: "missing", windows: [], diagnostics: [] },
    ])
    const { container } = renderUsage()
    // 等 useEffect 的首查完成
    await vi.waitFor(() => expect(readAccountUsageMock).toHaveBeenCalled())
    expect(
      container.querySelector("[data-berth-status-usage-trigger]")
    ).toBeNull()
  })

  it("renders a badge with the max window percent for a ready agent", async () => {
    readAccountUsageMock.mockResolvedValue([
      {
        subject: "codex",
        status: "ready",
        planType: null,
        windows: [
          { id: "session", label: "5h", usedPercent: 42 },
          { id: "weekly", label: "7d", usedPercent: 71 },
        ],
        diagnostics: [],
      },
    ])
    renderUsage()
    await vi.waitFor(() => {
      const trigger = screen.getByLabelText("Account usage")
      // 徽章形态:图标 + 迷你进度条 + 最紧窗口的百分比;agent 名只在悬停提示里。
      expect(trigger.querySelector('[title="codex"]')).not.toBeNull()
      expect(trigger.textContent).toContain("71%")
      const bar = trigger.querySelector("[data-usage-bar], .h-\\[6px\\]")
      expect(bar).not.toBeNull()
    })
  })

  it("opens popover with detailed agent usage info and no jump buttons", async () => {
    const { fireEvent } = await import("@testing-library/react")
    readAccountUsageMock.mockResolvedValue([
      {
        subject: "codex",
        status: "ready",
        planType: "Pro",
        windows: [{ id: "session", label: "5h", usedPercent: 40 }],
        diagnostics: [],
      },
      {
        subject: "gemini",
        status: "missing",
        planType: null,
        windows: [],
        diagnostics: [],
      },
    ])
    renderUsage()
    await vi.waitFor(() => {
      expect(screen.getByLabelText("Account usage")).toBeDefined()
    })

    const trigger = screen.getByLabelText("Account usage")
    fireEvent.click(trigger)

    // 弹层已展开，检查详细信息
    const content = document.querySelector("[data-berth-status-usage-content]")
    expect(content).not.toBeNull()
    // 渲染了就绪的 codex 详细窗口与信息
    expect(content?.textContent).toContain("codex")
    expect(content?.textContent).toContain("5h")
    expect(content?.textContent).toContain("40%")

    // 验证：未登录的 gemini 不被打扰渲染进用量列表
    expect(content?.textContent).not.toContain("gemini")

    // 验证：不包含多余的管理跳转按钮或双选项控制器
    expect(screen.queryByText("Manage Agents & Providers")).toBeNull()
    expect(screen.queryByText("Compact")).toBeNull()
  })

  it("retains previous window values under SWR when a transient error occurs", async () => {
    const { fireEvent } = await import("@testing-library/react")
    readAccountUsageMock.mockResolvedValueOnce([
      {
        subject: "grok",
        status: "ready",
        planType: "Super",
        windows: [{ id: "weekly", label: "7d", usedPercent: 55 }],
        diagnostics: [],
      },
    ])
    renderUsage()
    await vi.waitFor(() => {
      const trigger = screen.getByLabelText("Account usage")
      expect(trigger.textContent).toContain("55%")
    })

    // 发生网络故障，返回 error 状态
    readAccountUsageMock.mockResolvedValueOnce([
      {
        subject: "grok",
        status: "error",
        planType: null,
        windows: [],
        diagnostics: [
          { severity: "error", message: "error sending request for url" },
        ],
      },
    ])

    // 打开弹层即强刷
    const trigger = screen.getByLabelText("Account usage")
    fireEvent.click(trigger)

    // SWR 容错：依然保留 55% 的进度条，而不是把触发器打成红警叹号
    await vi.waitFor(() => {
      expect(trigger.textContent).toContain("55%")
      const content = document.querySelector(
        "[data-berth-status-usage-content]"
      )
      expect(content?.textContent).toContain("error sending request for url")
    })
  })

  it("throttles visibilitychange events within STALE_MS", async () => {
    readAccountUsageMock.mockResolvedValue([
      {
        subject: "codex",
        status: "ready",
        planType: null,
        windows: [{ id: "session", label: "5h", usedPercent: 30 }],
        diagnostics: [],
      },
    ])
    renderUsage()
    await vi.waitFor(() =>
      expect(readAccountUsageMock).toHaveBeenCalledTimes(1)
    )

    // 模拟切屏回来触发 visibilitychange
    const event = new Event("visibilitychange")
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    })
    document.dispatchEvent(event)

    // 在 2 分钟保鲜期内，不应发起二次请求
    expect(readAccountUsageMock).toHaveBeenCalledTimes(1)
  })
})
