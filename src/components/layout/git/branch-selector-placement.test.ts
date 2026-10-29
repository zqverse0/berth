import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8")

const statusBarSource = read("src/components/layout/status-bar/status-bar.tsx")
const rightEdgeSource = read(
  "src/components/layout/chrome/right-edge-chrome.tsx"
)
const auxPanelSource = read("src/components/layout/aux-panel/aux-panel.tsx")
const sidebarSource = read("src/components/layout/sidebar/sidebar.tsx")
const activityBarSource = read("src/components/layout/sidebar/activity-bar.tsx")
const folderTitleBarSource = read(
  "src/components/layout/chrome/folder-title-bar.tsx"
)
const branchDropdownSource = read(
  "src/components/layout/git/branch-dropdown.tsx"
)

// The rich git BranchDropdown lives in the below-composer folder/branch row;
// the unified workspace Git body lives in the sidebar git view.
describe("branch selector placement", () => {
  it("hosts the workspace git surface on the sidebar panel", () => {
    expect(rightEdgeSource).not.toContain("WorkspaceGit")
    expect(activityBarSource).not.toContain("data-sidebar-git-toggle")
    expect(activityBarSource).not.toContain("GitBranch")
    expect(folderTitleBarSource).not.toContain("data-sidebar-git-toggle")
    expect(folderTitleBarSource).not.toContain("GitBranch")
    expect(sidebarSource).toContain('currentView === "git"')
    expect(auxPanelSource).not.toContain('currentView === "git"')
  })

  it("keeps status controls on the bottom without session statistics", () => {
    expect(statusBarSource).toContain("StatusBarAlerts")
    expect(sidebarSource).not.toContain("StatusBarAlerts")
    expect(statusBarSource).not.toContain("StatusBarStats")
  })

  it("retires the basic BranchPicker and the status-bar variant", () => {
    // BranchDropdown now renders a single composer-chip trigger — the
    // status-bar `showFolderName` split/pill variant is removed.
    expect(branchDropdownSource).not.toContain("showFolderName")
    expect(branchDropdownSource).not.toContain("isStatusBar")
  })
})
