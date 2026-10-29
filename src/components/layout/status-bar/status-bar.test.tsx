import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import { ActivityBar } from "@/components/layout/sidebar/activity-bar"
import { StatusBar } from "@/components/layout/status-bar/status-bar"

const demoProfiles = [
  {
    id: "claude",
    name: "Claude Code",
    icon: null,
    description: null,
    projectType: "claude",
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    icon: null,
    description: null,
    projectType: "codex",
  },
]

vi.mock("@/contexts/settings-workspace-context", () => ({
  useSettingsWorkspace: () => ({ openSettings: vi.fn() }),
}))
vi.mock("@/hooks/workspace/use-open-folder-picker", () => ({
  useOpenFolderPicker: () => ({
    openFolderPicker: vi.fn(),
    browserDialog: null,
  }),
}))

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))

vi.mock("@/hooks/use-agent-profiles", () => ({
  useAgentProfilesStore: (
    selector: (state: { agents: typeof demoProfiles }) => unknown
  ) => selector({ agents: demoProfiles }),
  useAgentProfiles: () => ({
    agents: demoProfiles,
    refresh: vi.fn(),
  }),
}))

vi.mock("@/lib/transport/usage", () => ({
  readAccountUsage: vi.fn().mockResolvedValue([
    {
      subject: "claude",
      status: "ready",
      planType: "Pro",
      windows: [{ id: "5h", label: "5h", usedPercent: 45 }],
      diagnostics: [],
    },
  ]),
}))

vi.mock("@/lib/transport/launchbar", () => ({
  launchbar: vi.fn().mockResolvedValue({
    type: "file",
    file: { agent: "claude", config: null, diagnostics: [] },
  }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolderId: 1,
    activeFolder: { id: 1, name: "my-app", path: "/workspace/my-app" },
  }),
}))

function renderStatusBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ActivityBar />
      <StatusBar />
    </NextIntlClientProvider>
  )
}

describe("StatusBar integration with LaunchShelf", () => {
  beforeEach(() => {
    localStorage.clear()
    useStatusBarLaunchStore.setState({ activeLaunchAgentId: null })
  })

  it("shows usage in the status bar and no agent launchers in the chrome", async () => {
    // 启动 Agent 只在辅助面板 tab 条的「+」里；活动栏与状态栏都不放启动器。
    const { container } = renderStatusBar()
    expect(await screen.findByText("45%")).toBeDefined()
    expect(container.querySelector("[data-agent-id]")).toBeNull()
  })

  it("does not render terminal launcher button in status bar (moved to right edge chrome)", () => {
    renderStatusBar()

    expect(screen.queryByRole("button", { name: "New Terminal" })).toBeNull()
  })

  it("renders status-bar context container on the left edge", () => {
    const { container } = renderStatusBar()
    const leftContainer = container.querySelector(
      ".flex.min-w-0.flex-1.items-center"
    )
    expect(leftContainer).toBeTruthy()
  })

  it("renders alerts trigger button at the start of the status bar", async () => {
    renderStatusBar()
    const alertsButton = await screen.findByRole("button", { name: "Alerts" })
    expect(alertsButton).toBeDefined()
  })

  it("renders alerts and read-only usage in one full-width bar", async () => {
    const { container } = renderStatusBar()
    const bar = container.querySelector("[data-slot='status-bar']")
    expect(bar).toBeTruthy()
    expect(bar?.contains(screen.getByRole("button", { name: "Alerts" }))).toBe(
      true
    )
    // Usage is read-only text here; the launcher button is not part of the bar.
    expect(await screen.findByText("45%")).toBeDefined()
    expect(bar?.querySelector("button[data-agent-id]")).toBeNull()
  })
})
