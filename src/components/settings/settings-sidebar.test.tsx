import { act, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeAll, describe, expect, it } from "vitest"
import en from "@/i18n/messages/en.json"
import { useGeneralSectionShown } from "@/components/settings/settings-nav"
import { SettingsSidebar } from "@/components/settings/settings-sidebar"
import { SettingsSplit } from "@/components/settings/settings-split"
import { useOpenWorkbenchPanel } from "@/hooks/workspace/use-open-workbench-panel"
import { useWorkbenchLayout } from "@/hooks/workspace/use-workbench-layout"

function Page() {
  return <SettingsSplit list={<p>the list</p>}>the detail</SettingsSplit>
}

/** 模拟「高级」页：只显示侧栏选中的分节。 */
function Advanced() {
  const shown = useGeneralSectionShown("advanced")
  return (
    <>
      {shown("version") && <p>version section</p>}
      {shown("proxy") && <p>proxy section</p>}
    </>
  )
}

function Selected() {
  return <output>{useWorkbenchLayout().selected.settings}</output>
}

/** 选中设置页（与活动栏、命令面板同一入口；选中状态是进程内共享的）。 */
function open(page: "tools" | "appearance") {
  const { openSettings } = renderHook(() => useOpenWorkbenchPanel()).result
    .current
  act(() => openSettings(page))
}

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  )

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})

describe("SettingsSidebar", () => {
  it("keeps the list inside the page when the sidebar has no settings view", () => {
    const { container } = wrap(<Page />)
    expect(container.querySelector("aside")?.textContent).toBe("the list")
  })

  it("moves the page list into the sidebar, leaving only the detail", () => {
    const { container } = wrap(
      <>
        <SettingsSidebar open />
        <Page />
      </>
    )
    open("tools")

    expect(container.querySelector("[data-settings-list]")?.textContent).toBe(
      "the list"
    )
    expect(container.querySelector("aside")).toBeNull()
    expect(screen.getByText("the detail")).toBeDefined()
  })

  it("lists general sections and shows only the picked one", async () => {
    const user = userEvent.setup()
    wrap(
      <>
        <SettingsSidebar open />
        <Advanced />
        <Selected />
      </>
    )
    open("appearance")
    expect(screen.getByRole("button", { name: "Theme" })).toBeDefined()

    await user.click(screen.getByRole("button", { name: "Network proxy" }))
    expect(screen.getByRole("status").textContent).toBe("advanced")
    expect(screen.getByText("proxy section")).toBeDefined()
    expect(screen.queryByText("version section")).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Network proxy" })
        .getAttribute("aria-current")
    ).toBe("page")
  })
})
