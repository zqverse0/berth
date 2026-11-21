import { describe, expect, it } from "vitest"
import {
  WORKSPACE_TAB_REGISTRY,
  workspaceTabDefinition,
  type WorkspaceTabType,
} from "@/lib/workspace/workspace-tab-registry"

const readerTypes: WorkspaceTabType[] = [
  "file",
  "diff",
  "rich-diff",
  "transcript",
  "task",
  "berth-session",
  "conversation",
  "global",
]

const sessionTypes: WorkspaceTabType[] = ["terminal"]

describe("workspace tab registry", () => {
  it("keeps every registered reader and global surface in the main workspace by default", () => {
    for (const type of readerTypes) {
      expect(workspaceTabDefinition(type).defaultPane).toBe("files")
    }
  })

  it("keeps terminal surfaces on the right by default", () => {
    for (const type of sessionTypes) {
      expect(workspaceTabDefinition(type).defaultPane).toBe("conversation")
    }
  })

  it("is exhaustive for the current workspace tab kinds", () => {
    expect(Object.keys(WORKSPACE_TAB_REGISTRY).sort()).toEqual(
      [...readerTypes, ...sessionTypes].sort()
    )
  })

  it("pins global surfaces before regular tabs", () => {
    expect(workspaceTabDefinition("global").section).toBe("global")
    expect(workspaceTabDefinition("terminal").section).toBe("regular")
  })
})
