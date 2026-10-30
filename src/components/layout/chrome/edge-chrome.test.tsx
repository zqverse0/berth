import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { ActivityBar } from "@/components/layout/sidebar/activity-bar"
import { RightEdgeChrome } from "@/components/layout/chrome/right-edge-chrome"

const openSettingsMock = vi.fn()

vi.mock("@/contexts/settings-workspace-context", () => ({
  useSettingsWorkspace: () => ({
    openSettings: openSettingsMock,
  }),
}))

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    isMac: false,
    isWindows: false,
    isLinux: true,
  }),
}))

vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({
    zoomLevel: 100,
  }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { id: 42, path: "/test/project", name: "project" },
  }),
}))

describe("window edge chrome components", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("hosts sidebar toggle, views, open folder and settings in the ActivityBar", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ActivityBar />
      </NextIntlClientProvider>
    )

    const settingsButton = screen.getByRole("button", {
      name: /Settings/i,
    })
    expect(settingsButton).toBeDefined()

    await user.click(settingsButton)
    expect(openSettingsMock).toHaveBeenCalledTimes(1)

    // Sidebar toggle and the view icons also live here; Open Folder is gone
    expect(screen.getByRole("button", { name: /Sidebar/i })).toBeDefined()
    expect(screen.queryByRole("button", { name: /Open Folder/i })).toBeNull()
    expect(screen.getByRole("button", { name: "Git" })).toBeDefined()
  })

  it("keeps only the aux panel toggle on RightEdgeChrome", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RightEdgeChrome />
      </NextIntlClientProvider>
    )

    expect(
      screen.getByRole("button", { name: /Toggle Auxiliary Panel/i })
    ).toBeDefined()
    expect(screen.queryByRole("button", { name: /New Terminal/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /Settings/i })).toBeNull()
  })
})
