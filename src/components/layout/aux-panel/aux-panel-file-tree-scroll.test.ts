import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/layout/aux-panel/aux-panel-file-tree-tab.tsx"
  ),
  "utf8"
)
const sidebarSource = readFileSync(
  resolve(process.cwd(), "src/components/layout/sidebar/sidebar.tsx"),
  "utf8"
)

describe("project sidebar file tree scrolling", () => {
  it("gives the project explorer a bounded flex parent", () => {
    expect(sidebarSource).toContain(
      '"flex min-h-0 flex-1 flex-col overflow-hidden"'
    )
  })

  it("keeps a bounded vertical scroll viewport", () => {
    expect(source).toContain(
      'className="flex h-full min-h-0 flex-col overflow-hidden"'
    )
    expect(source).toContain('y="scroll"')
    expect(source).toContain("h-full min-h-0 flex-1 overflow-hidden pb-1")
  })
})
