import { render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  resolveTerminalBackgroundOverlayOpacity,
  TerminalBackgroundOverlay,
} from "./terminal-background-overlay"

const workspaceBackground = vi.hoisted(() => ({
  workspaceBgEnabled: false,
  workspaceBgImageUrl: null as string | null,
  workspaceBgMaskOpacity: 0.82,
  workspaceBgImageBlur: 0,
  workspaceBgFillMode: "cover" as const,
}))

vi.mock("@/hooks/use-appearance", () => ({
  useWorkspaceBackground: () => workspaceBackground,
}))

describe("TerminalBackgroundOverlay", () => {
  beforeEach(() => {
    workspaceBackground.workspaceBgEnabled = false
    workspaceBackground.workspaceBgImageUrl = null
    workspaceBackground.workspaceBgMaskOpacity = 0.82
    workspaceBackground.workspaceBgImageBlur = 0
    workspaceBackground.workspaceBgFillMode = "cover"
  })

  it("renders nothing while the workspace background is disabled", () => {
    const { container } = render(<TerminalBackgroundOverlay visible />)

    expect(container).toBeEmptyDOMElement()
  })

  it("renders a non-interactive, viewport-aligned overlay", () => {
    workspaceBackground.workspaceBgEnabled = true
    workspaceBackground.workspaceBgImageUrl =
      "https://example.com/workspace-background.png"
    workspaceBackground.workspaceBgMaskOpacity = 0.7
    workspaceBackground.workspaceBgImageBlur = 6

    const { container } = render(<TerminalBackgroundOverlay visible />)
    const overlay = container.querySelector(
      "[data-terminal-background-overlay]"
    )
    const image = overlay?.firstElementChild

    expect(overlay).toHaveClass("pointer-events-none", "select-none")
    expect(overlay).toHaveStyle({ opacity: "0.3" })
    expect(image).toHaveStyle({
      inset: "-6px",
      backgroundAttachment: "fixed",
      backgroundImage: 'url("https://example.com/workspace-background.png")',
      backgroundSize: "cover",
      backgroundRepeat: "no-repeat",
      filter: "blur(6px)",
    })
  })

  it("does not retain an image layer for hidden terminal surfaces", () => {
    workspaceBackground.workspaceBgEnabled = true
    workspaceBackground.workspaceBgImageUrl =
      "https://example.com/workspace-background.png"

    const { container } = render(<TerminalBackgroundOverlay visible={false} />)

    expect(container).toBeEmptyDOMElement()
  })

  it("caps image strength and clamps fully masked backgrounds", () => {
    expect(resolveTerminalBackgroundOverlayOpacity(0)).toBe(0.45)
    expect(resolveTerminalBackgroundOverlayOpacity(0.82)).toBeCloseTo(0.18)
    expect(resolveTerminalBackgroundOverlayOpacity(1)).toBe(0)
  })
})
