import { describe, expect, it } from "vitest"
import type { TabItem } from "@/stores/tab-store"
import {
  projectReferencePath,
  quotePathForShell,
  resolveEditorReferenceTarget,
  sanitizeTerminalPaste,
  serializeAgentReference,
  type EditorReference,
} from "./content-reference"

const reference: EditorReference = {
  absolutePath: "/work/project/src/a file.ts",
  workspacePath: "src/a file.ts",
  fileName: "a file.ts",
  sourceBackendInstanceId: "backend-a",
  sourceFolderId: 1,
}

const tabs: TabItem[] = [
  {
    kind: "conversation",
    id: "conversation",
    folderId: 1,
    conversationId: 2,
    agentType: "codex",
    title: "Chat",
    isPinned: false,
  },
  {
    kind: "terminal",
    id: "agent",
    terminalId: "t-agent",
    backendInstanceId: "backend-a",
    folderId: 1,
    agentType: "codex",
    title: "Codex",
    initialCwd: "/work/project",
    shell: "/bin/bash",
    detachedFolderLabel: null,
    detachedFolderPath: null,
    isPinned: false,
  },
  {
    kind: "terminal",
    id: "shell",
    terminalId: "t-shell",
    backendInstanceId: "backend-a",
    folderId: null,
    title: "Terminal",
    initialCwd: "/work/project",
    lastKnownCwd: "/work/project/src",
    shell: "pwsh.exe",
    detachedFolderLabel: null,
    detachedFolderPath: null,
    isPinned: false,
  },
]

describe("editor reference domain", () => {
  it("resolves conversation, agent terminal, shell terminal, and missing targets", () => {
    expect(resolveEditorReferenceTarget("conversation", tabs)).toEqual({
      kind: "conversation",
      tabId: "conversation",
    })
    expect(resolveEditorReferenceTarget("agent", tabs)).toMatchObject({
      kind: "agent-terminal",
      terminalId: "t-agent",
      agentType: "codex",
    })
    expect(resolveEditorReferenceTarget("shell", tabs)).toMatchObject({
      kind: "shell-terminal",
      terminalId: "t-shell",
      cwd: "/work/project/src",
    })
    expect(resolveEditorReferenceTarget("gone", tabs)).toBeNull()
  })

  it("projects workspace paths only across the same backend", () => {
    const target = resolveEditorReferenceTarget("agent", tabs)
    expect(target?.kind).toBe("agent-terminal")
    if (!target || target.kind !== "agent-terminal") return
    expect(projectReferencePath(reference, target)).toEqual({
      kind: "reachable",
      path: "src/a file.ts",
      absolute: false,
    })
    expect(
      projectReferencePath(
        { ...reference, sourceBackendInstanceId: "backend-b" },
        target
      )
    ).toEqual({ kind: "unreachable", reason: "backend-mismatch" })
  })

  it("serializes locale-owned agent text without selected source", () => {
    const text = serializeAgentReference(
      "src/`secret`.ts",
      { start: 10, end: 25 },
      (_key, values) =>
        `Inspect \`${values.path}\` lines ${values.start}-${values.end}`
    )
    expect(text).toBe("Inspect `src/\\`secret\\`.ts` lines 10-25")
    expect(text).not.toContain("selectedText")
  })

  it("quotes known shells and falls back to copy for unknown shells", () => {
    expect(quotePathForShell("/bin/bash", "a '$()` b")).toEqual({
      kind: "insert",
      text: "'a '\\''$()` b'",
    })
    expect(quotePathForShell("pwsh.exe", "C:/a'b")).toEqual({
      kind: "insert",
      text: "'C:/a''b'",
    })
    expect(quotePathForShell("mystery", "a b")).toEqual({
      kind: "copy-only",
      text: "a b",
    })
  })

  it("normalizes newlines and removes unsafe controls", () => {
    expect(sanitizeTerminalPaste("a\r\nb\u0000\u001bc\t")).toBe("a\nbc\t")
  })
})
