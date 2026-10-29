import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { WorkspaceCommandPalette } from "@/components/layout/commands/command-palette"

function renderPalette(
  actions: Parameters<typeof WorkspaceCommandPalette>[0]["actions"],
  onOpenChange = vi.fn()
) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkspaceCommandPalette
        open
        onOpenChange={onOpenChange}
        actions={actions}
      />
    </NextIntlClientProvider>
  )
  return screen.getByPlaceholderText(/type \? to search/i)
}

describe("WorkspaceCommandPalette", () => {
  afterEach(() => {
    cleanup()
  })

  it("searches after a ? prefix and runs the selected action", async () => {
    const user = userEvent.setup()
    const openTasks = vi.fn()
    const openSettings = vi.fn()
    const input = renderPalette([
      { id: "open_berth_tasks", run: openTasks },
      { id: "open_settings", run: openSettings },
    ])

    await user.type(input, "?tasks")
    expect(screen.getByText("Open Berth Tasks")).toBeTruthy()
    expect(screen.queryByText("Open settings")).toBeNull()
    await user.click(screen.getByText("Open Berth Tasks"))
    expect(openTasks).toHaveBeenCalledTimes(1)
    expect(openSettings).not.toHaveBeenCalled()
  })

  it("runs the command bound to a leader key", async () => {
    const user = userEvent.setup()
    const toggleSidebar = vi.fn()
    const onOpenChange = vi.fn()
    const input = renderPalette(
      [
        { id: "toggle_sidebar", run: toggleSidebar },
        { id: "open_settings", run: vi.fn() },
      ],
      onOpenChange
    )

    await user.type(input, "b")
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows the fixed key badge", () => {
    renderPalette([{ id: "toggle_sidebar", run: vi.fn() }])
    expect(screen.getByText("b")).toBeTruthy()
  })
})
