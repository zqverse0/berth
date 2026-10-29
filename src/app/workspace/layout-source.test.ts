import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  resolve(process.cwd(), "src/app/workspace/layout.tsx"),
  "utf8"
)

describe("workspace three-column layout ownership", () => {
  it("places the file workspace in the main center pane and aux panel on the right", () => {
    const mainPane = source.indexOf("id={FOLDER_SHELL_MAIN_PANEL_ID}")
    const rightPane = source.indexOf("id={FOLDER_SHELL_RIGHT_PANEL_ID}")

    expect(mainPane).toBeGreaterThan(-1)
    expect(rightPane).toBeGreaterThan(mainPane)
    expect(source.slice(mainPane, rightPane)).toContain("order={2}")
    expect(source.slice(rightPane)).toContain("order={3}")
  })

  it("renders each tab group's content by placement, not by tab kind", () => {
    expect(source).toContain("<FileWorkspaceTabBar />")
    expect(source).toContain('<WorkspacePaneContent pane="files"')
    expect(source).not.toContain('id="workspace-panel-group"')
    expect(source).not.toContain("workspacePaneGroupLayout(")
  })

  it("keeps the desktop auxiliary content mounted during panel collapse", () => {
    const auxSource = readFileSync(
      resolve(process.cwd(), "src/components/layout/aux-panel/aux-panel.tsx"),
      "utf8"
    )

    expect(source).toContain("<AuxPanel present={auxOpen || auxAnimating} />")
    expect(auxSource).toContain("if (!mounted) return null")
    expect(auxSource).toContain("<TabBar />")
    expect(auxSource).toContain('<WorkspacePaneContent pane="conversation" />')
  })

  it("keeps project-owned surfaces out of the right auxiliary panel", () => {
    const auxSource = readFileSync(
      resolve(process.cwd(), "src/components/layout/aux-panel/aux-panel.tsx"),
      "utf8"
    )

    expect(auxSource).not.toContain("<ProjectSessionManager")
    expect(auxSource).not.toContain("<FileTreeTab")
  })
})
