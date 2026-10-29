import { describe, expect, it } from "vitest"
import {
  classifyGitFileState,
  getDirectoryGitDecoration,
  getGitFileDecoration,
} from "@/components/layout/file-tree/git-file-state"

describe("git file decorations", () => {
  it.each([
    ["??", "untracked", "U", "emerald"],
    ["M", "modified", "M", "amber"],
    ["A", "staged", "A", "emerald"],
    ["D", "deleted", "D", "red"],
    ["R", "renamed", "R", "blue"],
    ["UU", "conflicted", "!", "violet"],
  ])("maps %s to a VS Code-style decoration", (status, state, badge, color) => {
    expect(classifyGitFileState(status)).toBe(state)
    expect(getGitFileDecoration(status)).toEqual(
      expect.objectContaining({ badge })
    )
    expect(getGitFileDecoration(status)?.className).toContain(color)
  })

  it("surfaces a deleted descendant on its parent directory", () => {
    expect(getDirectoryGitDecoration(["??", "M", "D"])?.badge).toBe("D")
  })
})
