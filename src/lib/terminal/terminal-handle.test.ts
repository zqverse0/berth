import { describe, expect, it, vi } from "vitest"
import { fetchTerminalHandle } from "@/lib/terminal/terminal-handle"

const ref = (json: string) => `v1.${btoa(json)}`
const sessions: Record<string, { folderId?: number; targetRef?: string }> = {
  a: { folderId: 1, targetRef: ref('{"pane_id":8}') },
  b: { folderId: 99, targetRef: ref('{"pane_id":3}') },
  c: { targetRef: "opaque" },
}

vi.mock("@/lib/api", () => ({
  getTerminalSession: async (id: string) => sessions[id],
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: {
    getState: () => ({
      allFolders: [{ id: 1, name: "berth-dev", alias: "Berth" }],
    }),
  },
}))

describe("fetchTerminalHandle", () => {
  it("uses the project dir name (not alias) and pane number like `terminal ls`", async () => {
    expect(await fetchTerminalHandle("a")).toBe("berth-dev:8")
  })
  it("falls back to the bare number, then the raw target ref", async () => {
    expect(await fetchTerminalHandle("b")).toBe("3")
    expect(await fetchTerminalHandle("c")).toBe("opaque")
  })
})
