import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"
import en from "@/i18n/messages/en.json"
import { ActivityBar } from "@/components/layout/sidebar/activity-bar"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"
import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"

function Selected() {
  return <output>{useWorkbenchLayout().selected.settings}</output>
}

const settingsOpen = () =>
  useWorkspaceLayoutStore
    .getState()
    .globalTabs.some((tab) => tab.id === "settings")

describe("ActivityBar settings mode", () => {
  it("keeps settings pages under the views, opens General from the gear and leaves from the current page", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActivityBar />
        <Selected />
      </NextIntlClientProvider>
    )
    const gear = screen.getByRole("button", { name: "Open Settings" })
    const experts = screen.getByRole("button", { name: "Experts" })
    expect(screen.queryByRole("button", { name: "General" })).toBeNull()

    await user.click(experts)
    expect(settingsOpen()).toBe(true)
    expect(useSidebarViewStore.getState().view).toBe("settings")
    expect(screen.getByRole("status").textContent).toBe("experts")
    expect(experts.getAttribute("aria-pressed")).toBe("true")

    await user.click(gear)
    expect(screen.getByRole("status").textContent).toBe("appearance")
    expect(gear.getAttribute("aria-pressed")).toBe("true")
    expect(experts.getAttribute("aria-pressed")).toBe("false")

    await user.click(gear)
    expect(settingsOpen()).toBe(false)
    expect(useSidebarViewStore.getState().view).toBe("projects")

    await user.click(experts)
    await user.click(experts)
    expect(settingsOpen()).toBe(false)

    await user.click(gear)
    await user.click(screen.getByRole("button", { name: "Git" }))
    expect(settingsOpen()).toBe(false)
    expect(useSidebarViewStore.getState().view).toBe("git")
  })
})
