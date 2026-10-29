import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8")

const activePath = read(
  "src/components/layout/status-bar/active-path-status.tsx"
)
const statusContext = read(
  "src/components/layout/status-bar/status-bar-context.tsx"
)
const fileHeader = read("src/components/files/file-workspace-header.tsx")
const projectList = read(
  "src/components/conversations/sidebar/sidebar-project-list.tsx"
)

describe("unified active path placement", () => {
  it("has one status-bar owner for every workspace path source", () => {
    expect(statusContext).toContain("<ActivePathStatus")
    expect(activePath).toContain("activeWorkspaceTab")
    expect(activePath).toContain("lastKnownCwd")
    expect(activePath).toContain("initialCwd")
    expect(activePath).toContain("isConversationTab")
    expect(activePath).toContain("isTerminalTab")
    expect(activePath).toContain("getRelativeOrCleanPath")
  })

  it("removes duplicate path controls from content headers", () => {
    expect(fileHeader).not.toContain("FilePathBreadcrumb")
    expect(activePath).not.toContain("FilePathBreadcrumb")
  })

  it("does not repeat paths in the project switch bar", () => {
    expect(projectList).not.toContain("activeFolder.path")
  })
})
