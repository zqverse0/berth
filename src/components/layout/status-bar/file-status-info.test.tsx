import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { EditorSelection, EditorState } from "@codemirror/state"
import { FileStatusInfo } from "@/components/layout/status-bar/file-status-info"
import {
  editorDocumentRegistry,
  type EditorDocumentRuntime,
} from "@/lib/editor/document-registry"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const tab = {
  id: "t1",
  isDirty: true,
  saveState: "idle",
  saveError: null,
  readonly: false,
  language: "typescript",
  lineEnding: "crlf",
} as TextFileWorkspaceTab

describe("FileStatusInfo", () => {
  it("shows save state, live cursor, language and line ending", () => {
    const state = EditorState.create({ doc: "ab\ncdef" })
    editorDocumentRegistry.set({
      id: "file-tab:t1",
      state,
    } as unknown as EditorDocumentRuntime)

    render(<FileStatusInfo tab={tab} />)
    expect(screen.getByText("unsaved")).toBeTruthy()
    expect(screen.getByText("typescript")).toBeTruthy()
    expect(screen.getByText("CRLF")).toBeTruthy()
    expect(screen.getByText('cursor:{"line":1,"col":1}')).toBeTruthy()

    // 第 2 行选中 "cd"，光标（head）在列 3
    act(() =>
      editorDocumentRegistry.updateState(
        "file-tab:t1",
        state.update({ selection: EditorSelection.single(3, 5) }).state
      )
    )
    expect(
      screen.getByText('cursor:{"line":2,"col":3} selected:{"count":2}')
    ).toBeTruthy()
  })
})
