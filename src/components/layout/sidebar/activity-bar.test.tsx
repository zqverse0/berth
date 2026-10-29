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
  it("expands settings pages above the gear and leaves settings from the gear or another view", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActivityBar />
        <Selected />
      </NextIntlClientProvider>
    )
    const gear = screen.getByRole("button", { name: "Open Settings" })
    expect(screen.queryByRole("button", { name: "Experts" })).toBeNull()

    await user.click(gear)
    expect(settingsOpen()).toBe(true)
    expect(useSidebarViewStore.getState().view).toBe("settings")
    await user.click(screen.getByRole("button", { name: "Experts" }))
    expect(screen.getByRole("status").textContent).toBe("experts")

    await user.click(gear)
    expect(settingsOpen()).toBe(false)
    expect(useSidebarViewStore.getState().view).toBe("projects")
    expect(screen.queryByRole("button", { name: "Experts" })).toBeNull()

    await user.click(gear)
    await user.click(screen.getByRole("button", { name: "Git" }))
    expect(settingsOpen()).toBe(false)
    expect(useSidebarViewStore.getState().view).toBe("git")
  })
})
