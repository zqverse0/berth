import { describe, expect, it } from "vitest"
import {
  parseWorkspaceTabPlacementState,
  serializeWorkspaceTabPlacementState,
  workspacePlacementScope,
  type WorkspaceTabPlacementByScope,
} from "@/lib/workspace/workspace-tab-placement-persistence"

describe("workspace tab placement persistence", () => {
  it("isolates placement by folder scope", () => {
    const state: WorkspaceTabPlacementByScope = {
      [workspacePlacementScope(1)]: {
        "primary:conversation-a": "conversation" as const,
      },
      [workspacePlacementScope(2)]: {
        "file:/repo-b/readme.md": "conversation" as const,
      },
    }

    expect(
      parseWorkspaceTabPlacementState(
        serializeWorkspaceTabPlacementState(state)
      )
    ).toEqual(state)
  })

  it("uses an explicit global scope", () => {
    expect(workspacePlacementScope(null)).toBe("global")
    expect(workspacePlacementScope(7)).toBe("folder:7")
  })

  it("rejects corrupt documents and filters malformed entries", () => {
    expect(parseWorkspaceTabPlacementState("{")).toEqual({})
    expect(
      parseWorkspaceTabPlacementState(
        JSON.stringify({
          version: 1,
          scopes: {
            "folder:1": {
              "primary:valid": "files",
              invalid: "files",
              "file:bad-pane": "middle",
            },
            broken: [],
          },
        })
      )
    ).toEqual({ "folder:1": { "primary:valid": "files" } })
  })
})
