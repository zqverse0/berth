import { fireEvent, render, screen } from "@testing-library/react"
import { Plus } from "lucide-react"
import { describe, expect, it, vi } from "vitest"
import {
  SidebarHeader,
  SidebarHeaderActions,
  SidebarHeaderButton,
  SidebarHeaderTabs,
} from "@/components/layout/sidebar/sidebar-header"

describe("SidebarHeader", () => {
  it("shows the title until a view supplies tabs, then swaps to the tabs", () => {
    const onChange = vi.fn()
    const view = (
      <>
        <SidebarHeader title="Tasks" />
        <SidebarHeaderTabs
          value="a"
          onChange={onChange}
          tabs={[
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
          ]}
        />
      </>
    )
    const { rerender } = render(<SidebarHeader title="Tasks" />)
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy()

    rerender(view)
    expect(screen.queryByRole("heading")).toBeNull()
    expect(screen.getByRole("tab", { name: "Alpha" }).ariaSelected).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: "Beta" }))
    expect(onChange).toHaveBeenCalledWith("b")

    rerender(<SidebarHeader title="Tasks" />)
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy()
  })

  it("renders view actions into the header", () => {
    const onClick = vi.fn()
    render(
      <>
        <SidebarHeader title="Memory" />
        <SidebarHeaderActions>
          <SidebarHeaderButton icon={Plus} label="New" onClick={onClick} />
        </SidebarHeaderActions>
      </>
    )
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
