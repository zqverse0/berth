import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

describe("Git clone migration", () => {
  it("removes clone from the inline Git operation surface", () => {
    const branchSource = read("src/components/layout/git/branch-dropdown.tsx")
    const selectorSource = read(
      "src/components/layout/git/branch-selector-list.tsx"
    )
    const auxSource = read(
      "src/components/layout/aux-panel/aux-panel-git-tab.tsx"
    )
    const viewSource = read("src/components/layout/git/git-panel-view.ts")

    expect(branchSource).not.toContain('id: "clone"')
    expect(selectorSource).not.toContain("clone: GitFork")
    expect(branchSource).not.toContain('openInlineView("clone")')
    expect(auxSource).not.toContain('case "clone"')
    expect(auxSource).not.toContain("CloneRepositoryForm")
    expect(viewSource).not.toContain('  | "clone"')
  })
})
