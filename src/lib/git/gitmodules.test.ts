import { describe, expect, it } from "vitest"
import { parseGitmodulePaths } from "@/lib/git/gitmodules"

describe("parseGitmodulePaths", () => {
  it("reads only paths from submodule sections", () => {
    const content = `
[core]
  path = ignored
[submodule "packages/plugin"]
  path = packages/plugin
  url = https://example.com/plugin.git
[submodule "vendor runtime"]
  path = "vendor/runtime"
`
    expect([...parseGitmodulePaths(content)]).toEqual([
      "packages/plugin",
      "vendor/runtime",
    ])
  })

  it("normalizes separators and rejects paths outside the project", () => {
    const content = `
[submodule "safe"]
  path = .\\packages\\safe\\
[submodule "outside"]
  path = ../outside
`
    expect([...parseGitmodulePaths(content)]).toEqual(["packages/safe"])
  })
})
