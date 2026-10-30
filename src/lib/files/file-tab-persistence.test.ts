import { describe, expect, it } from "vitest"
import {
  parseFileReaderState,
  serializeFileReaderState,
} from "@/lib/files/file-tab-persistence"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"

function textTab(path: string): FileWorkspaceTab {
  return {
    id: `file:${path}`,
    kind: "file",
    dataMode: "text",
    previewKind: "text",
    folderId: 7,
    title: "app.ts",
    description: path,
    path,
    language: "typescript",
    content: "large content is not persisted",
    savedContent: "large content is not persisted",
    isDirty: false,
    etag: "etag",
    mtimeMs: 1,
    readonly: false,
    lineEnding: "lf",
    loading: false,
    saveState: "idle",
    saveError: null,
  }
}

describe("file reader persistence", () => {
  it("stores only restorable metadata, not file content", () => {
    const state = serializeFileReaderState(
      [
        textTab("/repo/src/app.ts"),
        {
          id: "transcript:42",
          kind: "transcript",
          conversationId: 42,
          agentType: "codex",
          folderId: 7,
          title: "Review",
          description: "Review",
          path: null,
          loading: false,
          readonly: true,
          saveState: "idle",
          saveError: null,
        },
      ],
      "file:/repo/src/app.ts"
    )

    expect(state).toEqual({
      version: 2,
      activeTabIdByFolder: {},
      tabs: [
        {
          kind: "file",
          path: "/repo/src/app.ts",
          folderId: 7,
          readonly: false,
        },
        {
          kind: "transcript",
          conversationId: 42,
          agentType: "codex",
          title: "Review",
          folderId: 7,
        },
      ],
      activeTabId: "file:/repo/src/app.ts",
    })
    expect(JSON.stringify(state)).not.toContain("large content")
  })

  it("round-trips the project a file tab was opened in", () => {
    const tab = { ...textTab("/other/a.ts"), openedInFolderId: 3 }
    const state = serializeFileReaderState([tab], null)
    expect(state.tabs[0]).toMatchObject({ openedInFolderId: 3 })
    expect(parseFileReaderState(JSON.stringify(state)).tabs[0]).toMatchObject({
      openedInFolderId: 3,
    })
  })

  it("drops virtual and malformed tabs while parsing", () => {
    const state = parseFileReaderState(
      JSON.stringify({
        version: 1,
        activeTabId: 42,
        tabs: [
          {
            kind: "file",
            path: "/__berth_preview__/generated/readme.md",
            folderId: 7,
          },
          { kind: "file", path: "/repo/README.md", folderId: 7 },
          { kind: "web", url: 12, title: "bad", folderId: 7 },
          {
            kind: "web",
            url: "https://example.com",
            title: "legacy web reader tab",
            folderId: 7,
          },
        ],
      })
    )

    expect(state).toEqual({
      version: 2,
      activeTabIdByFolder: {},
      tabs: [
        {
          kind: "file",
          path: "/repo/README.md",
          folderId: 7,
          readonly: false,
        },
      ],
      activeTabId: null,
    })
  })

  it("falls back safely for corrupt storage", () => {
    expect(parseFileReaderState("not-json")).toEqual({
      version: 2,
      tabs: [],
      activeTabId: null,
      activeTabIdByFolder: {},
    })
  })

  it("restores a Berth session tab", () => {
    const state = serializeFileReaderState(
      [
        {
          id: "berth-session:7:20261030-090000",
          kind: "berth-session",
          folderId: 7,
          session: "20261030-090000",
          title: "Berth · what changed?",
          description: "20261030-090000",
          path: null,
          loading: false,
          readonly: true,
          saveState: "idle",
          saveError: null,
        },
      ],
      null
    )
    expect(parseFileReaderState(JSON.stringify(state)).tabs).toEqual([
      {
        kind: "berth-session",
        session: "20261030-090000",
        title: "Berth · what changed?",
        folderId: 7,
      },
    ])
  })
})
