import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { WorkspaceSwitcher } from "./workspace-group-header"

const group = (id: string, name: string) => ({
  id,
  name,
  emoji: null,
  isDefault: false,
})

describe("WorkspaceSwitcher", () => {
  it("names the current workspace and switches or creates from the menu", async () => {
    const user = userEvent.setup()
    const onSwitch = vi.fn()
    const onCreate = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <WorkspaceSwitcher
          items={[
            { group: group("dev", "Dev"), current: true, summary: "1 running" },
            {
              group: group("lab", "Lab"),
              current: false,
              summary: "2 projects",
            },
          ]}
          onSwitch={onSwitch}
          onCreate={onCreate}
        />
      </NextIntlClientProvider>
    )
    const trigger = screen.getByRole("button", {
      name: en.WorkspaceGroups.workspaceMenu,
    })
    expect(trigger.textContent).toContain("Dev")

    await user.click(trigger)
    const lab = screen.getByRole("menuitem", { name: /Lab/ })
    expect(lab.textContent).toContain("2 projects")
    await user.click(lab)
    expect(onSwitch).toHaveBeenCalledWith("lab")

    await user.click(trigger)
    await user.click(
      screen.getByRole("menuitem", { name: en.WorkspaceGroups.create })
    )
    expect(onCreate).toHaveBeenCalled()
  })
})
