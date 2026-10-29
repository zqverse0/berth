import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const controllerSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/layout/commands/command-controller.tsx"
  ),
  "utf8"
)

const tabBarSource = readFileSync(
  resolve(process.cwd(), "src/components/tabs/tab-bar.tsx"),
  "utf8"
)

const fileTabBarSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-tab-bar.tsx"),
  "utf8"
)

describe("workspace commands live behind the unified command palette", () => {
  it("uses one capture listener and routes tab actions through the controller", () => {
    expect(controllerSource).toContain('event.code === "Space"')
    expect(controllerSource).toContain(
      'document.addEventListener("keydown", handleKeyDown, true)'
    )
    expect(controllerSource).toMatch(/paletteOpen/)
    expect(controllerSource).toMatch(/const run = useCallback/)
    expect(controllerSource).toMatch(/selectWorkspaceTab\(/)
    expect(controllerSource).toMatch(/closeTab\(/)
    expect(controllerSource).toMatch(/closeFileTab\(/)
    expect(controllerSource).toMatch(/closeAllFileTabs/)
    expect(controllerSource).not.toContain("matchShortcutEvent")
    expect(controllerSource).not.toContain("isTerminalReservedCtrlEvent")
  })

  it("keeps global keydown listeners out of both tab strips", () => {
    expect(tabBarSource).not.toContain('addEventListener("keydown"')
    expect(tabBarSource).not.toContain("matchShortcutEvent")
    expect(fileTabBarSource).not.toContain('addEventListener("keydown"')
    expect(fileTabBarSource).not.toContain("matchShortcutEvent")
  })

  it("routes the open-folder shortcut through the native folder picker", () => {
    expect(controllerSource).toContain("useOpenFolderPicker")
    expect(controllerSource).toContain("void openFolderPicker()")
    expect(controllerSource).not.toContain("useProjectBootWorkspace")
  })

  it("opens project surfaces as sidebar views, not aux-panel tabs", () => {
    expect(controllerSource).toContain('openView("tasks")')
    expect(controllerSource).toContain('openView("git")')
    expect(controllerSource).toContain(
      "useSidebarViewStore.getState().setView(view)"
    )
  })
})
