import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/layout/status-bar/active-path-status", () => ({
  ActivePathStatus: () => <div data-testid="active-path-status" />,
}))

import { StatusBarContext } from "@/components/layout/status-bar/status-bar-context"

describe("StatusBarContext", () => {
  it("delegates the left edge to the single active-path module", () => {
    render(<StatusBarContext />)
    expect(screen.getByTestId("active-path-status")).toBeTruthy()
  })
})
